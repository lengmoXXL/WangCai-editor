import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { Vim, getCM, type CodeMirrorV } from '@replit/codemirror-vim';
import { bindKeys } from '@lengmoxxl/sdk/keys';
import type { FileClick, Theme } from '@lengmoxxl/sdk';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { editorTheme } from './theme';
import { modeFor } from './mode';
import { mapVimAction, viewChrome } from './view';
import type { GitUri } from './uri';
import { editOf, watch, type Diff, type Font, type HistoryEntry, type Settings } from './shared';
import { Navigation, Notice, Overlay, useNotice, type Navigate } from './chrome';

// ]c and [c walk the changes the way vim's diff mode does, a count walking that many and wrapping round the ends.
mapVimAction(']c', 'wangcai-editor-next-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToNextChunk(view); });
mapVimAction('[c', 'wangcai-editor-previous-change', (view, repeat) => { for (let at = 0; at < repeat; at += 1) goToPreviousChunk(view); });
// gf opens the worktree file as a normal editable view, the way vim's goto-file leaves the diff for the file itself.
const diffOpen = new Map<EditorView, () => void>();
mapVimAction('gf', 'wangcai-editor-open-file', (view) => diffOpen.get(view)?.());

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
  side: EditorView; write: (oldText: string, newText: string) => void; count: () => number;
  rewrap: (on: boolean) => void; reveal: () => void;
  now: (state?: EditorState) => Caret; seat: (line: number, column: number) => number;
};

// The merge view itself, mounted only once the two sides are read so its host is always on screen for the effects.
function DiffSurface({ context, diff, path, reading, wrap, font, caret, jumps, blocks, openFile }: {
  context: UiContext; diff: Diff; path: string; reading: Reading; wrap: boolean; font: Font;
  caret: RefObject<Caret | undefined>; jumps: RefObject<Jump | undefined>; blocks: (count: number) => void; openFile: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const held = useRef<Held>(undefined);
  const keptScroll = useRef(0);
  const keptFocus = useRef(false);
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
    const common = [
      colours.of(editorTheme(theme, font)),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      ...viewChrome, EditorState.readOnly.of(true), modeFor(path),
      EditorView.updateListener.of((update) => { if (update.selectionSet) caret.current = now(update.state); }),
    ];
    let side: EditorView, scroller: HTMLElement, views: EditorView[], count: () => number,
      write: (oldText: string, newText: string) => void, destroy: () => void;
    if (unified) {
      const view = new EditorView({
        state: EditorState.create({ doc: diff.newText, extensions: [...common, unifiedMergeView({ original: diff.oldText, mergeControls: false, gutter: false })] }),
        parent: host,
      });
      side = view; scroller = view.scrollDOM; views = [view];
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
        parent: host, gutter: false,
      });
      side = view.b; scroller = view.dom; views = [view.a, view.b];
      count = () => view.chunks.length;
      write = (oldText, newText) => {
        const before = view.a.state.doc.toString();
        const after = view.b.state.doc.toString();
        if (before !== oldText) view.a.dispatch({ changes: editOf(before, oldText) });
        if (after !== newText) view.b.dispatch({ changes: editOf(after, newText) });
      };
      destroy = () => view.destroy();
    }
    const rewrap = (on: boolean) => { for (const view of views) view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }); };
    const offTheme = context.global.subscribe<Theme>('theme', (next) => { setTheme(next); for (const view of views) view.dispatch({ effects: colours.reconfigure(editorTheme(next, font)) }); });
    scroller.scrollTop = keptScroll.current;
    const seat = (line: number, column: number) => {
      const at = side.state.doc.line(Math.min(side.state.doc.lines, Math.max(1, line)));
      return Math.min(at.to, at.from + Math.max(0, column - 1));
    };
    const now = (state: EditorState = side.state): Caret => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1 };
    };
    const reveal = () => {
      const head = side.state.selection.main.head;
      const coords = side.coordsAtPos(head);
      const box = scroller.getBoundingClientRect();
      if (!coords || coords.top < box.top || coords.bottom > box.bottom) side.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
    };
    if (caret.current) {
      const at = seat(caret.current.line, caret.current.column);
      side.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    }
    jumps.current = { next: () => { goToNextChunk(side); }, previous: () => { goToPreviousChunk(side); } };
    blocks(count());
    // A press that leaves the diff ends an insert mode still open, as the editor ends one on the way out.
    const leaveInsert = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
      const cm = getCM(side);
      if (cm) Vim.exitInsertMode(cm as CodeMirrorV, true);
    };
    host.addEventListener('focusout', leaveInsert);
    if (keptFocus.current) side.focus();
    held.current = { side, write, count, rewrap, reveal, now, seat };
    diffOpen.set(side, openFile);
    return () => {
      keptScroll.current = scroller.scrollTop;
      keptFocus.current = side.hasFocus;
      jumps.current = undefined; diffOpen.delete(side);
      host.removeEventListener('focusout', leaveInsert); offTheme();
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
    if (pane.side.state.selection.main.head !== pos) pane.side.dispatch({ selection: { anchor: pos } });
    blocks(pane.count());
    pane.reveal();
  }, [diff]);

  useEffect(() => { held.current?.rewrap(wrap); }, [wrap]);

  return <div className="git-editor" ref={element} />;
}

export function DiffView({ context, file, uri, holder, navigate, back, forward, openSearch }: { context: UiContext; file: HistoryEntry; uri: GitUri; holder: string; navigate: Navigate; back?: () => void; forward?: () => void; openSearch: () => void }) {
  const font: Font = (context.host.config as Settings).font;
  const caret = useRef<Caret>(file.line ? { line: file.line, column: file.column ?? 1 } : undefined);
  const jumps = useRef<Jump>(undefined);
  const [layout, setLayout] = useState(readLayout);
  const [diff, setDiff] = useState<Diff>();
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
      .then((next) => { if (alive) setDiff(next); })
      .catch((problem: Error) => { if (alive) setError(problem.message); });
    const worktree = [uri.base, uri.head].includes(':worktree');
    const stop = worktree ? watch(context, file.machine, `diff:${holder}:${uri.path}`, [uri.path], () => setRefresh(value => value + 1)) : () => {};
    return () => { alive = false; stop(); };
  }, [context, file.machine, uri.path, uri.base, uri.head, uri.oldPath, force, refresh, holder]);

  // Ctrl+Shift+h hands the keys back to the Git list, which is a view of its own now.
  useEffect(() => {
    const unbind = bindKeys(document.body, [
      { keys: '<C-S-h>', run: () => { void context.global.publish('core:show-view', { plugin: 'git' }); void context.global.publish('git:focus-rail', null); } },
    ], { fields: 'all' });
    return unbind;
  }, [context]);

  const openFile = () => {
    void context.global.publish('onclick', { type: 'file', machine: file.machine, path: uri.path, line: caret.current?.line, column: caret.current?.column } satisfies FileClick);
  };

  return <section className="editor editor-diff" aria-label="Git 差异">
    <Navigation context={context} file={{ ...file, path: uri.path }} navigate={navigate} back={back} forward={forward} openSearch={openSearch}
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
        : <DiffSurface context={context} diff={diff} path={uri.path} reading={layout.reading} wrap={layout.wrap} font={font} caret={caret} jumps={jumps} blocks={setBlocks} openFile={openFile} />}
    </div>
  </section>;
}

