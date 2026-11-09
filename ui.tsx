import { history as undoHistory } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { Vim, getCM, vim, type CodeMirrorV } from '@replit/codemirror-vim';
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import fuzzysort from 'fuzzysort';
import type { WorkspaceActive } from '@lengmoxxl/sdk';
import { bindKeys } from '@lengmoxxl/sdk/keys';
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
// The extensions every view shares: made once in mount(), and taken by each view as it is built.
let chrome: Extension[] = [];
let services: LanguageServices | undefined;
const histories = new Map<string, History>();

// A jump's target as the visit that lands on it, on the machine the file it was answered for lives on.
const visit = (target: Target, machine: FileClick['machine']): FileClick =>
  ({ type: 'file', machine, path: target.path, line: target.line, column: target.column });

// The text a file was edited into and not written back, by the file's identity: leaving the file keeps it, and the page
// shows it again instead of what the file holds. Another tab may show the same file, so a tab closing says nothing about
// it; it lives in this window only, and the plugin going away drops it.
const drafts = new Map<string, string>();
const fileKey = (file: FileClick) => `${machineKey(file.machine)}|${file.path}`;

// The directory a visit points into: a directory is its own, and a file's is the one it sits in.
const directoryOf = (file: FileClick) => (file.type === 'directory' ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/');

// The page the editor hangs from: the element the Core hands the keys to and takes them back from.
const pageOf = (element: HTMLElement | null) => element?.closest<HTMLElement>('[data-plugin]');

// The view behind the vim adapter the keys are answered with: `cm6` is the field it carries the CodeMirror view in, which
// its own types do not say.
const viewOf = (cm: unknown) => (cm as { cm6?: EditorView }).cm6;

// A key the vim layer answers asks the view it was typed into; the tab's `<C-s>` asks the one the page on show holds.
const pageKeys = new Map<EditorView, { jump: (act: LocationFeature) => void; save: () => void }>();

// The keys the normal mode answers by our own actions: the key, and the question it asks the view, in the order the menu
// offers those questions.
const vimCommands: [keys: string, act: LocationFeature][] = [
  ['gd', 'definition'],
  ['gi', 'implementation'],
  ['gD', 'typeDefinition'],
  ['gr', 'references'],
];

// The keys are defined once for the whole window, not per view, since the vim layer is one state shared by every view.
// `:w` is answered here too: the library maps it to a `write` of its own that saves nowhere.
for (const [keys, act] of vimCommands) {
  const name = `wangcai-${act}`;
  Vim.defineAction(name, (cm) => {
    const view = viewOf(cm);
    if (view) pageKeys.get(view)?.jump(act);
  });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
}
Vim.defineEx('write', 'w', (cm) => {
  const view = viewOf(cm);
  if (view) pageKeys.get(view)?.save();
});

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

// Whether the keyboard is in a box being typed into, which keeps its keys to itself.
const writing = (target: EventTarget | null) => target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);

type Remember = (entry: HistoryEntry, at: Partial<Position>) => void;
// What the tab hands a page it shows.
type PageProps = { context: UiContext; file: HistoryEntry; navigate: (file: FileClick) => void; back?: () => void; forward?: () => void; openSearch: () => void };
// A place in a file, counted from zero the way a server is asked about it.
type Place = { line: number; character: number };

