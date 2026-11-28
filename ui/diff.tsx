import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { Vim, getCM, type CodeMirrorV } from '@replit/codemirror-vim';
import type { FileClick, Theme } from '@lengmoxxl/sdk';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { editorTheme } from './theme';
import { modeFor } from './mode';
import { cursorOffset, cursorPosition, mapVimAction, restorePosition, viewChrome } from './view';
import { boundedCache, watch } from './files';
import { changesBetween } from './merge';
import { fileKey, type Diff, type GitUri, type HistoryEntry } from '../shared';
import { Navigation, Notice, Overlay, pageOf, useNotice, writing, type Navigate } from './chrome';

// Split at the last ~ so a base revision such as HEAD~3 keeps its ancestry.
export function parseGitUri(uri: string): GitUri | undefined {
  const match = /^git:\/\/(.+?)@([^?@]+)~([^?@~]+)(?:\?old=(.+))?$/s.exec(uri);
  if (!match) return undefined;
  const [, path, base, head, oldPath] = match;
  return { path, base, head, oldPath };
}

mapVimAction(']c', 'wangcai-editor-next-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToNextChunk(view); });
mapVimAction('[c', 'wangcai-editor-previous-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToPreviousChunk(view); });
const diffOpen = new Map<EditorView, () => void>();
mapVimAction('gf', 'wangcai-editor-open-file', (view) => diffOpen.get(view)?.());

// On a history jump the cached diff is visible while its sides reload.
const diffCache = boundedCache<Diff>(50);

// The default scan budget marks unchanged lines in large diffs. Keep a time limit on the more precise scan.
const diffConfig = { scanLimit: 1e9, timeout: 1000 };

const readingOrder = ['auto', 'split', 'inline'] as const;
type Reading = typeof readingOrder[number];
const readings: Record<Reading, string> = { auto: '自动', split: '双栏', inline: '单栏' };

type DiffLayout = { reading: Reading; wrap: boolean };
const layoutKey = 'editor-diff-layout';
const layoutDefaults: DiffLayout = { reading: 'auto', wrap: true };
const readLayout = (): DiffLayout => {
  try { return { ...layoutDefaults, ...JSON.parse(localStorage.getItem(layoutKey) ?? '{}') }; } catch { return layoutDefaults; }
};

type Jump = { next: () => void; previous: () => void; focus: () => void };
type Held = {
  view: () => EditorView; write: (oldText: string, newText: string) => void; count: () => number;
  rewrap: (on: boolean) => void;
  place: (entry: HistoryEntry) => void;
};

function DiffSurface({ context, diff, uri, reading, wrap, jumps, blocks, openFile, entry, navigate }: {
  context: UiContext; diff: Diff; uri: GitUri; reading: Reading; wrap: boolean;
  jumps: RefObject<Jump | undefined>; blocks: (count: number) => void; openFile?: (cursor: Pick<FileClick, 'line' | 'column'>) => void; entry: HistoryEntry; navigate: Navigate;
}) {
  const element = useRef<HTMLDivElement>(null);
  const held = useRef<Held>(undefined);
  const entryRef = useRef(entry);
  useEffect(() => { entryRef.current = entry; });
  const keptScroll = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const unified = reading === 'inline' || (reading === 'auto' && narrow);

  useEffect(() => {
    const host = element.current!;
    const sized = new ResizeObserver(() => setNarrow(host.clientWidth < 900));
    sized.observe(host);
    return () => sized.disconnect();
  }, []);

  useEffect(() => {
    const host = element.current!;
    const colours = new Compartment();
    const wrapping = new Compartment();
    let active: EditorView;
    let windowPending = false;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    const paths = unified ? [uri.path] : [uri.oldPath ?? uri.path, uri.path];
    const extensions = (path: string) => [
      colours.of(editorTheme(context.host.config, path)),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      ...viewChrome, EditorState.readOnly.of(true), modeFor(path),
      EditorView.updateListener.of((update) => { if (update.selectionSet) rememberHere(update.view); }),
      EditorView.domEventHandlers({ focus: (_event, view) => {
        if (active && active !== view && !unified) {
          const { machine, path } = entryRef.current;
          const visit: HistoryEntry = { type: 'file', machine, path, side: view === views[0] ? 'a' : 'b', top: scroller.scrollTop, ...cursorPosition(view.state) };
          entryRef.current = visit;
          navigate(visit);
        }
        active = view;
      } }),
    ];
    let scroller: HTMLElement, views: EditorView[], count: () => number,
      write: (oldText: string, newText: string) => void, destroy: () => void;
    if (unified) {
      const view = new EditorView({
        state: EditorState.create({ doc: diff.newText, extensions: [...extensions(paths[0]), unifiedMergeView({ original: diff.oldText, mergeControls: false, gutter: false, diffConfig })] }),
        parent: host,
      });
      scroller = view.scrollDOM; views = [view];
      count = () => getChunks(view.state)?.chunks.length ?? 0;
      write = (oldText, newText) => {
        const current = view.state.doc.toString();
        const original = getOriginalDoc(view.state).toString();
        if (current === newText && original === oldText) return;
        view.dispatch({ changes: changesBetween(current, newText), effects: originalDocChangeEffect(view.state, changesBetween(original, oldText)) });
      };
      destroy = () => view.destroy();
    } else {
      const view = new MergeView({
        a: { doc: diff.oldText, extensions: extensions(paths[0]) },
        b: { doc: diff.newText, extensions: extensions(paths[1]) },
        parent: host, gutter: false, diffConfig,
      });
      scroller = view.dom; views = [view.a, view.b];
      count = () => view.chunks.length;
      write = (oldText, newText) => {
        const before = view.a.state.doc.toString();
        const after = view.b.state.doc.toString();
        if (before !== oldText) view.a.dispatch({ changes: changesBetween(before, oldText) });
        if (after !== newText) view.b.dispatch({ changes: changesBetween(after, newText) });
      };
      destroy = () => view.destroy();
    }
    active = views[views.length - 1];
    // The merge spacers make CodeMirror's coordinate-based vertical motion leap into the rendered viewport when the
    // caret is scrolled off screen. Land such a move on its document line instead; vim's own moveByLines still applies
    // the goal column and the count, so only the leap is removed.
    for (const view of views) {
      const cm = getCM(view);
      if (!cm) continue;
      const findPosV = cm.findPosV.bind(cm);
      cm.findPosV = (start, amount, unit, goalColumn) => {
        const pos = findPosV(start, amount, unit, goalColumn);
        if (unit !== 'line') return pos;
        const line = Math.max(0, Math.min(view.state.doc.lines - 1, start.line + amount));
        if (pos.line === line) return pos;
        const at = view.state.doc.line(start.line + 1);
        const head = at.from + Math.min(start.ch, at.length);
        const { from, to } = view.viewport;
        if (head >= from && head <= to) return pos;
        pos.line = line;
        pos.ch = Math.min(start.ch, view.state.doc.line(line + 1).length);
        return pos;
      };
    }
    const rewrap = (on: boolean) => {
      const wrapped = wrapping.get(views[0].state) === EditorView.lineWrapping;
      if (on === wrapped) return;
      for (const view of views) view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) });
    };
    const offTheme = context.global.subscribe<Theme>('theme', (next) => {
      views.forEach((view, i) => view.dispatch({ effects: colours.reconfigure(editorTheme(context.host.config, paths[i], next)) }));
    });
    scroller.scrollTop = keptScroll.current;
    const page = pageOf(host);
    const focus = () => { if (!page?.querySelector('.editor-backdrop') && !writing(document.activeElement)) active.focus(); };
    let cancelPlacement: (() => void) | undefined;
    const place = (entry: HistoryEntry) => {
      active = entry.side === 'a' ? views[0] : views[views.length - 1];
      cancelPlacement?.();
      cancelPlacement = restorePosition(active, scroller, entry);
      focus();
    };
    const rememberHere = (view: EditorView) => {
      if (view !== active) return;
      Object.assign(entryRef.current, cursorPosition(view.state));
    };
    const onScroll = () => { entryRef.current.top = scroller.scrollTop; };
    jumps.current = { next: () => goToNextChunk(active), previous: () => goToPreviousChunk(active), focus: () => active.focus() };
    blocks(count());
    // C-w h/l visit the other buffer as its own history entry, so C-o/C-i (the tab history) walk back between them.
    const switchSide = (side: 'a' | 'b') => {
      if (active === (side === 'a' ? views[0] : views[views.length - 1])) return;
      navigate({ type: 'file', machine: entryRef.current.machine, path: entryRef.current.path, side, ...cursorPosition(active.state) });
    };
    // A press that leaves the diff ends an insert mode still open, as the editor ends one on the way out.
    const leaveInsert = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
      const cm = getCM(active);
      if (cm) Vim.exitInsertMode(cm as CodeMirrorV, true);
    };
    host.addEventListener('focusout', leaveInsert);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    page?.addEventListener('wangcai:shown', focus);
    // C-w h/l is answered ahead of the vim layer: a window capture listener scoped to this host sees the press first and
    // takes only that combination — C-o/C-i and every other key fall through, the jumps to the tab history.
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey) return;
      if (!(event.target instanceof Node) || !host.contains(event.target)) return;
      const key = event.key.toLowerCase();
      const take = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.ctrlKey && !event.shiftKey && key === 'w') { windowPending = true; clearTimeout(windowTimer); windowTimer = setTimeout(() => { windowPending = false; }, 1000); take(); return; }
      if (windowPending && (key === 'h' || key === 'l')) { windowPending = false; switchSide(key === 'h' ? 'a' : 'b'); take(); }
    };
    window.addEventListener('keydown', onKey, true);
    held.current = { view: () => active, write, count, rewrap, place };
    if (openFile) for (const view of views) diffOpen.set(view, () => openFile(cursorPosition(view.state)));
    return () => {
      cancelPlacement?.();
      keptScroll.current = scroller.scrollTop;
      jumps.current = undefined;
      for (const view of views) diffOpen.delete(view);
      host.removeEventListener('focusout', leaveInsert); scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey, true); clearTimeout(windowTimer);
      page?.removeEventListener('wangcai:shown', focus); offTheme();
      destroy(); held.current = undefined;
    };
  }, [uri.path, uri.oldPath, unified]);

  useEffect(() => {
    const pane = held.current;
    if (!pane) return;
    const view = pane.view();
    const at = cursorPosition(view.state);
    pane.write(diff.oldText, diff.newText);
    const pos = cursorOffset(view.state.doc, at.line, at.column);
    if (view.state.selection.main.head !== pos) view.dispatch({ selection: { anchor: pos } });
    blocks(pane.count());
  }, [diff]);

  useEffect(() => { held.current?.rewrap(wrap); }, [wrap]);

  useEffect(() => { held.current?.place(entry); }, [entry, uri.path, uri.oldPath, unified]);

  return <div className="git-editor" ref={element} />;
}

