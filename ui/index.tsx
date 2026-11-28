import { history as undoHistory, indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { Vim, getCM, type CodeMirrorV } from '@replit/codemirror-vim';
import { createRoot } from 'react-dom/client';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Theme, WorkspaceActive } from '@lengmoxxl/sdk';
import { bindKeys } from '@lengmoxxl/sdk/keys';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { LanguageServices, serviceFor, type DisplayedFile, type LocationFeature, type LspPosition, type ServiceStatus, type Target } from './lsp';
import { languageOf, modeFor } from './mode';
import { markdownPreview } from './preview';
import { editorTheme, trackTheme } from './theme';
import { cursorPosition, mapVimAction, restorePosition, viewChrome, viewOf } from './view';
import { DiffView, parseGitUri } from './diff';
import { fileBuffers, type OpenFile } from './files';
import { Search, searchLocationKey } from './search';
import { fileKey, type FileClick, type GitUri, type History, type HistoryEntry } from '../shared';
import { Address, Navigation, Notice, Overlay, pageOf, useNotice, writing, type Navigate, type PageProps } from './chrome';
import './style.css';

const identity = { id: 'editor', title: '编辑器' };
export const title = identity.title;
let activeWorkspaceId: string | undefined;

// Vim collapses a visual selection on keydown. Keep its range until the native paste event.
const mac = /Mac/.test(navigator.platform);
const beforePaste = new WeakMap<EditorView, EditorState>();
const pasteOverSelection = Prec.high(EditorView.domEventHandlers({
  keydown: (event, view) => {
    if (event.key === 'v' && (mac ? event.metaKey : event.ctrlKey) && !view.state.selection.main.empty) beforePaste.set(view, view.state);
    else beforePaste.delete(view);
    return false;
  },
  paste: (_event, view) => {
    const previous = beforePaste.get(view);
    beforePaste.delete(view);
    if (previous?.doc === view.state.doc && !previous.selection.eq(view.state.selection)) {
      view.dispatch({ selection: previous.selection });
    }
    return false;
  },
}));

