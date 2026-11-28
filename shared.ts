import type { FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';
// Each side of a comparison has its own cursor and scroll position.
export type HistoryEntry = FileClick & { top?: number; side?: 'a' | 'b' };
export type History = { entries: HistoryEntry[]; index: number };
export type Cursor = FileClick & { line: number; column: number };

// The channel is JSON, so language-server bytes travel as base64.
export type OpenOptions = { machine: FileClick['machine']; path: string; language: string };
export type LspProcess = { session: string; generation: number };
export type LspSession = LspProcess & { server: string; root: string; exit?: { code?: number } };
export type LspData = LspProcess & { data: string };
export type LspLog = LspProcess & { text: string };
export type LspExit = LspProcess & { code?: number };

export type SearchHit = { path: string; line: number; column: number; text: string };

// Local images cross the same JSON channel.
export type ImageBytes = { mime: string; data: string };

// Different hosts can share a machine ID.
export const machineKey = (machine: FileClick['machine']) => `${machine.id}|${machine.host ?? ''}`;
export const fileKey = (file: Pick<FileClick, 'machine' | 'path'>) => `${machineKey(file.machine)}|${file.path}`;
export const directoryOf = (file: FileClick) => (file.type === 'directory' ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) || '/');

type Font = { family: string; size: number; lineHeight?: number };
type ServerOverride = { command?: string[]; markers?: string[] };
export type Settings = Profile & { font: Font; fontSizes?: Record<string, number>; lsp?: Record<string, ServerOverride | false> };

export interface Diff { oldText: string; newText: string; notice?: string; tooLarge?: number }
export interface GitUri { path: string; base: string; head: string; oldPath?: string }
export interface DiffRequest extends GitUri { machine: FileClick['machine']; force?: boolean }
