import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import fuzzysort from 'fuzzysort';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { directoryOf, fileKey, type FileClick, type HistoryEntry, type SearchHit } from '../shared';
import { serviceFor, type FileSymbol, type LanguageServices } from './lsp';
import { Glass } from './chrome';

const rowLimit = 200;
// Contiguous matches typically score above .7 and scattered letters around .3.
const matchThreshold = 0.6;

type SearchMode = 'files' | 'grep' | 'symbols';
const emptyMessage: Record<SearchMode, string> = {
  files: '没有匹配的文件', grep: '没有匹配的内容', symbols: '没有匹配的符号',
};

type SearchRow = { key: string; title: string; detail?: string; depth?: number; target: Pick<FileClick, 'path' | 'line' | 'column'>; marks?: ReadonlyArray<number> };
type SearchResults<T> = { scope: string; rows: T[] };
export const searchLocationKey = (file: FileClick) => JSON.stringify([fileKey(file), file.line, file.column]);

// Flags after a standalone -- go to rg.
const rgQuery = (query: string) => {
  const split = /(?:^|\s)--(?:\s|$)/.exec(query);
  if (!split) return { flags: [], needle: query.trim() };
  const flags: string[] = [];
  const args = query.slice(split.index + split[0].length);
  let word = '', quote = '', started = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (!quote && /\s/.test(ch)) {
      if (started) flags.push(word);
      word = ''; started = false;
      continue;
    }
    started = true;
    if (quote && ch === quote) quote = '';
    else if (!quote && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === '\\' && quote !== "'" && /[\s"'\\]/.test(args[i + 1] ?? '')) word += args[++i];
    else word += ch;
  }
  if (started) flags.push(word);
  return { flags, needle: query.slice(0, split.index).trim() };
};

export function Search({ context, services, visited, workspace, visitedReady, peek, navigate, close }: { context: UiContext; services?: LanguageServices; visited: HistoryEntry; workspace?: FileClick; visitedReady: boolean; peek: (file: FileClick) => void; navigate: (file: FileClick) => void; close: () => void }) {
  const [query, setQuery] = useState('');
  // Opening the picker must keep the current file visible until a row is selected.
  const [chosen, setChosen] = useState<string>();
  // Keep the previous results visible while the next response is pending.
  const [listing, setListing] = useState<SearchResults<string>>();
  const [grep, setGrep] = useState<SearchResults<SearchHit>>();
  const [symbols, setSymbols] = useState<FileSymbol[]>();
  // A late response can belong to a search mode the user has already left.
  const [status, setStatus] = useState<{ mode: SearchMode; text: string }>();
  const clearStatus = (source: SearchMode) => setStatus((current) => (current?.mode === source ? undefined : current));
  const list = useRef<HTMLDivElement>(null);
  const machine = workspace?.machine ?? visited.machine;
  const directory = workspace?.path ?? directoryOf(visited);
  const scope = fileKey({ machine, path: directory });
  const files = listing?.scope === scope ? listing.rows : undefined;
  const matches = grep?.scope === scope ? grep.rows : undefined;
  const mode: SearchMode = query.startsWith('>') ? 'grep' : query.startsWith('@') ? 'symbols' : 'files';
  const { flags, needle } = mode === 'symbols'
    ? { flags: [], needle: query.slice(1).trim() }
    : rgQuery(mode === 'files' ? query : query.slice(1));
  const options = useMemo(() => serviceFor(visited), [fileKey(visited)]);
  const fileFlags = mode === 'files' ? JSON.stringify(flags) : undefined;
  useEffect(() => {
    if (fileFlags === undefined) return;
    let alive = true;
    const timer = setTimeout(() => {
      void context.ui.request<string[]>('find-files', { machine, path: directory, args: flags })
        .then((rows) => { if (alive) { setListing({ scope, rows }); clearStatus('files'); } })
        .catch((problem: Error) => { if (alive) { setListing({ scope, rows: [] }); setStatus({ mode: 'files', text: problem.message }); } });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [context, scope, fileFlags]);
  useEffect(() => {
    if (mode !== 'symbols') return;
    // A cross-file preview closes the visited document on its server. Restore it before asking for its symbols.
    if (!visitedReady) { peek(visited); setSymbols(undefined); return; }
    if (!options || !services) { setSymbols([]); return; }
    let alive = true;
    void services.symbols(options)
      .then((found) => { if (alive) { setSymbols(found); clearStatus('symbols'); } })
      .catch((problem: Error) => { if (alive) { setSymbols([]); setStatus({ mode: 'symbols', text: problem.message }); } });
    return () => { alive = false; };
  }, [mode, options, services, visitedReady, peek, visited]);
  useEffect(() => {
    if (mode !== 'grep') return;
    if (!needle) { setGrep(undefined); clearStatus('grep'); return; }
    let alive = true;
    setStatus({ mode: 'grep', text: '正在搜索…' });
    const timer = setTimeout(() => {
      void context.ui.request<SearchHit[]>('grep', { machine, path: directory, query: needle, args: flags })
        .then((found) => {
          if (!alive) return;
          setGrep({ scope, rows: found });
          clearStatus('grep');
        })
        .catch((problem: Error) => { if (!alive) return; setGrep({ scope, rows: [] }); setStatus({ mode: 'grep', text: problem.message }); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [mode, needle, context, scope, JSON.stringify(flags)]);
  const { rows, answered } = useMemo(() => {
    const capped = (answered: boolean, drawn: SearchRow[]) => ({ answered, rows: drawn.slice(0, rowLimit) });
    const prefix = directory.endsWith('/') ? directory : `${directory}/`;
    const shownPath = (path: string) => path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (mode === 'grep') {
      return capped(matches !== undefined, (matches ?? []).map((hit) => ({
        key: `${hit.path}:${hit.line}`, title: hit.text,
        detail: `${shownPath(hit.path)}:${hit.line}`,
        target: { path: hit.path, line: hit.line, column: hit.column },
      })));
    }
    // Keep unmatched ancestors so filtering preserves the matching declaration's context.
    if (mode === 'symbols') {
      const branch = (entries: FileSymbol[], depth: number): SearchRow[] => entries.flatMap((entry) => {
        // `single` takes no threshold, so this name is asked through `go`, which is what applies `matchThreshold`.
        const hit = needle ? fuzzysort.go(needle, [entry.name], { threshold: matchThreshold })[0] : undefined;
        const below = branch(entry.children ?? [], depth + 1);
        if (needle && hit === undefined && below.length === 0) return [];
        return [{
          key: `${entry.line}:${entry.column}`, title: entry.name, depth, marks: hit?.indexes,
          target: { path: visited.path, line: entry.line, column: entry.column },
        }, ...below];
      });
      return capped(symbols !== undefined, branch(symbols ?? [], 0));
    }
    const candidates: SearchRow[] = (files ?? []).map((path) => ({
      key: path, title: shownPath(path),
      target: { path },
    }));
    if (!needle) return capped(files !== undefined, candidates);
    // Apply our row cap after restoring input order for equal scores.
    const found = fuzzysort.go(needle, candidates, { key: 'title', threshold: matchThreshold, limit: 0 });
    const positions = new Map(candidates.map((candidate, index) => [candidate, index]));
    return capped(files !== undefined, [...found]
      .sort((a, b) => b.score - a.score || positions.get(a.obj)! - positions.get(b.obj)!)
      .map((one) => ({ ...one.obj, marks: one.indexes })));
  }, [mode, needle, directory, visited.path, files, matches, symbols]);
  const note = status?.mode === mode ? status.text : '';
  const at = chosen === 'match'
    ? rows.findIndex((row) => mode !== 'symbols' || !needle || !!row.marks?.length)
    : rows.findIndex(row => row.key === chosen);
  const fileFor = (row: SearchRow): FileClick => ({ type: 'file', machine: mode === 'symbols' ? visited.machine : machine, ...row.target });
  const selected = rows[at] && fileFor(rows[at]);
  const selectedKey = selected && searchLocationKey(selected);
  useEffect(() => { list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' }); }, [at, rows]);
  // A name typed a letter at a time would otherwise read a file per letter, so the row under the selection is taken
  // once the selection rests.
  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => peek(selected), 120);
    return () => clearTimeout(timer);
  }, [peek, selectedKey]);
  // fuzzysort reports UTF-16 offsets. Merge adjacent offsets so a surrogate pair stays in one highlight.
  const marked = (text: string, marks?: ReadonlyArray<number>) => {
    if (!marks?.length) return text;
    const runs: [number, number][] = [];
    for (const index of [...marks].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && last[1] === index) last[1] += 1;
      else runs.push([index, index + 1]);
    }
    const parts: ReactNode[] = [];
    let from = 0;
    for (const [start, end] of runs) {
      if (start > from) parts.push(text.slice(from, start));
      parts.push(<b key={start}>{text.slice(start, end)}</b>);
      from = end;
    }
    if (from < text.length) parts.push(text.slice(from));
    return parts;
  };

  return <div className="search-panel" role="dialog" aria-label="搜索">
    <div className="search-head">
      <Glass className="search-glass" />
      <input className="search-input" aria-label="搜索" autoFocus value={query} spellCheck={false} placeholder="搜索文件，-- 后传 rg 参数，> 搜内容，@ 列符号"
        onChange={(event) => { setQuery(event.target.value); setChosen('match'); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Enter') { event.preventDefault(); if (selected) navigate(selected); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setChosen(rows[Math.min(at + 1, rows.length - 1)]?.key ?? 'match'); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setChosen(rows[Math.max(at - 1, 0)]?.key ?? 'match'); }
        }} />
      <button className="search-close" type="button" aria-label="关闭搜索" title="关闭" onClick={close}>×</button>
    </div>
    {note && <div className="search-note" role="status">{note}</div>}
    <div className="search-list" ref={list}>
      {rows.map((row, index) => <button key={row.key} type="button" className="search-row" aria-current={index === at || undefined} style={{ '--depth': row.depth ?? 0 } as CSSProperties} onClick={() => navigate(fileFor(row))} onMouseMove={() => setChosen(row.key)}>
        <span className="search-title">{marked(row.title, row.marks)}</span>
        {row.detail && <span className="search-detail">{row.detail}</span>}
      </button>)}
      {answered && !rows.length && !note && <div className="file-message">{emptyMessage[mode]}</div>}
    </div>
  </div>;
}