// Outside insert mode Tab is not typing: leave it to vim and the shell's focus walk.
const tab = Prec.high(keymap.of([{
  key: 'Tab',
  run: (view) => {
    const cm = getCM(view) as CodeMirrorV | undefined;
    if (cm && cm.state.vim.mode !== 'insert') return false;
    const { state } = view;
    if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
    view.dispatch(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' });
    return true;
  },
}]));
const chrome = [tab, pasteOverSelection, ...viewChrome, undoHistory(),
  EditorState.tabSize.of(2), indentUnit.of('  ')];
let services: LanguageServices | undefined;
const histories = new Map<string, History>();
const historyCeiling = 200;
let openBuffer: ReturnType<typeof fileBuffers>;
// A jump records departure and arrival in one turn. Flush immediately when a tab closes.
let pendingSave: ReturnType<typeof setTimeout> | undefined;
const writeHistory = (context: UiContext) => { void context.ui.request('save-history', Object.fromEntries(histories)).catch(() => undefined); };
const saveHistory = (context: UiContext) => {
  if (pendingSave !== undefined) return;
  pendingSave = setTimeout(() => { pendingSave = undefined; writeHistory(context); });
};
const saveHistoryNow = (context: UiContext) => {
  clearTimeout(pendingSave);
  pendingSave = undefined;
  writeHistory(context);
};
// History objects follow a tab when the shell assigns it to a workspace.
type MountedPage = { navigate: Navigate; serviceFile?: DisplayedFile };
const pages = new Map<History, MountedPage>();

type LocationAction = { feature: LocationFeature; keys: string; label: string; title: string };
const locationActions: LocationAction[] = [
  { feature: 'definition', keys: 'gd', label: '转到定义', title: '定义' },
  { feature: 'implementation', keys: 'gi', label: '转到实现', title: '实现' },
  { feature: 'typeDefinition', keys: 'gD', label: '转到类型定义', title: '类型定义' },
  { feature: 'references', keys: 'gr', label: '查找引用', title: '引用' },
];
const pageKeys = new Map<EditorView, { jump: (action: LocationAction) => void; say: (text: string) => void }>();
for (const action of locationActions) {
  mapVimAction(action.keys, `wangcai-${action.feature}`, view => pageKeys.get(view)?.jump(action));
}
Vim.defineEx('write', 'w', (cm) => {
  const view = viewOf(cm);
  if (view) pageKeys.get(view)?.say('文件自动写回，无需 :w');
});

const stateLabels: Record<ServiceStatus['state'], string> = { connecting: '正在启动', open: '运行中', closed: '已退出', missing: '未启动' };

function LspStatus({ file, report }: { file: HistoryEntry; report: (text: string) => void }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const indicator = useRef<HTMLDivElement>(null);
  useEffect(() => services?.subscribe(rerender), []);
  const options = serviceFor(file);
  useEffect(() => {
    if (!indicator.current?.checkVisibility()) return;
    const message = options && services?.takeMessage(options);
    if (message) report(message.text);
  });
  const status = options && services?.status(options);
  if (!options || !status) return null;
  return <div className="editor-lsp-wrap" ref={indicator}>
    <button className={`editor-icon editor-lsp ${status.state}`} type="button" aria-label={`语言服务：${status.server}`}
      onClick={() => void services?.restart(options)}>
      <span className="editor-lsp-dot" />
    </button>
    <div className="editor-lsp-detail" role="tooltip">
      <span className="editor-lsp-name">{status.server}</span>
      <span>{stateLabels[status.state]}</span>
      {status.root && <span>{status.root}</span>}
      {status.error && <span>{status.error}</span>}
      {status.log && <span>{status.log}</span>}
      <span>{status.state === 'missing' ? '点击重试' : '点击重启这个服务'}</span>
    </div>
  </div>;
}

const lspPosition = (view: EditorView): LspPosition => {
  const at = cursorPosition(view.state);
  return { line: at.line - 1, character: at.column - 1 };
};

const bufferUpdate = Annotation.define<boolean>();

// Store a fraction so the page keeps its relative width when the pane resizes.
const widthKey = 'editor-page-width';
const minPageWidth = 200;
const keptShare = () => {
  const kept = Number(localStorage.getItem(widthKey));
  return kept > 0 && kept <= 1 ? kept : 1;
};

function EditorPage({ context, file, opened, peeking, navigate, report, preview }: { context: UiContext; file: HistoryEntry; opened: OpenFile; peeking: boolean; navigate: Navigate; report: (text: string) => void; preview: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const dragged = useRef({ at: 0, width: 0 });
  const control = useRef<EditorView>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: LocationAction[]; at: LspPosition }>();
  const [places, setPlaces] = useState<{ title: string; targets: Target[]; departure: HistoryEntry }>();
  const key = fileKey(file);
  const options = useMemo(() => serviceFor(file), [key]);
  const [session, setSession] = useState(() => options && services?.session(options));
  // Reconfigure the server in place to preserve editor history and in-progress input.
  const server = useMemo(() => new Compartment(), []);
  const previewComp = useMemo(() => new Compartment(), []);
  const previewExtension = useMemo(() => preview ? markdownPreview(context, file) : [], [preview, context, key]);
  // A replacement session needs a new extension even when the file stays open.
  const link = useMemo(() => (options && services ? services.extension(options, () => opened.buffer.text!) : []), [options, session, opened]);
  useEffect(() => {
    const running = services;
    if (!options || !running) return;
    void running.open(options);
    setSession(running.session(options));
    return running.subscribe(() => setSession(running.session(options)));
  }, [options]);
  // View callbacks outlive individual history entries for the same file.
  const shown = useRef(file);
  useLayoutEffect(() => { shown.current = file; }, [file]);
  const jumpFrom = (departure: HistoryEntry, target: Target) => {
    navigate({ type: 'file', machine: departure.machine, ...target }, departure);
  };
  const goAt = async ({ feature, title }: LocationAction, at: LspPosition) => {
    const view = control.current;
    if (!view || !options || !services) return;
    const departure = { ...shown.current, line: at.line + 1, column: at.character + 1, top: view.scrollDOM.scrollTop };
    const found = await services.locations(options, at, feature);
    if (control.current !== view) return;
    if (feature === 'references' || found.length > 1) {
      setPlaces(found.length ? { title, targets: found, departure } : undefined);
      return;
    }
    if (found[0]) jumpFrom(departure, found[0]);
  };
  useEffect(() => {
    const colours = new Compartment();
    opened.takeChanges();
    const view = new EditorView({
      state: EditorState.create({
        doc: opened.buffer.text,
        extensions: [
          colours.of(editorTheme(context.host.config, file.path)),
          ...chrome,
          opened.history,
          modeFor(file.path),
          server.of(link),
          previewComp.of(previewExtension),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) Object.assign(shown.current, cursorPosition(update.state));
            for (const tr of update.transactions) if (tr.docChanged && !tr.annotation(bufferUpdate)) opened.edit(tr);
          }),
        ],
      }),
      parent: element.current!,
    });
    control.current = view;
    const scrolled = () => { shown.current.top = view.scrollDOM.scrollTop; };
    view.scrollDOM.addEventListener('scroll', scrolled, { passive: true });
    // Register Vim actions when the view is built so they work on its first keystroke.
    pageKeys.set(view, { jump: (act) => void goAt(act, lspPosition(view)), say: report });
    const offTheme = context.global.subscribe<Theme>('theme', (next) => {
      view.dispatch({ effects: colours.reconfigure(editorTheme(context.host.config, file.path, next)) });
    });
    return () => {
      pageKeys.delete(view); offTheme();
      view.scrollDOM.removeEventListener('scroll', scrolled);
      view.destroy();
      control.current = undefined;
    };
  }, [context, file.path, opened, report]);

  useLayoutEffect(() => {
    const view = control.current;
    if (!view) return;
    const changes = opened.takeChanges();
    if (changes && !changes.empty) view.dispatch({
      changes,
      annotations: [bufferUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  });
  useEffect(() => {
    const view = control.current;
    if (view && server.get(view.state) !== link) view.dispatch({ effects: server.reconfigure(link) });
  }, [server, link]);
  useEffect(() => {
    const view = control.current;
    if (view && previewComp.get(view.state) !== previewExtension) view.dispatch({ effects: previewComp.reconfigure(previewExtension) });
  }, [previewComp, previewExtension]);
  useEffect(() => {
    const view = control.current;
    if (view) return restorePosition(view, view.scrollDOM, file, 0);
  }, [file]);
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    const openMenu = (event: MouseEvent) => {
      const view = control.current;
      const at = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
      // The gutter, the empty space below the text, and the spacing between words are not places to ask about.
      if (!view || !session || at === null || !view.state.sliceDoc(at, at + 1).trim()) return;
      const entries = locationActions.filter(action => session.supports(action.feature));
      if (!entries.length) return;
      event.preventDefault();
      // Every entry asks the server about the cursor, so it goes where the click landed.
      view.dispatch({ selection: { anchor: at } });
      setMenu({ x: event.clientX, y: event.clientY, entries, at: lspPosition(view) });
    };
    host.addEventListener('contextmenu', openMenu);
    return () => host.removeEventListener('contextmenu', openMenu);
  }, [session]);
  // The search picker and Vim command line keep keyboard focus while typing.
  const focusEditor = () => { if (!peeking && !writing(document.activeElement)) control.current?.focus(); };
  useEffect(() => { focusEditor(); }, [peeking]);
  // A jump within the same file keeps the existing view, so restore focus when the overlay closes.
  const closePanels = () => {
    setMenu(undefined);
    setPlaces(undefined);
    const cm = control.current && getCM(control.current);
    // A server reply can move focus halfway through a Vim command.
    if (cm?.state.vim?.inputState.keyBuffer.length) Vim.handleKey(cm, '<Esc>', 'user');
    focusEditor();
  };
  // The host focuses the plugin root first when its global shortcut shows this tab.
  useEffect(() => {
    const page = pageOf(element.current);
    if (!page) return;
    page.addEventListener('wangcai:shown', focusEditor);
    return () => page.removeEventListener('wangcai:shown', focusEditor);
  }, [peeking]);
  // Leaving the editor through the host must also leave Vim insert mode.
  useEffect(() => {
    const page = pageOf(element.current);
    if (!page) return;
    const leaveInsert = () => {
      const view = control.current;
      const cm = view && getCM(view);
      // Keep the cursor at its insertion position when returning focus to the host.
      if (cm) Vim.exitInsertMode(cm as CodeMirrorV, true);
    };
    page.addEventListener('focus', leaveInsert);
    return () => page.removeEventListener('focus', leaveInsert);
  }, []);
  // Cap the content width while keeping the scrollbar at the pane edge.
  const room = () => Math.max(0, row.current!.clientWidth - divider.current!.offsetWidth);
  const pageWidth = () => parseFloat(row.current!.style.getPropertyValue('--page-width'));
  const paint = (width: number) => {
    const painted = Math.min(room(), Math.max(minPageWidth, Math.round(width)));
    const gutter = element.current!.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0;
    row.current!.style.setProperty('--page-width', `${painted}px`);
    row.current!.style.setProperty('--content-width', `${Math.max(0, painted - gutter)}px`);
    divider.current!.setAttribute('aria-valuemin', String(minPageWidth));
    divider.current!.setAttribute('aria-valuemax', String(room()));
    divider.current!.setAttribute('aria-valuenow', String(painted));
  };
  const resize = (width: number) => {
    paint(width);
    localStorage.setItem(widthKey, String(pageWidth() / room()));
  };
  useLayoutEffect(() => {
    if (!preview) {
      row.current!.style.removeProperty('--page-width');
      row.current!.style.removeProperty('--content-width');
      return;
    }
    const paintKept = () => paint(keptShare() * room());
    paintKept();
    const observer = new ResizeObserver(paintKept);
    observer.observe(row.current!);
    // The gutter can mount after this effect. Observe it once it exists.
    const watchGutter = () => {
      const gutter = element.current!.querySelector('.cm-gutters');
      if (gutter) { observer.observe(gutter); mo.disconnect(); }
    };
    const mo = new MutationObserver(watchGutter);
    mo.observe(element.current!, { childList: true, subtree: true });
    watchGutter();
    return () => { mo.disconnect(); observer.disconnect(); };
  }, [preview]);
  return <>
    <div className={`editor-page-row${preview ? ' previewing' : ''}`} ref={row}>
      <div className="editor-code" ref={element} />
      {preview && <div className="editor-divider" ref={divider} role="separator" aria-label="调整渲染宽度" aria-orientation="vertical" tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragged.current = { at: event.clientX, width: pageWidth() };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(dragged.current.width + event.clientX - dragged.current.at);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          resize(pageWidth() + (event.key === 'ArrowRight' ? 20 : -20));
        }} />}
    </div>
    {menu && <Overlay className="code-menu" role="menu" label="语言服务" at={{ left: menu.x, top: menu.y }} onClose={closePanels}>
      {menu.entries.map(action => <button key={action.feature} role="menuitem"
        onClick={() => {
          closePanels();
          void goAt(action, menu.at);
        }}>{action.label}</button>)}
    </Overlay>}
    {places && <Overlay className="lsp-places" role="dialog" label={places.title} onClose={closePanels}>
      {places.targets.map((target) => <button key={`${target.path}:${target.line}:${target.column}`} className="lsp-place"
        onClick={() => { closePanels(); jumpFrom(places.departure, target); }}>
        <span className="lsp-place-file">{target.path.slice(target.path.lastIndexOf('/') + 1)}</span>
        <span className="lsp-place-at">{target.line}:{target.column}</span>
      </button>)}
    </Overlay>}
  </>;
}

