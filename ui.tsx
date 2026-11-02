import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import fuzzysort from 'fuzzysort';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { LanguageServices, type FileSymbol, type LocationFeature, type ServiceStatus, type Target } from './lsp';
import { languageOf, modeFor } from './mode';
import { editorTheme } from './theme';
import { machineKey, type FileClick, type Font, type History, type HistoryEntry, type OpenOptions, type Position, type SearchHit, type Settings } from './shared';
import './style.css';

// What the tab is called, and the id the window remembers it by when it opens it again.
const identity = { id: 'editor', title: '编辑器' };
export const title = identity.title;
let activeWorkspaceId: string | undefined;
let font: Font;
// What every file is read with: the vim keys over a text nobody writes, in the window's own colours. It is built once, in
// mount(), and every view shares it.
let chrome: Extension[] = [];
let services: LanguageServices | undefined;
const histories = new Map<string, History>();

// A jump's target as the visit that lands on it, on the machine the file it was answered for lives on.
const visit = (target: Target, machine: FileClick['machine']): FileClick =>
  ({ type: 'file', machine, path: target.path, line: target.line, column: target.column });
// The places a tab has jumped through, and where in them it stands.
type Jumps = { entries: Target[]; index: number };
// What the jump keys of the normal mode ask of the view that holds the keyboard: the vim layer knows no editor of ours,
// so the view is looked up from the one the key arrived in and asked the question the key stands for.
const jumpKeys = new Map<EditorView, (act: LocationFeature) => void>();

// The keys the normal mode answers by our own actions: the key, and the question it asks the view.
const vimCommands: [keys: string, act: LocationFeature][] = [
  ['gd', 'definition'],
  ['gi', 'implementation'],
  ['gr', 'references'],
];

// The jump keys are defined once for the whole window, not per view.
for (const [keys, act] of vimCommands) {
  const name = `wangcai-${act}`;
  Vim.defineAction(name, (cm) => {
    const view = (cm as unknown as { cm6?: EditorView }).cm6;
    if (view) jumpKeys.get(view)?.(act);
  });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
}

// A file this plugin reads as no language is nobody's to serve.
const serviceFor = (file: FileClick): OpenOptions | undefined => {
  const language = languageOf(file.path);
  return language ? { machine: file.machine, path: file.path, language } : undefined;
};

const watch = (context: UiContext, machine: FileClick['machine'], holder: string, paths: string[], act: (path: string) => void) => {
  // The plugin can be disposed before either request lands, and the machine can be gone; neither is worth a pageerror.
  void context.ui.request('watch', { holder, machine, paths }).catch(() => undefined);
  const off = context.ui.subscribe<string>('changed', (path) => { if (paths.includes(path)) act(path); });
  return () => { off(); void context.ui.request('watch', { holder, machine, paths: [] }).catch(() => undefined); };
};

type Remember = (entry: HistoryEntry, at: Partial<Position>) => void;
type NavigationProps = { context: UiContext; file: HistoryEntry; navigate: (file: FileClick) => void; refresh: () => void; back?: () => void; forward?: () => void; openSearch: () => void };
// A place in a file, counted from zero the way a server is asked about it.
type Place = { line: number; character: number };

// The address box: what is typed is resolved against the directory the tab is on, and the entry it names is opened.
function Address({ context, base, navigate, report }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; report: (message: string) => void }) {
  const [path, setPath] = useState(base?.path ?? '');
  const request = useRef(0);
  useEffect(() => { setPath(base?.path ?? ''); return () => { request.current++; }; }, [base?.path]);
  return <form className="editor-address" onSubmit={(event) => {
    event.preventDefault();
    if (!base || !path.trim()) return;
    const id = ++request.current;
    report('');
    const at = base.type === 'directory' ? base.path : base.path.slice(0, base.path.lastIndexOf('/')) || '/';
    void context.ui.request<FileClick>('resolve', { machine: base.machine, path: path.trim(), base: at })
      .then((file) => { if (id === request.current) navigate(file); })
      .catch((problem: Error) => { if (id === request.current) report(problem.message); });
  }}>
    <input className="editor-path" aria-label="路径" title={base?.path ?? ''} value={path} spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => { request.current++; setPath(event.target.value); report(''); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { request.current++; setPath(base?.path ?? ''); report(''); } }} />
  </form>;
}

