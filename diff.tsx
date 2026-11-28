import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { Vim, getCM, type CodeMirrorV } from '@replit/codemirror-vim';
import type { FileClick, Theme } from '@lengmoxxl/sdk';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { editorTheme } from './theme';
import { modeFor } from './mode';
import { mapVimAction, viewChrome } from './view';
import { formatGitUri, type GitUri } from './uri';
import { boundedCache, editOf, fileKey, watch, type Diff, type Font, type HistoryEntry, type Settings } from './shared';
import { Navigation, Notice, Overlay, pageOf, useNotice, writing, type Navigate, type Remember } from './chrome';

// ]c and [c walk the changes the way vim's diff mode does, a count walking that many and wrapping round the ends.
mapVimAction(']c', 'wangcai-editor-next-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToNextChunk(view); });
mapVimAction('[c', 'wangcai-editor-previous-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToPreviousChunk(view); });
// gf opens the worktree file as a normal editable view, the way vim's goto-file leaves the diff for the file itself.
const diffOpen = new Map<EditorView, () => void>();
mapVimAction('gf', 'wangcai-editor-open-file', (view) => diffOpen.get(view)?.());

// The comparison a pane last held, by git url, so a jump back shows it at once while the sides are read again quietly.
const diffCache = boundedCache<Diff>(50);

// The merge view's default scanLimit (500) falls back to a crude diff on larger files, painting unchanged lines as
// changed. Search precisely instead, with a time budget so a pathological comparison cannot hang the page.
const diffConfig = { scanLimit: 1e9, timeout: 1000 };

const readingOrder = ['auto', 'split', 'inline'] as const;
type Reading = typeof readingOrder[number];
const readings: Record<Reading, string> = { auto: '自动', split: '双栏', inline: '单栏' };

// The reading habit is the reader's rather than the comparison's, so one store holds it for every diff tab.
type DiffLayout = { reading: Reading; wrap: boolean };
const layoutKey = 'editor-diff-layout';
const layoutDefaults: DiffLayout = { reading: 'auto', wrap: true };
const readLayout = (): DiffLayout => {
  try { return { ...layoutDefaults, ...JSON.parse(localStorage.getItem(layoutKey) ?? '{}') }; } catch { return layoutDefaults; }
};
const writeLayout = (patch: Partial<DiffLayout>) => localStorage.setItem(layoutKey, JSON.stringify({ ...readLayout(), ...patch }));

type Caret = { line: number; column: number };
type Jump = { next: () => void; previous: () => void };
type Held = {
  view: () => EditorView; write: (oldText: string, newText: string) => void; count: () => number;
  rewrap: (on: boolean) => void;
  now: (state?: EditorState) => Caret; seat: (line: number, column: number) => number;
  place: (side: 'a' | 'b' | undefined, line?: number, column?: number, top?: number) => void;
};

// The merge view itself, mounted only once the two sides are read so its host is always on screen for the effects.
function DiffSurface({ context, diff, path, reading, wrap, font, jumps, blocks, openFile, entry, remember, navigate }: {
  context: UiContext; diff: Diff; path: string; reading: Reading; wrap: boolean; font: Font;
  jumps: RefObject<Jump | undefined>; blocks: (count: number) => void; openFile: () => void; entry: HistoryEntry; remember: Remember; navigate: Navigate;
}) {
  const element = useRef<HTMLDivElement>(null);
  const held = useRef<Held>(undefined);
  const entryRef = useRef(entry);
  useEffect(() => { entryRef.current = entry; });
  const keptScroll = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const [theme, setTheme] = useState<Theme>(context.host.config.theme);
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
    const common = [
      colours.of(editorTheme(theme, font)),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      ...viewChrome, EditorState.readOnly.of(true), modeFor(path),
      EditorView.updateListener.of((update) => { if (update.selectionSet) rememberHere(update.view); }),
      EditorView.domEventHandlers({ focus: (_event, view) => { active = view; } }),
    ];
    let scroller: HTMLElement, views: EditorView[], count: () => number,
      write: (oldText: string, newText: string) => void, destroy: () => void;
    if (unified) {
      const view = new EditorView({
        state: EditorState.create({ doc: diff.newText, extensions: [...common, unifiedMergeView({ original: diff.oldText, mergeControls: false, gutter: false, diffConfig })] }),
        parent: host,
      });
      scroller = view.scrollDOM; views = [view];
      count = () => getChunks(view.state)?.chunks.length ?? 0;
      write = (oldText, newText) => {
        const current = view.state.doc.toString();
        const original = getOriginalDoc(view.state).toString();
        if (current === newText && original === oldText) return;
        view.dispatch({ changes: editOf(current, newText), effects: originalDocChangeEffect(view.state, ChangeSet.of(editOf(original, oldText), original.length)) });
      };
      destroy = () => view.destroy();
    } else {
      const view = new MergeView({
        a: { doc: diff.oldText, extensions: common },
        b: { doc: diff.newText, extensions: common },
        parent: host, gutter: false, diffConfig,
      });
      scroller = view.dom; views = [view.a, view.b];
      count = () => view.chunks.length;
      write = (oldText, newText) => {
        const before = view.a.state.doc.toString();
        const after = view.b.state.doc.toString();
        if (before !== oldText) view.a.dispatch({ changes: editOf(before, oldText) });
        if (after !== newText) view.b.dispatch({ changes: editOf(after, newText) });
      };
      destroy = () => view.destroy();
    }
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
    const rewrap = (on: boolean) => { for (const view of views) view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }); };
    const offTheme = context.global.subscribe<Theme>('theme', (next) => { setTheme(next); for (const view of views) view.dispatch({ effects: colours.reconfigure(editorTheme(next, font)) }); });
    scroller.scrollTop = keptScroll.current;
    const seat = (view: EditorView, line: number, column: number) => {
      const at = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, line)));
      return Math.min(at.to, at.from + Math.max(0, column - 1));
    };
    const now = (state: EditorState = active.state): Caret => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1 };
    };
    // Each buffer is its own history visit: show the entry's side and seat it at the line/scroll that visit remembered.
    const place = (side: 'a' | 'b' | undefined, line?: number, column?: number, top?: number) => {
      const view = side === 'a' ? views[0] : views[views.length - 1];
      active = view;
      if (line !== undefined) {
        const pos = seat(view, line, column ?? 1);
        // A visit that remembers a scroll offset goes back to that offset, not centred on the line; the
        // centre would land after the offset and win. Only a visit with no offset is centred on its line.
        view.dispatch({ selection: { anchor: pos }, effects: top === undefined ? EditorView.scrollIntoView(pos, { y: 'center' }) : [] });
      }
      view.focus();
      if (top !== undefined) {
        // A view that has not measured the screenful yet cannot scroll that far, so it is asked again on a
        // later frame, the way the editor puts a visit back.
        let frames = 0;
        const put = () => {
          scroller.scrollTop = top;
          if (Math.abs(scroller.scrollTop - top) > 1 && frames < 60) { frames += 1; requestAnimationFrame(put); }
        };
        put();
      }
    };
    const rememberHere = (view: EditorView) => {
      if (view !== active) return;
      const c = now(view.state);
      remember(entryRef.current, { line: c.line, column: c.column });
    };
    const onScroll = () => remember(entryRef.current, { top: scroller.scrollTop });
    place(entry.side, entry.line, entry.column, entry.top);
    jumps.current = { next: () => goToNextChunk(active), previous: () => goToPreviousChunk(active) };
    blocks(count());
    // C-w h/l visit the other buffer as its own history entry, so C-o/C-i (the tab history) walk back between them.
    const switchSide = (side: 'a' | 'b') => { const c = now(); navigate({ type: 'file', machine: entryRef.current.machine, path: entryRef.current.path, side, line: c.line, column: c.column }); };
    // A press that leaves the diff ends an insert mode still open, as the editor ends one on the way out.
    const leaveInsert = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
      const cm = getCM(active);
      if (cm) Vim.exitInsertMode(cm as CodeMirrorV, true);
    };
    host.addEventListener('focusout', leaveInsert);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // The keyboard belongs in the diff when it is shown: handed over on mount and again each time the page is shown, as
    // the editor does, unless a box is being typed into.
    const focus = () => { if (!writing(document.activeElement)) active.focus(); };
    focus();
    const page = pageOf(host);
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
    held.current = { view: () => active, write, count, rewrap, now, seat: (line, column) => seat(active, line, column), place };
    for (const view of views) diffOpen.set(view, openFile);
    return () => {
      keptScroll.current = scroller.scrollTop;
      jumps.current = undefined;
      for (const view of views) diffOpen.delete(view);
      host.removeEventListener('focusout', leaveInsert); scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey, true); clearTimeout(windowTimer);
      page?.removeEventListener('wangcai:shown', focus); offTheme();
      destroy(); held.current = undefined;
    };
  }, [path, unified]);

  // A read of the comparison already shown rewrites the sides where they stand, keeping the caret and scroll.
  useEffect(() => {
    const pane = held.current;
    if (!pane) return;
    const at = pane.now();
    pane.write(diff.oldText, diff.newText);
    const pos = pane.seat(at.line, at.column);
    const view = pane.view();
    if (view.state.selection.main.head !== pos) view.dispatch({ selection: { anchor: pos } });
    blocks(pane.count());
  }, [diff]);

  useEffect(() => { held.current?.rewrap(wrap); }, [wrap]);

  // A history visit (C-o/C-i, or a C-w switch) names a side and the place it was left; show and seat it.
  useEffect(() => { held.current?.place(entry.side, entry.line, entry.column, entry.top); }, [entry.side, entry.line, entry.column, entry.top]);

  return <div className="git-editor" ref={element} />;
}

