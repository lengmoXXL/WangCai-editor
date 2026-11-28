import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { directoryOf, type FileClick, type HistoryEntry } from '../shared';

// An explicit departure lets Back return to the jump site.
export type Navigate = (file: HistoryEntry, departure?: HistoryEntry) => void;
export type PageProps = { context: UiContext; file: HistoryEntry; navigate: Navigate; back?: () => void; forward?: () => void; openSearch?: () => void };

// The host dispatches keyboard events to the plugin root.
export const pageOf = (element: HTMLElement | null) => element?.closest<HTMLElement>('[data-plugin]');

export const writing = (target: EventTarget | null) => target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);

export const Glass = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 4 4" /></svg>
);

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
    // A git URI identifies a comparison outside the filesystem namespace.
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

export function Overlay({ className, role, label, at, onClose, children }: {
  className: string; role: 'menu' | 'dialog'; label: string; at?: CSSProperties; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus(); }, []);
  return <>
    <div className="editor-backdrop" onClick={onClose} />
    <div ref={panel} className={className} role={role} aria-label={label} style={at}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { onClose(); return; }
        const step = event.key === 'j' ? 1 : event.key === 'k' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')];
        const here = rows.findIndex((row) => row === document.activeElement);
        rows[Math.min(Math.max(here + step, 0), rows.length - 1)]?.focus();
      }}>
      {children}
    </div>
  </>;
}

export function Navigation({ context, file, navigate, back, forward, openSearch, dirty, markdown, preview, togglePreview, refresh, report, lsp, menu, refreshTitle, address }: PageProps & {
  dirty: boolean; markdown?: boolean; preview?: boolean; togglePreview?: () => void; refresh: () => void; report: (text: string) => void;
  lsp?: ReactNode; menu?: ReactNode; refreshTitle?: string; address?: string;
}) {
  const previewButton = useRef<HTMLButtonElement>(null);
  const openPreview = () => { void context.global.publish('preview:open', file); };
  useEffect(() => {
    // The window broadcasts leader keys to every tab. Only the visible header handles them.
    const offPreview = context.global.subscribe('editor:preview', () => {
      if (previewButton.current?.checkVisibility()) openPreview();
    });
    const offReveal = context.global.subscribe('editor:reveal', () => {
      if (previewButton.current?.checkVisibility()) void context.global.publish('files:reveal', file);
    });
    return () => { offPreview(); offReveal(); };
  }, [context, file]);
  return <header className="editor-header">
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
      <button ref={previewButton} className="editor-icon" aria-label="预览" title="在 preview 里打开当前文件" onClick={openPreview}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" /><circle cx="8" cy="8" r="1.8" /></svg>
      </button>
      {openSearch && <button className="editor-icon" aria-label="搜索" title="搜索" onClick={openSearch}>
        <Glass />
      </button>}
      {menu}
    </div>
  </header>;
}