// The row on top of the page, said once for a file and for an empty tab.
function Header({ children }: { children: ReactNode }) {
  return <header className="editor-header">{children}</header>;
}

const stateLabels: Record<ServiceStatus['state'], string> = { connecting: '正在启动', open: '运行中', closed: '已退出', missing: '未启动' };

// The dot in the header for this file's language service: hovering names the service and how it is doing, and clicking it
// starts the server behind the file, or starts it again when one was running.
function LspStatus({ file }: { file: HistoryEntry }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [hover, setHover] = useState(false);
  useEffect(() => services?.subscribe(rerender), []);
  const options = serviceFor(file);
  const status = options && services?.status(options);
  if (!options || !status) return null;
  return <div className="editor-lsp-wrap" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className={`editor-icon editor-lsp ${status.state}`} type="button" aria-label={`语言服务：${status.server}`}
      onClick={() => void services?.restart(options)}>
      <span className="editor-lsp-dot" />
    </button>
    {hover && <div className="editor-lsp-detail" role="tooltip">
      <span className="editor-lsp-name">{status.server}</span>
      <span>{stateLabels[status.state]}</span>
      {status.root && <span>{status.root}</span>}
      {status.error && <span>{status.error}</span>}
      {status.log && <span>{status.log}</span>}
      <span>{status.state === 'missing' ? '点击重试' : '点击重启这个服务'}</span>
    </div>}
  </div>;
}

function Navigation({ context, file, navigate, refresh, back, forward, openSearch }: NavigationProps) {
  const [error, setError] = useState('');
  return <>
    <Header>
      <button className="editor-icon" aria-label="后退" title="后退" disabled={!back} onClick={back}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 2 8l5 5 M2 8h12" /></svg>
      </button>
      <button className="editor-icon" aria-label="前进" title="前进" disabled={!forward} onClick={forward}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3 5 5-5 5 M2 8h12" /></svg>
      </button>
      <button className="editor-icon" aria-label="刷新" title="刷新" onClick={refresh}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 6.7A5.3 5.3 0 1 0 12 12 M13.3 2.7v4h-4" /></svg>
      </button>
      <Address context={context} base={file} navigate={navigate} report={setError} />
      <LspStatus file={file} />
      <button className="editor-icon" aria-label="搜索" title="搜索" onClick={openSearch}>
        <Glass />
      </button>
    </Header>
    {error && <div className="file-message" role="alert">{error}</div>}
  </>;
}

// The menu a right click opens: the location features, which the server's own capabilities decide the width of.
const lspMenu: { feature: LocationFeature; label: string }[] = [
  { feature: 'definition', label: '转到定义' },
  { feature: 'implementation', label: '转到实现' },
  { feature: 'typeDefinition', label: '转到类型定义' },
  { feature: 'references', label: '查找引用' },
];

// The line an offset sits on, and how far into it, which is what a visit is remembered by.
const positionOf = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
};
// The same caret as a `Place`.
const placeOf = (view: EditorView) => {
  const at = positionOf(view);
  return { line: at.line - 1, character: at.column - 1 };
};

// A panel laid over the text it is about: the backdrop under it takes the click that closes it, and its first row takes the
// keyboard wherever the focus was, so Escape reaches the panel and Enter opens what the row names.
function Overlay({ className, role, label, at, onClose, children }: {
  className: string; role: 'menu' | 'dialog'; label: string; at?: CSSProperties; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector('button')?.focus(); }, []);
  return <>
    <div className="editor-backdrop" onClick={onClose} />
    <div ref={panel} className={className} role={role} aria-label={label} style={at}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      {children}
    </div>
  </>;
}

