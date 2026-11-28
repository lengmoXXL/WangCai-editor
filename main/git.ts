import { posix } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { MachineConnection } from '@lengmoxxl/sdk';
import type { Diff, DiffRequest } from '../shared';
import { withCommandOutput } from './machines';

const diffLimit = 2 * 1024 * 1024;
const stages = new Map([[':index', '0'], [':ours', '2'], [':theirs', '3']]);
type Side = { token: string; path: string; tree?: string; entry?: { mode: string; hash: string } };

export async function readDiff(connection: MachineConnection, query: DiffRequest): Promise<Diff> {
  const flags = ['--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false'];
  const env = { GIT_OPTIONAL_LOCKS: '0' };
  const run = (cwd: string, args: string[]) => connection.subprocess.exec('git', [...flags, ...args], { cwd, env });
  const git = async (cwd: string, args: string[]) => {
    const { code, stdout, stderr } = await run(cwd, args);
    if (code !== 0) throw new Error(Buffer.from(stderr).toString().trim() || `git ${args[0]} failed (${code})`);
    return Buffer.from(stdout);
  };
  const repositoryPaths = async (absolute: string) => {
    if (!posix.isAbsolute(absolute) || absolute.includes('\0')) throw new Error('Invalid repository path');
    const parents: string[] = [];
    for (let dir = posix.dirname(absolute); ; dir = posix.dirname(dir)) {
      parents.push(dir);
      if (dir === '/') break;
    }
    // A link can lead into a checkout. Once inside, keep Git's original entry names even when a tracked directory became a link.
    const result = await connection.subprocess.exec('/bin/sh', ['-c', `inside=
for dir do
  if [ -n "$inside" ] && [ -L "$dir" ]; then break; fi
  if [ ! -e "$dir/.git" ]; then
    [ -z "$inside" ] && [ -L "$dir" ] && git -C "$dir" rev-parse --show-prefix >/dev/null 2>&1 || continue
  fi
  inside=1
  printf '%s\\0' "$dir"
  git -C "$dir" rev-parse --show-toplevel || exit 1
  printf '\\0'
  git -C "$dir" rev-parse --show-prefix || exit 1
  printf '\\0'
done
[ -n "$inside" ]`, 'sh', ...parents.reverse()], { cwd: '/', env });
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr).toString().trim() || 'Not a git repository');
    const paths = new Map<string, string>();
    const fields = Buffer.from(result.stdout).toString().split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [directory, root, prefix] = fields.slice(i, i + 3);
      const path = posix.join(prefix.replace(/\n$/, ''), posix.relative(directory, absolute));
      if (path === '.' || path.split('/').includes('..')) throw new Error('Invalid repository path');
      paths.set(root.replace(/\n$/, ''), path);
    }
    return paths;
  };
  const storedSide = async (root: string, token: string, path: string): Promise<Side> => {
    const side: Side = { token, path };
    if (token === ':empty' || token === ':worktree') return side;
    const stage = stages.get(token);
    let data: Buffer;
    if (stage) data = await git(root, ['ls-files', '--stage', '-z', '--', path]);
    else {
      // An unborn HEAD or the parent of a root commit is the empty side.
      const resolved = await run(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${token}^{tree}`]);
      if (resolved.code !== 0) return side;
      side.tree = Buffer.from(resolved.stdout).toString().trim();
      data = await git(root, ['ls-tree', '-z', side.tree, '--', path]);
    }
    for (const record of data.toString().split('\0')) {
      const tab = record.indexOf('\t');
      if (record.slice(tab + 1) !== path) continue;
      const fields = record.slice(0, tab).split(' ');
      if (stage) {
        const [mode, hash, entryStage] = fields;
        if (entryStage !== stage) continue;
        side.entry = { mode, hash };
      } else {
        const [mode, type, hash] = fields;
        if (type === 'tree') continue;
        side.entry = { mode, hash };
      }
      break;
    }
    return side;
  };
  const paths = await repositoryPaths(query.path);
  const oldPaths = query.oldPath ? await repositoryPaths(query.oldPath) : paths;
  const candidates = [];
  for (const [root, path] of [...paths].reverse()) {
    const oldPath = oldPaths.get(root);
    if (oldPath === undefined) continue;
    const [base, head] = await Promise.all([storedSide(root, query.base, oldPath), storedSide(root, query.head, path)]);
    let changed: boolean;
    if (base.token === ':worktree' || head.token === ':worktree') {
      changed = false;
      const stored = base.token === ':worktree' ? head : base;
      if (paths.size > 1 && oldPath === path && stored.entry) {
        const against = stored.tree ? [stored.tree] : stored.token === ':index' ? [] : [`--${stored.token.slice(1)}`];
        changed = (await run(root, ['diff', '--quiet', '--no-ext-diff', ...against, '--', path])).code === 1;
      }
    } else changed = base.entry?.mode !== head.entry?.mode || base.entry?.hash !== head.entry?.hash;
    candidates.push({ root, base, head, changed, entries: Number(!!base.entry) + Number(!!head.entry),
      revisions: Number(!!base.tree) + Number(!!head.tree) });
  }
  if (!candidates.length) throw new Error('Invalid repository path');
  // Both checkouts can resolve HEAD. When they describe the same change equally well, keep the nearest one.
  candidates.sort((a, b) => Number(b.changed) - Number(a.changed) || b.entries - a.entries || b.revisions - a.revisions);
  const { root, base, head } = candidates[0];
  let tooLarge = 0;
  const largeContent = (size: number, program: string, args: string[]) => {
    if (!query.force) { tooLarge = Math.max(tooLarge, size); return Buffer.alloc(0); }
    return withCommandOutput(connection, program, args, { cwd: root, env }, async ({ code, stderr }, chunks) => {
      if (code !== 0) throw new Error(Buffer.from(stderr).toString().trim() || `${program} failed (${code})`);
      return buffer(chunks);
    });
  };
  const blobOf = async (mode: string, hash: string): Promise<Buffer> => {
    if (mode === '160000') return Buffer.from(`Subproject commit ${hash}\n`);
    const size = Number((await git(root, ['cat-file', '-s', hash])).toString());
    if (size <= diffLimit) return git(root, ['cat-file', 'blob', hash]);
    return largeContent(size, 'git', [...flags, 'cat-file', 'blob', hash]);
  };
  const read = async ({ token, path, entry }: Side): Promise<Uint8Array> => {
    if (token === ':worktree') {
      const absolute = posix.join(root, path);
      // Git stores the link text, including for dangling links. The SDK's readFile follows the link.
      const link = await connection.subprocess.exec('readlink', ['-n', absolute], { cwd: root });
      if (link.code === 0) return link.stdout;
      if (!(await connection.fs.stat(absolute))?.isDirectory) {
        const length = await connection.subprocess.exec('wc', ['-c', absolute], { cwd: root });
        if (length.code !== 0) throw new Error(Buffer.from(length.stderr).toString().trim() || '无法读取文件大小');
        const size = parseInt(Buffer.from(length.stdout).toString(), 10);
        if (size <= diffLimit) return connection.fs.readFile(absolute);
        return largeContent(size, 'cat', [absolute]);
      }
      // An uninitialized submodule still has its recorded commit in the superproject's index.
      if (!(await connection.fs.stat(posix.join(absolute, '.git')))) {
        const { entry } = await storedSide(root, ':index', path);
        return entry?.mode === '160000' ? blobOf(entry.mode, entry.hash) : Buffer.alloc(0);
      }
      const commit = (await git(absolute, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
      const changes = await git(absolute, ['status', '--porcelain', '--untracked-files=normal']);
      return blobOf('160000', changes.length ? `${commit}-dirty` : commit);
    }
    return entry ? blobOf(entry.mode, entry.hash) : Buffer.alloc(0);
  };
  const oldBytes = await read(base);
  const newBytes = await read(head);
  const result: Diff = { oldText: '', newText: '' };
  const largest = Math.max(tooLarge, oldBytes.length, newBytes.length);
  if (largest > diffLimit && !query.force) return { ...result, tooLarge: largest };
  if (oldBytes.includes(0) || newBytes.includes(0)) return { ...result, notice: 'Binary files cannot be compared as text' };
  try {
    const decoder = new TextDecoder(undefined, { fatal: true });
    result.oldText = decoder.decode(oldBytes); result.newText = decoder.decode(newBytes);
  } catch { result.notice = 'Non-UTF-8 files cannot be compared as text'; }
  return result;
}