// The address box: what is typed is resolved against the directory this visit points into, and the entry it names is
// opened.
function Address({ context, base, navigate, report }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; report: (message: string) => void }) {
  const [path, setPath] = useState(base?.path ?? '');
  const request = useRef(0);
  useEffect(() => { setPath(base?.path ?? ''); return () => { request.current++; }; }, [base?.path]);
  return <form className="editor-address" onSubmit={(event) => {
    event.preventDefault();
    if (!base || !path.trim()) return;
    const id = ++request.current;
    report('');
    void context.ui.request<FileClick>('resolve', { machine: base.machine, path: path.trim(), base: directoryOf(base) })
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

// How long a page says what went wrong before it takes it back: a failure is news, so nothing a reader does or leaves
// undone keeps it up.
const noticeFor = 4000;

function useNotice(): [string, (text: string) => void] {
  const [notice, report] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => report(''), noticeFor);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, report];
}

function Notice({ text }: { text: string }) {
  return text ? <div className="notice" role="alert">{text}</div> : null;
}

function Navigation({ context, file, navigate, back, forward, openSearch, dirty, refresh, report }: PageProps & { dirty: boolean; refresh: () => void; report: (text: string) => void }) {
  return <Header>
    <button className="editor-icon" aria-label="后退" title="后退" disabled={!back} onClick={back}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 2 8l5 5 M2 8h12" /></svg>
    </button>
    <button className="editor-icon" aria-label="前进" title="前进" disabled={!forward} onClick={forward}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3 5 5-5 5 M2 8h12" /></svg>
    </button>
    <button className="editor-icon" aria-label="刷新" title="刷新" onClick={refresh}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 6.7A5.3 5.3 0 1 0 12 12 M13.3 2.7v4h-4" /></svg>
    </button>
    <Address context={context} base={file} navigate={navigate} report={report} />
    {dirty && <span className="editor-dirty" role="status" aria-label="有未写回的改动" title="有未写回的改动">*</span>}
    <div className="editor-tail">
      <LspStatus file={file} />
      <button className="editor-icon" aria-label="打开所在目录" title="在 files 里打开当前文件所在的目录"
        onClick={() => navigate({ type: 'directory', machine: file.machine, path: directoryOf(file) })}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1.5 2H14V12H2V4.5Z" /></svg>
      </button>
      <button className="editor-icon" aria-label="预览" title="在 preview 里打开当前文件" onClick={() => void context.global.publish('preview:open', file)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" /><circle cx="8" cy="8" r="1.8" /></svg>
      </button>
      <button className="editor-icon" aria-label="搜索" title="搜索" onClick={openSearch}>
        <Glass />
      </button>
    </div>
  </Header>;
}

// A question a place in a file can be asked of a server: the name the menu offers it under, and the title of the panel that
// lists the places it found.
type LspQuestion = { label: string; title: string };
const lspQuestions: Record<LocationFeature, LspQuestion> = {
  definition: { label: '转到定义', title: '定义' },
  implementation: { label: '转到实现', title: '实现' },
  typeDefinition: { label: '转到类型定义', title: '类型定义' },
  references: { label: '查找引用', title: '引用' },
};
// The same questions in the order the menu offers them: an object keeps its keys in the order they were written, while
// TypeScript types them as strings.
const lspMenu = Object.entries(lspQuestions) as [LocationFeature, LspQuestion][];

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
// keyboard wherever the focus was, so Escape reaches the panel, `j` and `k` walk its rows, and Enter opens what the row
// names.
function Overlay({ className, role, label, at, onClose, children }: {
  className: string; role: 'menu' | 'dialog'; label: string; at?: CSSProperties; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector('button')?.focus(); }, []);
  return <>
    <div className="editor-backdrop" onClick={onClose} />
    <div ref={panel} className={className} role={role} aria-label={label} style={at}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { onClose(); return; }
        const step = event.key === 'j' ? 1 : event.key === 'k' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('button')];
        const here = rows.findIndex((row) => row === document.activeElement);
        rows[Math.min(Math.max(here + step, 0), rows.length - 1)].focus();
      }}>
      {children}
    </div>
  </>;
}

type Editing = { onDoc: (text: string) => void; save: () => void };