function EditorPage({ file, text, remember, peeking, navigate, jumps }: { file: HistoryEntry; text: string; remember: Remember; peeking: boolean; navigate: (file: FileClick) => void; jumps: Jumps }) {
  const element = useRef<HTMLDivElement>(null);
  const control = useRef<EditorView>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: typeof lspMenu; at: Place }>();
  const [references, setReferences] = useState<Target[]>();
  // What this page asks a server about, made once: a new path or machine is a new page, so this value holds for the mount.
  const options = useMemo(() => serviceFor(file), [file.machine, file.path]);
  // The server this file speaks to. What asks for it to be replaced is the dot or the revival behind it, never the view.
  const [session, setSession] = useState(() => options && services?.session(options));
  // The file is opened on its server once, and then follows it.
  useEffect(() => {
    const running = services;
    if (!options || !running) return;
    void running.open(options);
    setSession(running.session(options));
    return running.subscribe(() => setSession(running.session(options)));
  }, [options]);
  // A jump from the caret: it lands where it is asked to, and leaves the place it started from and the one it landed on in
  // the tab's list. A jump made after going back starts that list over, and it never stops twice in one place.
  const jumpFrom = (target: Target) => {
    const view = control.current;
    if (!view) return;
    const at = positionOf(view);
    jumps.entries.length = jumps.index + 1;
    for (const entry of [{ path: file.path, line: at.line, column: at.column }, target]) {
      const last = jumps.entries[jumps.entries.length - 1];
      if (!last || last.path !== entry.path || last.line !== entry.line || last.column !== entry.column) jumps.entries.push(entry);
    }
    jumps.index = jumps.entries.length - 1;
    navigate(visit(target, file.machine));
  };
  // One of the questions the menu and the keys ask about a place in this file: the list of references is shown rather than
  // followed, since it names more than one place, and every other answer is a jump.
  const goAt = async (feature: LocationFeature, at: Place) => {
    if (!options || !services) return;
    const found = await services.locations(options, at.line, at.character, feature);
    // What the list would show belongs to this question alone: a question that found nothing leaves no list behind.
    if (feature === 'references') { setReferences(found.length ? found : undefined); return; }
    if (found[0]) jumpFrom(found[0]);
  };
  // The entry the view shows now: it outlives the entry it was built for, so what its callbacks record reads from here.
  const shown = useRef(file);
  useEffect(() => { shown.current = file; });
  // The view is built again for a new text and for a new server behind the file, and never for a jump inside the file: a
  // restart swaps `session` while `options` stays the same, so the server is what this is watched by. Hover and diagnostics
  // are the server's too, and a view tied to the old one answers nothing.
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          ...chrome,
          modeFor(file.path),
          options && services ? services.extension(options) : [],
          EditorView.updateListener.of((update) => { if (update.selectionSet) remember(shown.current, positionOf(update.view)); }),
        ],
      }),
      parent: element.current!,
    });
    control.current = view;
    const scrolled = () => remember(shown.current, { top: view.scrollDOM.scrollTop });
    view.scrollDOM.addEventListener('scroll', scrolled, { passive: true });
    // The normal mode's jump keys ask what the menu asks, and are handed over as the view is built: a key pressed as soon as
    // the file appears finds its answer instead of waiting for a later render.
    jumpKeys.set(view, (act) => void goAt(act, placeOf(view)));
    return () => {
      jumpKeys.delete(view);
      view.scrollDOM.removeEventListener('scroll', scrolled);
      view.destroy();
      control.current = undefined;
    };
  }, [text, remember, session, file.path]);
  // Where the view sits: the offset the file was left at, or else the line the entry was opened at. A view that was built
  // again starts at its own top, so the offset is taken for it once more; a panel that has given it no height yet places
  // it on a later frame. That offset is read once per view, so what this runs for is the changes that build one.
  const placement = useRef<{ view: EditorView; offset?: number }>(undefined);
  useEffect(() => {
    const view = control.current;
    if (!view) return;
    if (placement.current?.view !== view) placement.current = { view, offset: file.top };
    const state = placement.current;
    let frames = 0;
    const place = () => {
      if (!view.dom.clientHeight) return false;
      if (state.offset !== undefined) {
        view.scrollDOM.scrollTop = state.offset;
        // A view that has only measured the screenful it starts with cannot scroll that far yet, so it is asked again on
        // a later frame; one that still cannot after a second has been shown a shorter text than it was left at.
        if (Math.abs(view.scrollDOM.scrollTop - state.offset) > 1 && frames < 60) return false;
        state.offset = undefined;
        return true;
      }
      if (file.line === undefined) return true;
      // A line past the end of the text and a column past the end of its line both come back to the last one there is.
      const row = view.state.doc.line(Math.min(file.line, view.state.doc.lines));
      const at = Math.min(row.from + (file.column ?? 1) - 1, row.to);
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
      return true;
    };
    if (place()) return;
    let frame = requestAnimationFrame(function again() {
      frames += 1;
      if (!place()) frame = requestAnimationFrame(again);
    });
    return () => cancelAnimationFrame(frame);
  }, [file.line, file.column, text, session]);
  // A right click asks this plugin's menu instead of the browser's: the entries are the features the server answers.
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    const openMenu = (event: MouseEvent) => {
      const view = control.current;
      const at = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
      // The gutter, the empty space below the text, and the spacing between words are not places to ask about.
      if (!view || !session || at === null || !view.state.sliceDoc(at, at + 1).trim()) return;
      const entries = lspMenu.filter(({ feature }) => session.supports(feature));
      if (!entries.length) return;
      event.preventDefault();
      // Every entry asks the server about the cursor, so it goes where the click landed.
      view.dispatch({ selection: { anchor: at } });
      setMenu({ x: event.clientX, y: event.clientY, entries, at: placeOf(view) });
    };
    host.addEventListener('contextmenu', openMenu);
    return () => host.removeEventListener('contextmenu', openMenu);
  }, [session]);
  // The keyboard belongs in the editor, unless the page is only showing what a picker's selection stands for, where
  // taking it would end the name being typed.
  const focusEditor = () => { if (!peeking) control.current?.focus(); };
  // The keyboard is handed over again for each thing that changes who should have it: a peek takes it and gives it back, and
  // a view built again is a new one to hand it to — so the list below is the peeking, the text and the server.
  useEffect(() => { focusEditor(); }, [peeking, text, session]);
  // A key that shows this view leaves the keyboard on the plugin's page rather than in the editor, so the page hands it
  // over when it hears that it was shown — a listener here, since the page's focus alone does not say who shows it.
  useEffect(() => {
    const page = element.current?.closest<HTMLElement>('[data-plugin]');
    if (!page) return;
    page.addEventListener('wangcai:shown', focusEditor);
    return () => page.removeEventListener('wangcai:shown', focusEditor);
  }, [peeking]);
  return <>
    <div className="editor-code" ref={element} />
    {menu && <Overlay className="code-menu" role="menu" label="语言服务" at={{ left: menu.x, top: menu.y }} onClose={() => setMenu(undefined)}>
      {menu.entries.map(({ feature, label }) => <button key={feature} role="menuitem"
        onClick={() => {
          setMenu(undefined);
          void goAt(feature, menu.at);
        }}>{label}</button>)}
    </Overlay>}
    {references && <Overlay className="lsp-references" role="dialog" label="引用" onClose={() => setReferences(undefined)}>
      {references.map((target) => <button key={`${target.path}:${target.line}:${target.column}`} className="lsp-reference"
        onClick={() => { setReferences(undefined); jumpFrom(target); }}>
        <span>{target.path.slice(target.path.lastIndexOf('/') + 1)}</span>
        <span className="lsp-reference-at">{target.line}:{target.column}</span>
      </button>)}
    </Overlay>}
  </>;
}

