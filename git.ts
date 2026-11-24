import { posix } from 'node:path';
import type { Diff } from './shared';

export type RunGit = (cwd: string, args: string[]) => Promise<{ stdout: Buffer; stderr: string; code: number }>;
type Git = (args: string[]) => Promise<Buffer>;
const gitOf = (cwd: string, run: RunGit): Git => async (args) => {
  const result = await run(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
  return result.stdout;
};

// Both sides of a text diff are loaded whole and handed to the pane; past this size the pane asks before loading.
const diffLimit = 2 * 1024 * 1024;

export interface DiffQuery { root: string; path: string; oldPath?: string; base: string; head: string; force?: boolean }

// The two sides a comparison names, each resolved to its bytes: a revision reads the tree it names, the index tokens
// read the staged entries, :worktree reads the file on disk, and :empty is the absence a new or deleted side stands for.
export async function readDiff(query: DiffQuery, run: RunGit, readFile: (path: string) => Promise<Uint8Array>): Promise<Diff> {
  const git = gitOf(query.root, run);
  for (const path of [query.path, query.oldPath ?? query.path]) {
    if (!path || path.includes('\0') || posix.isAbsolute(path) || path.split('/').includes('..')) throw new Error('Invalid repository path');
  }
  let tooLarge = 0;
  const byHash = async (hash: string): Promise<Buffer> => {
    const size = Number((await git(['cat-file', '-s', hash])).toString());
    if (size > diffLimit && !query.force) { tooLarge = Math.max(tooLarge, size); return Buffer.alloc(0); }
    return git(['cat-file', 'blob', hash]);
  };
  const blobOf = (mode: string, hash: string): Promise<Buffer> =>
    mode === '160000' ? Promise.resolve(Buffer.from(`Subproject commit ${hash}\n`)) : byHash(hash);
  const entry = (records: string[], path: string, pick: (fields: string[]) => boolean) => {
    const found = records.find(record => {
      const tab = record.indexOf('\t');
      return record.slice(tab + 1) === path && pick(record.slice(0, tab).split(' '));
    });
    if (!found) return undefined;
    const [mode, typeOrHash, hashOrStage] = found.slice(0, found.indexOf('\t')).split(' ');
    return { mode, typeOrHash, hashOrStage };
  };
  const index = async (path: string, stage: string): Promise<Buffer> => {
    const records = (await git(['ls-files', '--stage', '-z', '--', path])).toString().split('\0');
    const found = entry(records, path, fields => fields[2] === stage);
    if (!found) return Buffer.alloc(0);
    return blobOf(found.mode, found.typeOrHash);
  };
  const tree = async (rev: string, path: string): Promise<Buffer> => {
    // A revision that does not resolve (an unborn HEAD, the parent of a root commit) is the empty side.
    const resolved = await run(query.root, ['rev-parse', '--verify', '--quiet', rev]);
    if (resolved.code !== 0) return Buffer.alloc(0);
    const records = (await git(['ls-tree', '-z', resolved.stdout.toString().trim(), '--', path])).toString().split('\0');
    const found = entry(records, path, () => true);
    if (!found) return Buffer.alloc(0);
    return blobOf(found.mode, found.hashOrStage);
  };
  const side = (token: string, path: string): Promise<Uint8Array> => {
    if (token === ':empty') return Promise.resolve(Buffer.alloc(0));
    if (token === ':worktree') return readFile(posix.join(query.root, path));
    if (token === ':index') return index(path, '0');
    if (token === ':ours') return index(path, '2');
    if (token === ':theirs') return index(path, '3');
    return tree(token, path);
  };
  const oldBytes = await side(query.base, query.oldPath ?? query.path);
  const newBytes = await side(query.head, query.path);
  const result: Diff = { oldText: '', newText: '' };
  const largest = Math.max(tooLarge, oldBytes.length, newBytes.length);
  if (largest > diffLimit && !query.force) return { ...result, tooLarge: largest };
  if (oldBytes.includes(0) || newBytes.includes(0)) return { ...result, notice: 'Binary files cannot be compared as text' };
  try {
    const decoder = new TextDecoder(undefined, { fatal: true });
    result.oldText = decoder.decode(oldBytes); result.newText = decoder.decode(newBytes);
  } catch { result.notice = 'Non-UTF-8 files cannot be compared as text' };
  return result;
}