export function DiffView({ context, file, uri, navigate, back, forward }: { context: UiContext; file: HistoryEntry; uri: GitUri; navigate: Navigate; back?: () => void; forward?: () => void }) {
  const jumps = useRef<Jump>(undefined);
  const [layout, setLayout] = useState(readLayout);
  const key = fileKey(file);
  const [diff, setDiff] = useState<Diff | undefined>(() => diffCache.get(key));
  const [error, setError] = useState('');
  const [blocks, setBlocks] = useState(0);
  const [force, setForce] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const subscription = useRef<ReturnType<typeof watch>>(undefined);
  const [notice, report] = useNotice();
  const [menu, setMenu] = useState(false);
  const patch = (change: Partial<DiffLayout>) => {
    const next = { ...readLayout(), ...change };
    localStorage.setItem(layoutKey, JSON.stringify(next));
    setLayout(next);
  };

  useEffect(() => {
    let alive = true;
    setError('');
    void context.ui.request<Diff>('diff', { machine: file.machine, ...uri, force })
      .then(({ oldText, newText, ...status }) => {
        if (!alive) return;
        const next = { ...status, oldText: oldText.replace(/\r\n?/g, '\n'), newText: newText.replace(/\r\n?/g, '\n') };
        diffCache.set(key, next);
        setDiff(next);
        subscription.current?.retry();
      })
      .catch((problem: Error) => { if (alive) setError(problem.message); });
    return () => { alive = false; };
  }, [context, key, force, refresh]);

  const basePath = uri.base === ':worktree' ? uri.oldPath ?? uri.path : undefined;
  const headPath = uri.head === ':worktree' ? uri.path : undefined;
  useEffect(() => {
    const paths: string[] = [];
    if (basePath) paths.push(basePath);
    if (headPath && headPath !== basePath) paths.push(headPath);
    if (!paths.length) return;
    const watched = watch(context, file.machine, paths, () => setRefresh(value => value + 1));
    subscription.current = watched;
    return () => { subscription.current = undefined; watched.close(); };
  }, [context, key]);

  const worktreePath = headPath ?? basePath ?? uri.path;
  const openFile = uri.head === ':empty' && !basePath ? undefined : ({ line, column }: Pick<FileClick, 'line' | 'column'>) => {
    void context.global.publish('onclick', { type: 'file', machine: file.machine, path: worktreePath, line, column } satisfies FileClick);
  };

  return <section className="editor editor-diff" aria-label="Git 差异">
    <Navigation context={context} file={{ ...file, path: worktreePath }} address={file.path} navigate={navigate} back={back} forward={forward}
      dirty={false} refresh={() => setRefresh(value => value + 1)} report={report} refreshTitle="重读差异"
      menu={<>
        <button className="editor-icon" aria-label="差异设置" title={`差异设置${blocks ? `（${blocks} 处改动）` : ''}`} onClick={() => setMenu(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>
        </button>
        {menu && <Overlay className="code-menu" role="menu" label="差异设置" at={{ right: 8, top: 36 }} onClose={() => { setMenu(false); jumps.current?.focus(); }}>
          <button onClick={() => patch({ reading: readingOrder[(readingOrder.indexOf(layout.reading) + 1) % readingOrder.length] })}>{`阅读方式：${readings[layout.reading]}`}</button>
          <button aria-pressed={layout.wrap} onClick={() => patch({ wrap: !layout.wrap })}>长行折行</button>
          <button disabled={!blocks} onClick={() => jumps.current?.previous()}>上一处改动（[c）</button>
          <button disabled={!blocks} onClick={() => jumps.current?.next()}>下一处改动（]c）</button>
          <button disabled={!openFile} onClick={() => openFile?.(file)}>打开文件（gf）</button>
        </Overlay>}
      </>} />
    <div className="editor-main">
      <Notice text={notice} />
      {error ? <div className="file-message" role="alert">{error}</div>
        : diff?.notice ? <div className="file-message">{diff.notice}</div>
        : diff?.tooLarge ? <div className="file-message">文件过大（{Math.ceil(diff.tooLarge / 1024 / 1024)} MB）<button onClick={() => setForce(true)}>仍然加载</button></div>
        : !diff ? <div className="file-message">正在读取…</div>
        : <DiffSurface context={context} diff={diff} uri={uri} reading={layout.reading} wrap={layout.wrap} jumps={jumps} blocks={setBlocks} openFile={openFile} entry={file} navigate={navigate} />}
    </div>
  </section>;
}