// The box a tab draws in.
function Shell({ children }: { children: ReactNode }) {
  return <section className="editor" aria-label="编辑器">{children}</section>;
}

function FileView(props: NavigationProps & { holder: string; remember: Remember; peeking: boolean; jumps: Jumps }) {
  const { context, file, holder, navigate, refresh, back, forward, remember, peeking, openSearch, jumps } = props;
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  // A file is read again when the path it names changes, not when the cursor moves inside it.
  useEffect(() => {
    let alive = true;
    setText(undefined); setError('');
    const read = () => {
      void context.ui.request<string>('read', file).then((text) => { if (alive) { setText(text); setError(''); } })
        .catch((error: Error) => { if (alive) setError(error.message); });
    };
    const stop = watch(context, file.machine, holder, [file.path], read);
    read();
    return () => { alive = false; stop(); };
  }, [context, holder, file.path]);
  return <Shell>
    <Navigation context={context} file={file} navigate={navigate} refresh={refresh} back={back} forward={forward} openSearch={openSearch} />
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : <EditorPage file={file} text={text} remember={remember} peeking={peeking} navigate={navigate} jumps={jumps} />}
  </Shell>;
}

// How many rows the page draws of a search's answer.
const rowLimit = 200;
// How well a match has to score to be listed: the query in a run scores .7 and up, its letters scattered around .3.
const matchThreshold = 0.6;

// What the picker looks for: a file's path, a pattern in the workspace's text, or a declaration in the file the tab is
// on. The first character of the query says which.
type SearchMode = 'files' | 'grep' | 'symbols';
const emptyMessage: Record<SearchMode, string> = {
  files: '没有匹配的文件', grep: '没有匹配的内容', symbols: '没有匹配的符号',
};