function EditorPage({ file, text, remember, peeking, navigate, editing }: { file: HistoryEntry; text: string; remember: Remember; peeking: boolean; navigate: (file: FileClick) => void; editing: Editing }) {
  const element = useRef<HTMLDivElement>(null);
  const control = useRef<EditorView>(undefined);
  // The view reaches back through this, so the one built once keeps calling the current render's callbacks.
  const handlers = useRef(editing);
  useEffect(() => { handlers.current = editing; });
  const [menu, setMenu] = useState<{ x: number; y: number; entries: typeof lspMenu; at: Place }>();
  const [places, setPlaces] = useState<{ title: string; targets: Target[] }>();
  // What this page asks a server about, made once: a new path or machine is a new page, so this value holds for the mount.
  const options = useMemo(() => serviceFor(file), [file.machine, file.path]);
  // The server this file speaks to, replaced by the dot or the revival behind it.
  const [session, setSession] = useState(() => options && services?.session(options));
  // The server's part of the view is swapped in place rather than taken as a reason to build the view again: a view built
  // again loses what is being typed into it, and a server coming up or going away is no reason for that.
  const server = useMemo(() => new Compartment(), []);
  // The link to the session there is now: `session` is only the signal for taking a new one, which is why it is a
  // dependency without the body reading it — `extension` reads the session itself.
  const link = useMemo(() => (options && services ? services.extension(options) : []), [options, session]);
  // The file is opened on its server once, and then follows it.
  useEffect(() => {
    const running = services;
    if (!options || !running) return;
    void running.open(options);
    setSession(running.session(options));
    return running.subscribe(() => setSession(running.session(options)));
  }, [options]);
  // A jump from the caret is two visits of the tab's history: the place it leaves, taken at the caret so going back
  // returns to it, and the place it lands on.
  const jumpFrom = (target: Target) => {
    const view = control.current;
    if (!view) return;
    const at = positionOf(view);
    navigate({ type: 'file', machine: file.machine, path: file.path, line: at.line, column: at.column });
    navigate(visit(target, file.machine));
  };
  // One of the questions the menu and the keys ask about a place in this file. References are always a list to pick from,
  // and a jump that turned out to name more than one place is too; a jump with one place is followed.
  const goAt = async (feature: LocationFeature, at: Place) => {
    if (!options || !services) return;
    const found = await services.locations(options, at.line, at.character, feature);
    // What the list would show belongs to this question alone: a question that found nothing leaves no list behind.
    if (feature === 'references' || found.length > 1) {
      setPlaces(found.length ? { title: lspQuestions[feature].title, targets: found } : undefined);
      return;
    }
    if (found[0]) jumpFrom(found[0]);
  };
  // The entry the view shows now: it outlives the entry it was built for, so what its callbacks record reads from here.
  const shown = useRef(file);
  useEffect(() => { shown.current = file; });
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          ...chrome,
          modeFor(file.path),
          server.of(link),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet) remember(shown.current, positionOf(update.view));
            if (update.docChanged) handlers.current.onDoc(update.state.doc.toString());
          }),
        ],
      }),
      parent: element.current!,
    });
    control.current = view;
    const scrolled = () => remember(shown.current, { top: view.scrollDOM.scrollTop });
    view.scrollDOM.addEventListener('scroll', scrolled, { passive: true });
    // The keys are handed over as the view is built, so a key pressed as soon as the file appears finds its answer instead of
    // waiting for a later render.
    pageKeys.set(view, { jump: (act) => void goAt(act, placeOf(view)), save: () => handlers.current.save() });
    return () => {
      pageKeys.delete(view);
      view.scrollDOM.removeEventListener('scroll', scrolled);
      view.destroy();
      control.current = undefined;
    };
  }, [text, remember, file.path]);
  // What makes this run: the page opening, when its server is only known after the open, and a server that restarted, came
  // back, or went away while the tab showed something else.
  useEffect(() => {
    const view = control.current;
    if (view) view.dispatch({ effects: server.reconfigure(link) });
  }, [server, link]);
  // Where the view sits: the caret goes on the line the entry names, and the scroll is put back at the offset the file
  // was left at, or else centred on that line. A view that was built again starts at its own top with the caret at the
  // first line, so both are taken for it once more; a panel that has given it no height yet places it on a later frame.
  // The offset is read once per view, so what this runs for is a view being built and a jump that names another place.
  const placement = useRef<{ view: EditorView; offset?: number }>(undefined);
  useEffect(() => {
    const view = control.current;
    if (!view) return;
    if (placement.current?.view !== view) placement.current = { view, offset: file.top };
    const placing = placement.current;
    // A line past the end of the text and a column past the end of its line both come back to the last one there is.
    const row = file.line === undefined ? undefined : view.state.doc.line(Math.min(file.line, view.state.doc.lines));
    const at = row && Math.min(row.from + (file.column ?? 1) - 1, row.to);
    if (at !== undefined) view.dispatch({ selection: { anchor: at } });
    let frames = 0;
    const place = () => {
      if (!view.dom.clientHeight) return false;
      if (placing.offset !== undefined) {
        view.scrollDOM.scrollTop = placing.offset;
        // A view that has only measured the screenful it starts with cannot scroll that far yet, so it is asked again on
        // a later frame; one that still cannot after a second has been shown a shorter text than it was left at.
        if (Math.abs(view.scrollDOM.scrollTop - placing.offset) > 1 && frames < 60) return false;
        placing.offset = undefined;
        return true;
      }
      if (at === undefined) return true;
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) });
      return true;
    };
    if (place()) return;
    let frame = requestAnimationFrame(function again() {
      frames += 1;
      if (!place()) frame = requestAnimationFrame(again);
    });
    return () => cancelAnimationFrame(frame);
  }, [file.line, file.column, text]);
  // A right click asks this plugin's menu instead of the browser's: the entries are the features the server answers.
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    const openMenu = (event: MouseEvent) => {
      const view = control.current;
      const at = view?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
      // The gutter, the empty space below the text, and the spacing between words are not places to ask about.
      if (!view || !session || at === null || !view.state.sliceDoc(at, at + 1).trim()) return;
      const entries = lspMenu.filter(([feature]) => session.supports(feature));
      if (!entries.length) return;
      event.preventDefault();
      // Every entry asks the server about the cursor, so it goes where the click landed.
      view.dispatch({ selection: { anchor: at } });
      setMenu({ x: event.clientX, y: event.clientY, entries, at: placeOf(view) });
    };
    host.addEventListener('contextmenu', openMenu);
    return () => host.removeEventListener('contextmenu', openMenu);
  }, [session]);
  // The keyboard belongs in the editor, unless the page is only showing what a picker's selection stands for or a box is
  // being typed into — the address, and vim's own `:` line — where taking it would end what is being typed.
  const focusEditor = () => { if (!peeking && !writing(document.activeElement)) control.current?.focus(); };
  // The keyboard is handed over again for each thing that changes who should have it: a peek takes it and gives it back, and
  // a view built for a new text is a new one to hand it to.
  useEffect(() => { focusEditor(); }, [peeking, text]);
  // A panel that closes hands the keys back: the row that held them goes with it, and a jump into this very file rebuilds
  // nothing, so no other effect would hand them over again.
  const closePanels = () => { setMenu(undefined); setPlaces(undefined); focusEditor(); };
  // A key that shows this view leaves the keyboard on the plugin's page rather than in the editor, so the page hands it
  // over when it hears that it was shown — a listener here, since the page's focus alone does not say who shows it.
  useEffect(() => {
    const page = pageOf(element.current);
    if (!page) return;
    page.addEventListener('wangcai:shown', focusEditor);
    return () => page.removeEventListener('wangcai:shown', focusEditor);
  }, [peeking]);
  // A press that leaves the field hands the keys to the page, and the text ends what it was doing on the way out: an insert
  // mode still open would be open again when the keys come back to it.
  useEffect(() => {
    const page = pageOf(element.current);
    if (!page) return;
    const leaveInsert = () => {
      const view = control.current;
      // `getCM` hands back the object Vim keeps its own state on, typed more loosely than the call below wants it.
      const cm = view && getCM(view);
      // The cursor stays where the typing left it: this press is about the keys, not about where the text goes on.
      if (cm) Vim.exitInsertMode(cm as CodeMirrorV, true);
    };
    page.addEventListener('focus', leaveInsert);
    return () => page.removeEventListener('focus', leaveInsert);
  }, []);
  return <>
    <div className="editor-code" ref={element} />
    {menu && <Overlay className="code-menu" role="menu" label="语言服务" at={{ left: menu.x, top: menu.y }} onClose={closePanels}>
      {menu.entries.map(([feature, { label }]) => <button key={feature} role="menuitem"
        onClick={() => {
          closePanels();
          void goAt(feature, menu.at);
        }}>{label}</button>)}
    </Overlay>}
    {places && <Overlay className="lsp-places" role="dialog" label={places.title} onClose={closePanels}>
      {places.targets.map((target) => <button key={`${target.path}:${target.line}:${target.column}`} className="lsp-place"
        onClick={() => { closePanels(); jumpFrom(target); }}>
        <span className="lsp-place-file">{target.path.slice(target.path.lastIndexOf('/') + 1)}</span>
        <span className="lsp-place-at">{target.line}:{target.column}</span>
      </button>)}
    </Overlay>}
  </>;
}