function FileView({ context, file, navigate, back, forward, openSearch, peeking, onRead }: PageProps & { peeking: boolean; onRead: (key: string) => void }) {
  const [opened, setOpened] = useState<OpenFile>();
  const buffer = opened?.buffer;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [notice, report] = useNotice();
  const markdown = languageOf(file.path) === 'markdown';
  const [preview, setPreview] = useState(markdown);

  const key = fileKey(file);
  useLayoutEffect(() => {
    const opened = openBuffer(file, (message) => {
      if (message !== undefined) report(message);
      redraw();
    });
    setOpened(opened);
    return () => { void opened.close(); };
  }, [key, report]);
  const readSettled = buffer?.text !== undefined || !!buffer?.readError;
  useEffect(() => {
    if (readSettled) onRead(key);
  }, [readSettled, key, onRead]);
  return <section className="editor" aria-label="编辑器">
    <Navigation context={context} file={file} navigate={navigate} back={back} forward={forward} openSearch={openSearch} dirty={buffer?.dirty ?? false}
      markdown={markdown} preview={preview} togglePreview={() => setPreview((on) => !on)}
      refresh={() => buffer?.read()} report={report} lsp={<LspStatus file={file} report={report} />} />
    <div className="editor-main">
      <Notice text={(buffer?.text !== undefined && buffer.readError) || notice} />
      {opened && opened.buffer.text !== undefined
        ? <EditorPage context={context} file={file} opened={opened} peeking={peeking} navigate={navigate} report={report} preview={preview} />
        : <div className="file-message" role={buffer?.readError ? 'alert' : undefined}>{buffer?.readError || '正在读取…'}</div>}
    </div>
  </section>;
}