// A row of the picker: the texts it prints, the visit it stands for, and the characters a query marked in each — the
// title's in `marks`, the detail's in `detailMarks`.
type SearchRow = { key: string; title: string; detail?: string; target: FileClick; marks?: ReadonlyArray<number>; detailMarks?: ReadonlyArray<number> };

// The magnifier, drawn on the header's button and in the picker's row: one glyph, whose size and colour come from where it
// is drawn.
const Glass = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 4 4" /></svg>
);

// A text with the characters at those indexes marked, so a row shows why it is on the list. The indexes count UTF-16
// code units, as fuzzysort reports them, and neighbouring ones share a node: a hit is one block behind the text it
// matched, however far apart the hits of one match are, and a character spelled by two units, such as an emoji, stays in
// one piece. A text with nothing marked is handed back whole.
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

// The path a row prints, with the directory the search started at taken off.
const shownPath = (directory: string, path: string) => path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path;

// The search picker: the rows it finds under its input, with the page following the row under the selection, so what a row
// stands for is seen before Enter opens it.
function Search({ context, visited, workspace, peek, navigate, close }: { context: UiContext; visited: HistoryEntry; workspace: string; peek: (file: FileClick) => void; navigate: (file: FileClick) => void; close: () => void }) {
  const [query, setQuery] = useState('');
  // A row is chosen by the user or not at all: until one is, the selection marks the row of the entry the tab is on and
  // nothing is followed, so opening the picker does not take the reader away from what they were reading.
  const [chosen, setChosen] = useState<number>();
  // Each source's latest answer, with `undefined` for having none to draw: none has arrived yet, or the query was emptied.
  // An answer stays on show while the next one is on its way.
  const [files, setFiles] = useState<string[]>();
  const [matches, setMatches] = useState<SearchHit[]>();
  const [symbols, setSymbols] = useState<FileSymbol[]>();
  // The message the picker shows, tagged with the source it speaks for: the search that wrote it may have been left
  // behind.
  const [status, setStatus] = useState<{ mode: SearchMode; text: string }>();
  const clearStatus = (source: SearchMode) => setStatus((current) => (current?.mode === source ? undefined : current));
  const list = useRef<HTMLDivElement>(null);
  // Where a search starts: the workspace, or else the directory the tab's own entry sits in.
  const directory = workspace || visited.path.slice(0, visited.path.lastIndexOf('/')) || '/';
  const mode: SearchMode = query.startsWith('>') ? 'grep' : query.startsWith('@') ? 'symbols' : 'files';
  const needle = (mode === 'files' ? query : query.slice(1)).trim();
  // What this picker asks a server about, which changes with the machine and path `serviceFor` reads.
  const options = useMemo(() => serviceFor(visited), [visited.machine, visited.path]);
  useEffect(() => {
    let alive = true;
    void context.ui.request<string[]>('find-files', { machine: visited.machine, path: directory })
      .then((listed) => { if (alive) { setFiles(listed); clearStatus('files'); } })
      .catch((problem: Error) => { if (alive) { setFiles([]); setStatus({ mode: 'files', text: problem.message }); } });
    return () => { alive = false; };
  }, [context, visited.machine, directory]);
  // The symbols of the file the tab is on, which is the file a symbol row jumps into.
  useEffect(() => {
    if (mode !== 'symbols') return;
    if (!options || !services) { setSymbols([]); return; }
    let alive = true;
    void services.symbols(options).then((found) => { if (alive) setSymbols(found); });
    return () => { alive = false; };
  }, [mode, options]);
  const asked = useRef(0);
  useEffect(() => {
    // A reply is worth only the query that asked for it: every run of this takes the next id, so a reply that comes back
    // after the input moved on, to another pattern or out of grep or out of the input, is dropped.
    const id = ++asked.current;
    if (mode !== 'grep') return;
    if (!needle) { setMatches(undefined); clearStatus('grep'); return; }
    setStatus({ mode: 'grep', text: '正在搜索…' });
    // rg is asked once typing pauses: a key pressed mid-word would otherwise start a search for a pattern already gone.
    const timer = setTimeout(() => {
      void context.ui.request<SearchHit[]>('grep', { machine: visited.machine, path: directory, query: needle })
        .then((found) => {
          if (id !== asked.current) return;
          setMatches(found);
          clearStatus('grep');
        })
        .catch((problem: Error) => { if (id !== asked.current) return; setMatches([]); setStatus({ mode: 'grep', text: problem.message }); });
    }, 150);
    return () => clearTimeout(timer);
  }, [mode, needle, context, visited.machine, directory]);
  const { rows, answered } = useMemo<{ rows: SearchRow[]; answered: boolean }>(() => {
    if (mode === 'grep') {
      return {
        answered: matches !== undefined,
        rows: (matches ?? []).map((hit) => ({
          key: `${hit.path}:${hit.line}`, title: hit.text,
          detail: `${shownPath(directory, hit.path)}:${hit.line}`,
          target: visit(hit, visited.machine),
        })).slice(0, rowLimit),
      };
    }
    // The query is matched against the texts a row prints, in the order it prints them, so a marked character lands on the
    // character it matched: the title, then the detail of the rows that have one.
    const search = (candidates: SearchRow[]) => {
      if (!needle) return candidates.slice(0, rowLimit);
      const found = fuzzysort.go(needle, candidates, { keys: ['title', 'detail'], threshold: matchThreshold, limit: rowLimit });
      return found.map((one) => ({ ...one.obj, marks: one[0].indexes, detailMarks: one[1]?.indexes }));
    };
    if (mode === 'symbols') {
      return {
        answered: symbols !== undefined,
        rows: search((symbols ?? []).map((symbol) => ({
          key: `${symbol.line}:${symbol.column}`, title: symbol.name, detail: symbol.container,
          target: visit({ path: visited.path, line: symbol.line, column: symbol.column }, visited.machine),
        }))),
      };
    }
    return {
      answered: files !== undefined,
      rows: search((files ?? []).map((path) => ({
        key: path, title: shownPath(directory, path),
        target: { type: 'file' as const, machine: visited.machine, path },
      }))),
    };
  }, [mode, needle, directory, visited.machine, visited.path, files, matches, symbols]);
  const note = status?.mode === mode ? status.text : '';
  // The index of the row standing for the entry the tab is on, if the rows hold it.
  const current = rows.findIndex((row) => row.target.path === visited.path && (row.target.line === undefined || row.target.line === visited.line));
  // Rows arrive after the keystroke that asked for them, so the chosen one is kept within what is on show.
  const at = Math.min(chosen ?? Math.max(current, 0), Math.max(rows.length - 1, 0));
  useEffect(() => { list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' }); }, [at, rows]);
  // A name typed a letter at a time would otherwise read a file per letter, so the row under the selection is taken
  // once the selection rests.
  useEffect(() => {
    const target = rows[at]?.target;
    if (chosen === undefined || !target) return;
    const timer = setTimeout(() => peek(target), 120);
    return () => clearTimeout(timer);
  }, [chosen, at, rows]);
  return <div className="search-panel" role="dialog" aria-label="搜索">
    <div className="search-head">
      <Glass className="search-glass" />
      <input className="search-input" aria-label="搜索" autoFocus value={query} spellCheck={false} placeholder="搜索文件，> 搜内容，@ 列符号"
        onChange={(event) => { setQuery(event.target.value); setChosen(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Enter') { event.preventDefault(); const row = rows[at]; if (row) navigate(row.target); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setChosen(Math.min(at + 1, Math.max(rows.length - 1, 0))); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setChosen(Math.max(at - 1, 0)); }
        }} />
      <button className="search-close" type="button" aria-label="关闭搜索" title="关闭" onClick={close}>×</button>
    </div>
    {note && <div className="search-note" role="status">{note}</div>}
    <div className="search-list" ref={list}>
      {rows.map((row, index) => <button key={row.key} type="button" className="search-row" aria-current={index === at || undefined} onClick={() => navigate(row.target)} onMouseEnter={() => setChosen(index)}>
        <span className="search-title">{marked(row.title, row.marks)}</span>
        {row.detail && <span className="search-detail">{marked(row.detail, row.detailMarks)}</span>}
      </button>)}
      {answered && !rows.length && !note && <div className="file-message">{emptyMessage[mode]}</div>}
    </div>
  </div>;
}

// What a tab shows before a file is sent to it: the address box, which reads a path against the workspace, and the one
// line that says what the tab is waiting for — a failure, a read in flight, or where a file comes from.
function EmptyPage({ context, base, navigate, loading, error }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; loading: boolean; error: string }) {
  const [addressError, setAddressError] = useState('');
  return <Shell>
    <Header>
      <Address context={context} base={base} navigate={navigate} report={setAddressError} />
    </Header>
    <div className="file-message" role={addressError || error ? 'alert' : undefined}>
      {addressError || error || (loading ? '正在读取…' : base ? '在「文件」里点一个文件，或者在这里输入路径' : '请选择一个已连接的终端')}
    </div>
  </Shell>;
}

// The page a tab draws: the file on show with the search picker over it, or the empty page while no file has been sent
// here.
// `file` is what the page shows, which a picker's selection may stand in for, and `visited` the entry the tab is on.
function Body({ context, workspaceId, file, visited, searching, remember, closeSearch, peek, jumps, ...navigation }: Omit<NavigationProps, 'file'> & { workspaceId?: string; file?: HistoryEntry; visited?: HistoryEntry; searching: boolean; remember: Remember; closeSearch: () => void; peek: (file: FileClick) => void; jumps: Jumps }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // The directory of the workspace in front: what a path typed before any file is opened is resolved against, and the
  // root the search panel looks in.
  const [workspaceEntry, setWorkspaceEntry] = useState<FileClick>();
  useEffect(() => {
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setError(''); setLoading(value !== null);
      if (!value) return;
      void context.ui.request<FileClick>('resolve', value)
        .then((resolved) => { if (alive && id === request) { setWorkspaceEntry(resolved); setLoading(false); } })
        .catch((problem: Error) => { if (alive && id === request) { setLoading(false); setError(problem.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId]);
  if (!file) return <EmptyPage context={context} base={workspaceEntry} navigate={navigation.navigate} loading={loading} error={error} />;
  const workspace = workspaceEntry?.path ?? '';
  // Only a different path or machine rebuilds the page.
  const key = JSON.stringify([machineKey(file.machine), file.path]);
  return <div className={searching ? 'editor-body searching' : 'editor-body'}>
    <FileView key={key} context={context} file={file} holder={workspaceId ?? ''} remember={remember} peeking={searching} jumps={jumps} {...navigation} />
    {visited && searching && <Search context={context} visited={visited} workspace={workspace} peek={peek} navigate={navigation.navigate} close={closeSearch} />}
  </div>;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === identity.id) openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

// Whether the keyboard is being typed into a box, which keeps its keys to itself.
const writing = (target: EventTarget | null) => target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const key = workspaceId ?? '';
  const history = histories.get(key) ?? { entries: [], index: -1 };
  histories.set(key, history);
  // What the tab shows on top of the page the history points at: the search picker, and the file its selection stands
  // for, which is shown without being visited.
  const view: { searching: boolean; peeked?: FileClick } = { searching: false };
  // Kept on the tab so it outlives the page each jump lands on.
  const jumps: Jumps = { entries: [], index: -1 };
  // The entry the tab shows: what the picker is peeking at, or else the one its history points at.
  const showing = () => view.peeked ?? history.entries[history.index];
  const push = (file: FileClick) => {
    const current = history.entries[history.index];
    const same = current && machineKey(current.machine) === machineKey(file.machine) && current.type === file.type && current.path === file.path;
    // A file opened without a line is the visit already there, which keeps where it was left; a jump to a line of it is a
    // visit of its own, so going back returns to the line it left.
    if (same && (file.line === undefined || (file.line === current.line && file.column === current.column))) {
      // The view reads a new entry as a new visit, which is what puts back the path the address box was typed over.
      history.entries[history.index] = { ...current };
      return;
    }
    history.entries = [...history.entries.slice(0, history.index + 1), file];
    history.index++;
    void context.ui.request('save-history', Object.fromEntries(histories));
  };
  if (file) push(file);
  context.host.tabs({ ...identity, workspaceId, onClose() {
    for (const [savedKey, saved] of histories) if (saved === history) histories.delete(savedKey);
    void context.ui.request('save-history', Object.fromEntries(histories));
    // The file every tab shows, which is what decides whether a language server is still needed anywhere.
    void services?.closeUnused([...histories.values()].map((saved) => saved.entries[saved.index]).filter((shown): shown is FileClick => shown?.type === 'file'));
  }, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const mounted = createRoot(container);
    // Every move of what the tab shows goes through here: a caller says what it opens, and what no longer holds is
    // cleared for it, so no caller has to remember the parts it is not touching.
    const show = (next: Partial<typeof view> = {}) => {
      Object.assign(view, { searching: false, peeked: undefined }, next);
      render();
    };
    const navigate = (file: FileClick) => {
      // The address box takes a path of either kind, and a directory is the files view's to draw.
      if (file.type === 'directory') {
        void context.global.publish('onclick', file);
        return;
      }
      push(file);
      show();
    };
    const openSearch = () => show({ searching: true });
    const closeSearch = () => show();
    // The picker stays open where the name is being typed.
    const peek = (file: FileClick) => show({ searching: true, peeked: file });
    const refresh = () => { history.entries[history.index] = { ...history.entries[history.index] }; render(); };
    // Walking the tab's history: the entry it lands on is saved with the rest, and the search it leaves is cleared.
    const step = (by: number) => {
      history.index += by;
      void context.ui.request('save-history', Object.fromEntries(histories));
      show();
    };
    // The entry is the one the view shows rather than whatever the history points at now.
    const remember = (entry: HistoryEntry, at: Partial<Position>) => {
      Object.assign(entry, at);
      // A file left at its top is where a fresh open puts it, so there is no offset worth keeping.
      if (entry.top === 0) delete entry.top;
    };
    // The keys this plugin answers itself: `<C-o>`/`<C-i>` walk the tab's list of jumps, `<C-f>` opens the search picker and
    // `<C-s>` hands the file on show to the preview plugin. The vim layer answers `<C-o>`, `<C-i>` and `<C-f>` itself, so
    // they are taken before it on the capture, and they are taken by the tab rather than by a page: a page is built after a
    // key may already be on its way.
    const onKeyDown = (event: KeyboardEvent) => {
      // A tab that is not on show listens too, since the window hides a panel instead of taking it apart; and a box being
      // typed into keeps its keys.
      if (event.defaultPrevented || writing(event.target) || event.altKey || event.metaKey || !event.ctrlKey) return;
      if (!container.checkVisibility()) return;
      const pressed = event.key.toLowerCase();
      const shown = showing();
      if (!shown) return;
      if (pressed === 'f') { event.preventDefault(); event.stopPropagation(); openSearch(); return; }
      if (pressed === 's') { event.preventDefault(); event.stopPropagation(); void context.global.publish('preview:open', shown); return; }
      if (pressed !== 'o' && pressed !== 'i') return;
      const forward = pressed === 'i';
      const target = jumps.entries[jumps.index + (forward ? 1 : -1)];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      jumps.index += forward ? 1 : -1;
      navigate(visit(target, shown.machine));
    };
    addEventListener('keydown', onKeyDown, true);
    const render = () => mounted.render(<Body context={context} workspaceId={workspaceId} jumps={jumps} file={showing()} visited={history.entries[history.index]} searching={view.searching}
      navigate={navigate}
      remember={remember}
      openSearch={openSearch}
      closeSearch={closeSearch}
      peek={peek}
      refresh={refresh}
      back={history.index > 0 ? () => step(-1) : undefined}
      forward={history.index < history.entries.length - 1 ? () => step(1) : undefined} />);
    return { onSelect: render, dispose: () => { mounted.unmount(); removeEventListener('keydown', onKeyDown, true); } };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  // The state is what keeps the text as it was read: the view stays editable in the DOM, since a content the browser is
  // told not to take the keyboard for cannot hold the caret or answer the vim keys either. The selection a visual mode
  // covers is drawn here, because the vim keys blank the browser's own ::selection without drawing one of their own.
  chrome = [vim(), lineNumbers(), highlightActiveLine(), drawSelection(), ...editorTheme(profile.theme, font), EditorState.readOnly.of(true)];
  services = new LanguageServices(context);
  for (const [key, history] of Object.entries(await context.ui.request<Record<string, History>>('history'))) histories.set(key, history);
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
    activeWorkspaceId = value?.workspaceId;
    // The shell moves unscoped tabs into the first selected workspace.
    const unassigned = histories.get('');
    if (activeWorkspaceId !== undefined && unassigned) {
      histories.delete('');
      histories.set(activeWorkspaceId, unassigned);
      void context.ui.request('save-history', Object.fromEntries(histories));
    }
  });
  void context.global.publish('workspace:query', null);
  // The click a file link makes lands here for a file, which is what the tab then shows; a directory is the files view's
  // to show, and it has a tab of its own.
  const off = context.global.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'file') return;
    openTab(context, activeWorkspaceId, file);
    void context.global.publish('core:show-view', { plugin: identity.id });
  });
  return () => {
    offActive();
    off();
    histories.clear();
    services?.dispose();
    services = undefined;
  };
}
