import type { FileClick, Profile } from '@lengmoxxl/sdk';
export type { FileClick } from '@lengmoxxl/sdk';
// Where a visited file was left: its cursor and the offset it was scrolled to.
export type Position = { line: number; column: number; top: number };
export type HistoryEntry = FileClick & Partial<Position>;
export type History = { entries: HistoryEntry[]; index: number };

// A search's rows: a match in a file's text, at the line and column the row jumps to.
export type SearchHit = { path: string; line: number; column: number; text: string };

// The identity of a machine: the id, plus the host that tells two machines with one id apart.
export const machineKey = (machine: FileClick['machine']) => `${machine.id}|${machine.host ?? ''}`;

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font };