// The box a tab draws in.
function Shell({ children }: { children: ReactNode }) {
  return <section className="editor" aria-label="编辑器">{children}</section>;
}

function FileView({ context, file, navigate, back, forward, openSearch, holder, remember, peeking }: PageProps & { holder: string; remember: Remember; peeking: boolean }) {
  // The text the next view is built with, which only a read sets; `baseline`, what the file itself holds; and `pageText`, the
  // text the view holds now, which is what a write puts in the file.
  const [text, setText] = useState<string>();
  const baseline = useRef('');
  const pageText = useRef('');
  // The text this page last put in the file, and how many times it has done so: a read still on its way when a write
  // lands is answering about the file as it was before it.
  const sent = useRef('');
  const writes = useRef(0);
  // A read that failed leaves nothing to show; a write that failed is said over the page, with the text still on it.
  const [readError, setReadError] = useState('');
  const [notice, report] = useNotice();
  const draftKey = fileKey(file);
  // What has not been written back sits in `drafts`, and `dirty` — the mark the header draws — is kept with it, so the two
  // never part.
  const [dirty, setDirty] = useState(false);
  const hold = useCallback((draft?: string) => {
    if (draft === undefined) drafts.delete(draftKey); else drafts.set(draftKey, draft);
    setDirty(draft !== undefined);
  }, [draftKey]);
  const [refreshes, setRefreshes] = useState(0);
  // A file is read when this page is built and again when the refresh asks for it: the page is built for one file, so the
  // path it shows cannot change under it, and a jump inside the file does not read it again.
  useEffect(() => {
    let alive = true;
    setText(undefined); setReadError('');
    // `quiet` marks a read the page did not ask for, the file changing on disk, where one that brings back what this page
    // last wrote is no news — the file holds it already, and what was typed after that write has not reached the file. A
    // page that has not written anything yet has nothing to hear its own echo in.
    const read = ({ draft, quiet }: { draft?: string; quiet?: boolean }) => {
      const writesAtRead = writes.current;
      void context.ui.request<string>('read', file).then((content) => {
        if (!alive || writes.current !== writesAtRead) return;
        if (quiet && writesAtRead > 0 && content === sent.current) return;
        baseline.current = content;
        hold(draft);
        const drawn = draft ?? content;
        pageText.current = drawn;
        setText(drawn);
        setReadError('');
        report('');
      }).catch((problem: Error) => { if (alive) setReadError(problem.message); });
    };
    const stop = watch(context, file.machine, holder, [file.path], () => read({ quiet: true }));
    read({ draft: drafts.get(draftKey) });
    return () => { alive = false; stop(); };
  }, [context, holder, refreshes, hold]);
  // The refresh: what has not been written back is dropped first, since the read that answers it puts back the draft it
  // finds, and only then is the file asked for.
  const refresh = () => { hold(undefined); setRefreshes((count) => count + 1); };
  const editing: Editing = {
    onDoc(edited) {
      pageText.current = edited;
      hold(edited === baseline.current ? undefined : edited);
    },
    save() {
      const whole = pageText.current;
      void context.ui.request('write', { machine: file.machine, path: file.path, text: whole })
        .then(() => {
          writes.current += 1;
          sent.current = whole;
          baseline.current = whole;
          // What was typed while the write was on its way is not in the file, so the mark stays up for it.
          if (pageText.current === whole) hold(undefined);
          report('');
        })
        .catch((problem: Error) => report(problem.message));
    },
  };
  return <Shell>
    <Navigation context={context} file={file} navigate={navigate} back={back} forward={forward} openSearch={openSearch} dirty={dirty} refresh={refresh} report={report} />
    <Notice text={notice} />
    {readError ? <div className="file-message" role="alert">{readError}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : <EditorPage file={file} text={text} remember={remember} peeking={peeking} navigate={navigate} editing={editing} />}
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

type SearchRow = { key: string; title: string; detail?: string; depth?: number; target: FileClick; marks?: ReadonlyArray<number> };

// The magnifier, drawn on the header's button and in the picker's row: one glyph, whose size and colour come from where it
// is drawn.
const Glass = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 4 4" /></svg>
);

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
  // Where a search starts: the workspace, or else the directory this visit points into.
  const directory = workspace || directoryOf(visited);
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
    void services.symbols(options)
      .then((found) => { if (alive) { setSymbols(found); clearStatus('symbols'); } })
      .catch((problem: Error) => { if (alive) { setSymbols([]); setStatus({ mode: 'symbols', text: problem.message }); } });
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
  const { rows, answered } = useMemo(() => {
    const capped = (answered: boolean, drawn: SearchRow[]) => ({ answered, rows: drawn.slice(0, rowLimit) });
    const shownPath = (path: string) => path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path;
    if (mode === 'grep') {
      return capped(matches !== undefined, (matches ?? []).map((hit) => ({
        key: `${hit.path}:${hit.line}`, title: hit.text,
        detail: `${shownPath(hit.path)}:${hit.line}`,
        target: visit(hit, visited.machine),
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
          target: visit({ path: visited.path, line: entry.line, column: entry.column }, visited.machine),
        }, ...below];
      });
      return capped(symbols !== undefined, branch(symbols ?? [], 0));
    }
    const candidates: SearchRow[] = (files ?? []).map((path) => ({
      key: path, title: shownPath(path),
      target: { type: 'file', machine: visited.machine, path },
    }));
    if (!needle) return capped(files !== undefined, candidates);
    // Apply our row cap after restoring input order for equal scores.
    const found = fuzzysort.go(needle, candidates, { key: 'title', threshold: matchThreshold, limit: 0 });
    const positions = new Map(candidates.map((candidate, index) => [candidate, index]));
    return capped(files !== undefined, [...found]
      .sort((a, b) => b.score - a.score || positions.get(a.obj)! - positions.get(b.obj)!)
      .map((one) => ({ ...one.obj, marks: one.indexes })));
  }, [mode, needle, directory, visited.machine, visited.path, files, matches, symbols]);
  const note = status?.mode === mode ? status.text : '';
  // The index of the row standing for the entry the tab is on, if the rows hold it.
  const entryRow = rows.findIndex((row) => row.target.path === visited.path && (row.target.line === undefined || row.target.line === visited.line));
  // Rows arrive after the keystroke that asked for them, so the chosen one is kept within what is on show. An entry the
  // rows do not hold, past the cap the unfiltered list is drawn with, leaves nothing under the selection: Enter then
  // opens no file the reader never picked.
  const at = Math.min(chosen ?? entryRow, rows.length - 1);
  useEffect(() => { list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' }); }, [at, rows]);
  // A name typed a letter at a time would otherwise read a file per letter, so the row under the selection is taken
  // once the selection rests.
  useEffect(() => {
    const target = rows[at]?.target;
    if (chosen === undefined || !target) return;
    const timer = setTimeout(() => peek(target), 120);
    return () => clearTimeout(timer);
  }, [chosen, at, rows]);
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
      {rows.map((row, index) => <button key={row.key} type="button" className="search-row" aria-current={index === at || undefined} style={{ '--depth': row.depth ?? 0 } as CSSProperties} onClick={() => navigate(row.target)} onMouseEnter={() => setChosen(index)}>
        <span className="search-title">{marked(row.title, row.marks)}</span>
        {row.detail && <span className="search-detail">{row.detail}</span>}
      </button>)}
      {answered && !rows.length && !note && <div className="file-message">{emptyMessage[mode]}</div>}
    </div>
  </div>;
}

// What a tab shows before a file is sent to it: the address box, which reads a path against the workspace, and the one
// line that says what the tab is waiting for — a failure, a read in flight, or where a file comes from.
function EmptyPage({ context, base, navigate, loading, workspaceError }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; loading: boolean; workspaceError: string }) {
  const [notice, report] = useNotice();
  return <Shell>
    <Header>
      <Address context={context} base={base} navigate={navigate} report={report} />
    </Header>
    <Notice text={notice} />
    <div className="file-message" role={workspaceError ? 'alert' : undefined}>
      {workspaceError || (loading ? '正在读取…' : base ? '在 files 里点一个文件，或者在这里输入路径' : '请选择一个已连接的终端')}
    </div>
  </Shell>;
}

