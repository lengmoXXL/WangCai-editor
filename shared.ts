import type { FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';
import type { UiContext } from '@lengmoxxl/sdk/channel';
// Where a visited file was left: its cursor and the offset it was scrolled to.
export type Position = { line: number; column: number; top: number };
// A comparison's two buffers are visited independently under one git:// address; `side` tells which one an entry holds.
export type HistoryEntry = FileClick & Partial<Position> & { side?: 'a' | 'b' };
export type History = { entries: HistoryEntry[]; index: number };
// Where the cursor is in the file a tab shows: the click that opens the same place.
export type Cursor = FileClick & { line: number; column: number };

// The language service main.ts drives for a file: what the window asks for, what opening one gives back, and what it
// publishes while a server runs. Bytes cross the channel as base64, since every payload here is JSON.
export type OpenOptions = { machine: FileClick['machine']; path: string; language: string };
export type LspClose = { session: string };
export type LspSession = { session: string; server: string; root: string };
export type LspData = { session: string; data: string };
export type LspLog = { session: string; text: string };
export type LspExit = { session: string; code?: number };

// A search's rows: a match in a file's text, at the line and column the row jumps to.
export type SearchHit = { path: string; line: number; column: number; text: string };

// An image the preview draws: the type its name claims and its bytes as base64, since the page cannot reach the
// machine's disk for an <img> of its own and every payload on the channel is JSON.
export type ImageBytes = { mime: string; data: string };

// The identity of a machine: the id, plus the host that tells two machines with one id apart.
export const machineKey = (machine: FileClick['machine']) => `${machine.id}|${machine.host ?? ''}`;
// The identity of a file on a machine: the key a view, a service, and a cache all name it by.
export const fileKey = (file: Pick<FileClick, 'machine' | 'path'>) => `${machineKey(file.machine)}|${file.path}`;

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
type ServerOverride = { command?: string[]; markers?: string[] };
export type Settings = Profile & { font: Font; fontSizes?: Record<string, number>; lsp?: Record<string, ServerOverride | false> };

// A comparison of two sides of a file, as the diff pane reads it: the text of each, or a note why it cannot be read.
export interface Diff { oldText: string; newText: string; notice?: string; tooLarge?: number }
// What the diff pane asks main for: the machine, the absolute path, and the two sides as the git:// URI names them.
export interface DiffRequest { machine: FileClick['machine']; path: string; base: string; head: string; oldPath?: string; force?: boolean }

// The smallest edit that turns one text into another, so laying text into a view keeps the caret and the undo history.
export function editOf(current: string, next: string) {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from += 1;
  let end = 0;
  while (end < current.length - from && end < next.length - from && current[current.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  return { from, to: current.length - end, insert: next.slice(from, next.length - end) };
}

// One watch set: a change to a watched path asks again, and giving up the set clears the paths it held.
export const watch = (context: UiContext, machine: FileClick['machine'], holder: string, paths: string[], act: (path: string) => void) => {
  // The plugin can be disposed before either request lands, and the machine can be gone; neither is worth a pageerror.
  void context.ui.request('watch', { holder, machine, paths }).catch(() => undefined);
  const off = context.ui.subscribe<string>('changed', (path) => { if (paths.includes(path)) act(path); });
  return () => { off(); void context.ui.request('watch', { holder, machine, paths: [] }).catch(() => undefined); };
};