export function DiffView({ context, file, uri, holder, navigate, back, forward, remember }: { context: UiContext; file: HistoryEntry; uri: GitUri; holder: string; navigate: Navigate; back?: () => void; forward?: () => void; remember: Remember }) {
  const font: Font = (context.host.config as Settings).font;

  const jumps = useRef<Jump>(undefined);
  const [layout, setLayout] = useState(readLayout);
  const [diff, setDiff] = useState<Diff | undefined>(() => diffCache.get(fileKey(file)));
  const [error, setError] = useState('');
  const [blocks, setBlocks] = useState(0);
  const [force, setForce] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, report] = useNotice();
  const [menu, setMenu] = useState(false);
  const patch = (next: Partial<DiffLayout>) => { writeLayout(next); setLayout(readLayout()); };

  // The two sides are read when the pane opens and again when the worktree side changes on disk.
  useEffect(() => {
    let alive = true;
    setError('');
    void context.ui.request<Diff>('diff', { machine: file.machine, path: uri.path, base: uri.base, head: uri.head, oldPath: uri.oldPath, force })
      .then((next) => { if (alive) { diffCache.set(fileKey(file), next); setDiff(next); } })
      .catch((problem: Error) => { if (alive) setError(problem.message); });
    const worktree = [uri.base, uri.head].includes(':worktree');
    const stop = worktree ? watch(context, file.machine, `diff:${holder}:${uri.path}`, [uri.path], () => setRefresh(value => value + 1)) : () => {};
    return () => { alive = false; stop(); };
  }, [context, file.machine, uri.path, uri.base, uri.head, uri.oldPath, force, refresh, holder]);

  const openFile = () => {
    void context.global.publish('onclick', { type: 'file', machine: file.machine, path: uri.path, line: file.line, column: file.column } satisfies FileClick);
  };

  return <section className="editor editor-diff" aria-label="Git 差异">
    <Navigation context={context} file={{ ...file, path: uri.path }} address={formatGitUri(uri)} navigate={navigate} back={back} forward={forward}
      dirty={false} refresh={() => setRefresh(value => value + 1)} report={report} refreshTitle="重读差异"
      menu={<>
        <button className="editor-icon" aria-label="差异设置" title={`差异设置${blocks ? `（${blocks} 处改动）` : ''}`} onClick={() => setMenu(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>
        </button>
        {menu && <Overlay className="code-menu" role="menu" label="差异设置" at={{ right: 8, top: 36 }} onClose={() => setMenu(false)}>
          <button onClick={() => patch({ reading: readingOrder[(readingOrder.indexOf(layout.reading) + 1) % readingOrder.length] })}>{`阅读方式：${readings[layout.reading]}`}</button>
          <button aria-pressed={layout.wrap} onClick={() => patch({ wrap: !layout.wrap })}>长行折行</button>
          <button disabled={!blocks} onClick={() => jumps.current?.previous()}>上一处改动（[c）</button>
          <button disabled={!blocks} onClick={() => jumps.current?.next()}>下一处改动（]c）</button>
          <button disabled={uri.head === ':empty'} onClick={openFile}>打开文件（gf）</button>
        </Overlay>}
      </>} />
    <div className="editor-main">
      <Notice text={notice} />
      {error ? <div className="file-message" role="alert">{error}</div>
        : diff?.notice ? <div className="file-message">{diff.notice}</div>
        : diff?.tooLarge ? <div className="file-message">文件过大（{Math.ceil(diff.tooLarge / 1024 / 1024)} MB）<button onClick={() => setForce(true)}>仍然加载</button></div>
        : !diff ? <div className="file-message">正在读取…</div>
        : <DiffSurface context={context} diff={diff} path={uri.path} reading={layout.reading} wrap={layout.wrap} font={font} jumps={jumps} blocks={setBlocks} openFile={openFile} entry={file} remember={remember} navigate={navigate} />}
    </div>
  </section>;
}