// The page a tab draws: the file on show with the search picker over it, or the empty page while no file has been sent
// here.
// `file` is what the page shows, which a picker's selection may stand in for, and `visited` the entry the tab is on.
function Body({ context, navigate, back, forward, openSearch, workspaceId, file, visited, searching, remember, closeSearch, peek }: Omit<PageProps, 'file'> & { workspaceId?: string; file?: HistoryEntry; visited?: HistoryEntry; searching: boolean; remember: Remember; closeSearch: () => void; peek: (file: FileClick) => void }) {
  const [loading, setLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  // The directory of the workspace in front: what a path typed before any file is opened is resolved against, and the
  // root the search panel looks in.
  const [workspaceEntry, setWorkspaceEntry] = useState<FileClick>();
  useEffect(() => {
    let alive = true;
    let request = 0;
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      const id = ++request;
      setWorkspaceError(''); setLoading(value !== null);
      if (!value) return;
      void context.ui.request<FileClick>('resolve', value)
        .then((resolved) => { if (alive && id === request) { setWorkspaceEntry(resolved); setLoading(false); } })
        .catch((problem: Error) => { if (alive && id === request) { setLoading(false); setWorkspaceError(problem.message); } });
    });
    void context.global.publish('workspace:query', null);
    return () => { alive = false; off(); };
  }, [context, workspaceId]);
  if (!file) return <EmptyPage context={context} base={workspaceEntry} navigate={navigate} loading={loading} workspaceError={workspaceError} />;
  const workspace = workspaceEntry?.path ?? '';
  // Only a different file rebuilds the page.
  const key = fileKey(file);
  return <div className={searching ? 'editor-body searching' : 'editor-body'}>
    <FileView key={key} context={context} file={file} navigate={navigate} back={back} forward={forward} openSearch={openSearch} holder={workspaceId ?? ''} remember={remember} peeking={searching} />
    {visited && searching && <Search context={context} visited={visited} workspace={workspace} peek={peek} navigate={navigate} close={closeSearch} />}
  </div>;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === identity.id) openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string, file?: FileClick) {
  const key = workspaceId ?? '';
  const history = histories.get(key) ?? { entries: [], index: -1 };
  histories.set(key, history);
  // What the tab shows on top of the page the history points at: the search picker, and the file its selection stands
  // for, which is shown without being visited.
  const view: { searching: boolean; peeked?: FileClick } = { searching: false };
  // The entry the tab shows: what the picker is peeking at, or else the one its history points at.
  const showing = () => view.peeked ?? history.entries[history.index];
  const push = (file: FileClick) => {
    const standing = history.entries[history.index];
    const same = standing && machineKey(standing.machine) === machineKey(file.machine) && standing.type === file.type && standing.path === file.path;
    // A file opened without a line is the visit already there, which keeps where it was left; a jump to a line of it is a
    // visit of its own, so going back returns to the line it left.
    if (same && (file.line === undefined || (file.line === standing.line && file.column === standing.column))) return;
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
      // A directory is the files view's to draw, so it is handed on rather than opened here.
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
    // Walking the tab's history: the entry it lands on is saved with the rest, and the search it leaves is cleared.
    const step = (by: number) => {
      history.index += by;
      void context.ui.request('save-history', Object.fromEntries(histories));
      show();
    };
    const canStep = (by: number) => history.entries[history.index + by] !== undefined;
    // The entry is the one the view shows rather than whatever the history points at now.
    const remember = (entry: HistoryEntry, at: Partial<Position>) => {
      Object.assign(entry, at);
      // A file left at its top is where a fresh open puts it, so there is no offset worth keeping.
      if (entry.top === 0) delete entry.top;
    };
    // The keys this page answers itself, in the SDK's keymap: `<C-s>` writes the file on show back to its disk, `<C-f>`
    // opens the search picker and `<C-o>`/`<C-i>` walk the tab's history. `insert` is what lets them answer while a field
    // holds the keys, which is where the vim layer would otherwise take `<C-o>`, `<C-i>` and `<C-f>` for itself; the page
    // they are bound to is the tab that has the keyboard, so no other tab answers them.
    const keys = [
      { keys: '<C-s>', insert: true, run: () => { const view = EditorView.findFromDOM(container); if (view) pageKeys.get(view)?.save(); } },
      { keys: '<C-f>', insert: true, run: () => { if (showing()) openSearch(); } },
      { keys: '<C-o>', insert: true, run: () => { if (canStep(-1)) step(-1); } },
      { keys: '<C-i>', insert: true, run: () => { if (canStep(1)) step(1); } },
    ];
    // A box being typed into keeps its keys: the address, the picker's box and vim's own `:` line.
    const unbindKeys = bindKeys(container, keys, { ignore: (event) => event.defaultPrevented || writing(event.target) });
    // The two leader keys the window binds for this page, `<leader>gp` for the preview and `<leader>gf` for the directory
    // files opens, reach it as events: the window matches the leader press before any page hears it. Every mounted tab is
    // told, so the one on show is the one that answers.
    const offEvents = [
      context.global.subscribe('editor:preview', () => {
        const file = showing();
        if (file && container.checkVisibility()) void context.global.publish('preview:open', file);
      }),
      context.global.subscribe('editor:reveal', () => {
        const file = showing();
        if (file && container.checkVisibility()) navigate({ type: 'directory', machine: file.machine, path: directoryOf(file) });
      }),
    ];
    const render = () => mounted.render(<Body
      context={context}
      navigate={navigate}
      back={canStep(-1) ? () => step(-1) : undefined}
      forward={canStep(1) ? () => step(1) : undefined}
      openSearch={openSearch}
      workspaceId={workspaceId}
      file={showing()}
      visited={history.entries[history.index]}
      searching={view.searching}
      remember={remember}
      closeSearch={closeSearch}
      peek={peek}
      />);
    return { onSelect: render, dispose: () => { mounted.unmount(); unbindKeys(); for (const off of offEvents) off(); } };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  // The vim keys over the text, which the page may edit and write back, and the history behind its undo. The selection a
  // visual mode covers is drawn here, because the vim keys blank the browser's own ::selection without drawing one of
  // their own.
  chrome = [vim(), lineNumbers(), highlightActiveLine(), drawSelection(), undoHistory(), ...editorTheme(profile.theme, font)];
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
  // Every file click a plugin publishes lands here, and the tab then shows that file; a directory is the files view's to
  // draw, and the files view has a tab of its own.
  const off = context.global.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'file') return;
    openTab(context, activeWorkspaceId, file);
    void context.global.publish('core:show-view', { plugin: identity.id });
  });
  return () => {
    offActive();
    off();
    histories.clear();
    drafts.clear();
    services?.dispose();
    services = undefined;
  };
}