function EmptyPage({ context, base, navigate, loading, workspaceError }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; loading: boolean; workspaceError: string }) {
  const [notice, report] = useNotice();
  return <section className="editor" aria-label="编辑器">
    <header className="editor-header">
      <Address context={context} base={base} navigate={navigate} report={report} />
    </header>
    <Notice text={notice} />
    <div className="file-message" role={workspaceError ? 'alert' : undefined}>
      {workspaceError || (loading ? '正在读取…' : base ? '在 files 里点一个文件，或者在这里输入路径' : '请选择一个已连接的终端')}
    </div>
  </section>;
}

// Search can preview a file while the history still points to the visited entry.
function Body({ context, navigate, back, forward, openSearch, workspaceId, file, comparison, read, onRead, visited, searching, closeSearch, peek, accept, restoreFocus }: Omit<PageProps, 'file'> & {
  workspaceId?: string; file?: HistoryEntry; comparison?: GitUri; read: boolean; onRead: (key: string) => void; visited?: HistoryEntry;
  searching: boolean; closeSearch: () => void; peek: (file: FileClick) => void; accept: (file: FileClick) => void; restoreFocus: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceEntry, setWorkspaceEntry] = useState<FileClick>();
  useEffect(() => {
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setWorkspaceError(''); setLoading(value !== null);
      if (!value) { setWorkspaceEntry(undefined); return; }
      void context.ui.request<FileClick>('resolve', value)
        .then((resolved) => { if (alive && id === request) { setWorkspaceEntry(resolved); setLoading(false); } })
        .catch((problem: Error) => { if (alive && id === request) { setWorkspaceEntry(undefined); setLoading(false); setWorkspaceError(problem.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId]);
  const key = file && fileKey(file);
  useLayoutEffect(restoreFocus, [key, restoreFocus]);
  if (!file) return <EmptyPage context={context} base={workspaceEntry} navigate={navigate} loading={loading} workspaceError={workspaceError} />;
  return <div className={searching && !comparison ? 'editor-body searching' : 'editor-body'}>
    {comparison
      ? <DiffView key={key} context={context} file={file} uri={comparison} navigate={navigate} back={back} forward={forward} />
      : <FileView key={key} context={context} file={file} navigate={navigate} back={back} forward={forward} openSearch={openSearch} peeking={searching} onRead={onRead} />}
    {visited && searching && !comparison && <Search context={context} services={services} visited={visited} workspace={workspaceEntry} visitedReady={read && key === fileKey(visited)} peek={peek} navigate={accept} close={closeSearch} />}
  </div>;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === identity.id) openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const key = workspaceId ?? '';
  const history = histories.get(key) ?? { entries: [], index: -1 };
  histories.set(key, history);
  const view: { searching: boolean; preview?: { location: string; entry: HistoryEntry } } = { searching: false };
  const showing = () => view.preview?.entry ?? history.entries[history.index];
  const push = (file: HistoryEntry, commitPreview = false) => {
    const standing = history.entries[history.index];
    const same = standing && fileKey(standing) === fileKey(file) && standing.type === file.type && (standing.side ?? 'b') === (file.side ?? 'b');
    if (same && (file.line === undefined || (file.line === (standing.line ?? 1) && (file.column ?? 1) === (standing.column ?? 1)))) {
      // Reopening a path keeps its view. A named destination still places the cursor in the existing history slot.
      if (file.line === undefined && !commitPreview) return;
      history.entries[history.index] = file;
    } else {
      history.entries = [...history.entries.slice(0, history.index + 1), file];
      history.index++;
      const over = history.entries.length - historyCeiling;
      if (over > 0) { history.entries = history.entries.slice(over); history.index -= over; }
    }
    saveHistory(context);
  };
  if (file) push(file);
  context.host.tabs({ ...identity, workspaceId, onClose() {
    for (const [savedKey, saved] of histories) if (saved === history) histories.delete(savedKey);
    saveHistoryNow(context);
    pages.delete(history);
    void services?.closeUnused();
  }, mount(container: HTMLElement) {
    container.style.fontFamily = context.host.config.font.family;
    const mounted = createRoot(container);
    // Navigation clears the search preview unless the caller is moving its selection.
    const show = (next: Partial<typeof view> = {}) => {
      Object.assign(view, { searching: false, preview: undefined }, next);
      render();
    };
    const navigate: Navigate = (file, departure) => {
      if (file.type === 'directory') {
        void context.global.publish('onclick', file);
        return;
      }
      if (departure) push(departure);
      push(file);
      show();
    };
    const openSearch = () => { const cur = showing(); if (cur && parseGitUri(cur.path)) return; show({ searching: true }); };
    const closeSearch = () => show();
    // The editor updates the preview entry's cursor and scroll while the result still points at its original location.
    const peek = (file: FileClick) => show({ searching: true, preview: { location: searchLocationKey(file), entry: file } });
    const accept = (file: FileClick) => {
      const preview = view.preview;
      const matches = preview !== undefined && preview.location === searchLocationKey(file);
      push(matches ? preview.entry : file, matches);
      show();
    };
    const step = (by: number) => {
      history.index += by;
      saveHistory(context);
      show();
    };
    const canStep = (by: number) => history.entries[history.index + by] !== undefined;
    // The host must receive these shortcuts even when Vim is in insert mode.
    const keys = [
      { keys: '<C-f>', insert: true, run: () => { if (showing()) openSearch(); } },
      { keys: '<C-o>', insert: true, run: () => { if (canStep(-1)) step(-1); } },
      { keys: '<C-i>', insert: true, run: () => { if (canStep(1)) step(1); } },
    ];
    const unbindKeys = bindKeys(container, keys, { ignore: (event) => event.defaultPrevented || writing(event.target) });
    // Only the visible tab can answer the host’s cursor query.
    const offCursor = context.ui.subscribe<{ nonce: number }>('cursor-query', ({ nonce }) => {
      const file = showing();
      if (!file || file.type !== 'file' || !container.checkVisibility()) return;
      void context.ui.request('cursor-reply', {
        nonce, cursor: { type: 'file', machine: file.machine, path: file.path, line: file.line ?? 1, column: file.column ?? 1 },
      });
    });
    let renderedKey: string | undefined;
    let read = false;
    const page: MountedPage = { navigate };
    const onRead = (key: string) => {
      if (key !== renderedKey || read) return;
      read = true;
      if (page.serviceFile) page.serviceFile.reading = false;
      render();
      void services?.closeUnused();
    };
    let hadFocus = false;
    const restoreFocus = () => {
      // Removing a focused editor puts the keyboard on the body while the next file is loading.
      if (hadFocus && document.activeElement === document.body && container.checkVisibility()) container.focus({ preventScroll: true });
      hadFocus = false;
    };
    const render = () => {
      const file = showing();
      const key = file && fileKey(file);
      const comparison = file && parseGitUri(file.path);
      if (key !== renderedKey) {
        hadFocus = !view.searching && container.contains(document.activeElement);
        renderedKey = key;
        read = false;
        const options = file?.type === 'file' && !comparison && serviceFor(file);
        page.serviceFile = options ? { ...options, reading: true } : undefined;
        void services?.closeUnused();
      }
      mounted.render(<Body context={context} navigate={navigate}
        back={canStep(-1) ? () => step(-1) : undefined} forward={canStep(1) ? () => step(1) : undefined}
        openSearch={openSearch} workspaceId={workspaceId} file={file} comparison={comparison} read={read} onRead={onRead} visited={history.entries[history.index]}
        searching={view.searching} closeSearch={closeSearch} peek={peek} accept={accept} restoreFocus={restoreFocus} />);
    };
    pages.set(history, page);
    return { onSelect: render, dispose: () => { pages.delete(history); mounted.unmount(); unbindKeys(); offCursor(); } };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const offTheme = trackTheme(context);
  openBuffer = fileBuffers(context);
  services = new LanguageServices(context, () => [...pages.values()].flatMap(page => page.serviceFile ? [page.serviceFile] : []));
  for (const [key, history] of Object.entries(await context.ui.request<Record<string, History>>('history'))) histories.set(key, history);
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
    activeWorkspaceId = value?.workspaceId;
    // The shell moves unscoped tabs into the first selected workspace.
    const unassigned = histories.get('');
    if (activeWorkspaceId !== undefined && unassigned) {
      histories.delete('');
      histories.set(activeWorkspaceId, unassigned);
      saveHistory(context);
    }
  });
  void context.global.publish('workspace:query', null);
  // External file clicks reuse the workspace tab when it is already mounted.
  const off = context.global.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'file') return;
    const history = histories.get(activeWorkspaceId ?? '');
    const page = history && pages.get(history);
    if (page) page.navigate(file);
    else openTab(context, activeWorkspaceId, file);
    void context.global.publish('core:show-view', { plugin: identity.id });
  });
  return () => {
    offActive(); offTheme();
    off();
    saveHistoryNow(context);
    histories.clear();
    pages.clear();
    services?.dispose();
    services = undefined;
  };
}
