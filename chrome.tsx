import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import type { FileClick, HistoryEntry, Position } from './shared';

export type Remember = (entry: HistoryEntry, at: Partial<Position>) => void;
// A jump names the place it lands on, and the visit it leaves behind for the way back, if it makes one of its own.
export type Navigate = (file: HistoryEntry, departure?: HistoryEntry) => void;
// What the tab hands a page it shows.
export type PageProps = { context: UiContext; file: HistoryEntry; navigate: Navigate; back?: () => void; forward?: () => void; openSearch: () => void };

// The directory a visit points into: a directory is its own, and a file's is the one it sits in.
export const directoryOf = (file: FileClick) => (file.type === 'directory' ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/');

// The page the editor hangs from: the element the Core hands the keys to and takes them back from.
export const pageOf = (element: HTMLElement | null) => element?.closest<HTMLElement>('[data-plugin]');

// Whether the keyboard is in a box being typed into, which keeps its keys to itself.
export const writing = (target: EventTarget | null) => target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);

// The row on top of the page, said once for a file and for an empty tab.
export function Header({ children }: { children: ReactNode }) {
  return <header className="editor-header">{children}</header>;
}

// The magnifier, drawn on the header's button and in the picker's row: one glyph, whose size and colour come from where it
// is drawn.
export const Glass = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 4 4" /></svg>
);

// The address box: what is typed is resolved against the directory this visit points into, and the entry it names is
// opened.
export function Address({ context, base, navigate, report, address }: { context: UiContext; base?: FileClick; navigate: (file: FileClick) => void; report: (message: string) => void; address?: string }) {
  const shown = address ?? base?.path ?? '';
  const [path, setPath] = useState(shown);
  const request = useRef(0);
  useEffect(() => { setPath(shown); return () => { request.current++; }; }, [shown]);
  return <form className="editor-address" onSubmit={(event) => {
    event.preventDefault();
    if (!base || !path.trim()) return;
    const typed = path.trim();
    report('');
    // A comparison is addressed as a git:// resource, opened directly rather than resolved against the disk.
    if (typed.startsWith('git://')) { navigate({ type: 'file', machine: base.machine, path: typed }); return; }
    const id = ++request.current;
    void context.ui.request<FileClick>('resolve', { machine: base.machine, path: typed, base: directoryOf(base) })
      .then((file) => { if (id === request.current) navigate(file); })
      .catch((problem: Error) => { if (id === request.current) report(problem.message); });
  }}>
    <input className="editor-path" aria-label="路径" title={shown} value={path} spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => { request.current++; setPath(event.target.value); report(''); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { request.current++; setPath(shown); report(''); } }} />
  </form>;
}

// How long a page says what went wrong before it takes it back: a failure is news, so nothing a reader does or leaves
// undone keeps it up.
const noticeFor = 4000;

export function useNotice(): [string, (text: string) => void] {
  const [notice, report] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => report(''), noticeFor);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, report];
}

export function Notice({ text }: { text: string }) {
  return text ? <div className="notice" role="alert">{text}</div> : null;
}

// A panel laid over the text it is about: the backdrop under it takes the click that closes it, and its first row takes the
// keyboard wherever the focus was, so Escape reaches the panel, `j` and `k` walk its rows, and Enter opens what the row
// names.
export function Overlay({ className, role, label, at, onClose, children }: {
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

// The header a file and a comparison share: the way back and forward, the read again, the address, and the tail each view
// fills with its own — a language service for a file, a settings menu for a comparison.
export function Navigation({ context, file, navigate, back, forward, openSearch, dirty, markdown, preview, togglePreview, refresh, report, lsp, menu, refreshTitle, address }: PageProps & {
  dirty: boolean; markdown?: boolean; preview?: boolean; togglePreview?: () => void; refresh: () => void; report: (text: string) => void;
  lsp?: ReactNode; menu?: ReactNode; refreshTitle?: string; address?: string;
}) {
  return <Header>
    <button className="editor-icon" aria-label="后退" title="后退" disabled={!back} onClick={back}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 2 8l5 5 M2 8h12" /></svg>
    </button>
    <button className="editor-icon" aria-label="前进" title="前进" disabled={!forward} onClick={forward}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3 5 5-5 5 M2 8h12" /></svg>
    </button>
    <button className="editor-icon" aria-label="刷新" title={refreshTitle ?? '重读文件，并和这里的改动合并'} onClick={refresh}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.3 6.7A5.3 5.3 0 1 0 12 12 M13.3 2.7v4h-4" /></svg>
    </button>
    {markdown && <button className="editor-icon" aria-label="切换实时预览" aria-pressed={preview}
      title={preview ? '实时预览：开（点击看源码）' : '实时预览：关（点击渲染）'} onClick={togglePreview}>
      {preview
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12 M2 8h8 M2 12h10" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 4-3.5 4 3.5 4 M10.5 4l3.5 4-3.5 4" /></svg>}
    </button>}
    <Address context={context} base={file} navigate={navigate} report={report} address={address} />
    {dirty && <span className="editor-dirty" role="status" aria-label="有未写回的改动" title="有未写回的改动">*</span>}
    <div className="editor-tail">
      {lsp}
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
      {menu}
    </div>
  </Header>;
}
