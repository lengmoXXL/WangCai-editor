import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type History, type SearchHit } from './shared';

export const keys = { '<leader>fe': { global: true, desc: '打开编辑器视图', event: 'core:show-view', data: { plugin: 'editor' } } };

// Fields this plugin takes from init.ts.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const probes = new Map<string, Promise<string | undefined>>();

  // A daemon started by the app does not inherit a login shell's PATH, so rg is looked up the way a login shell would
  // find it: the absolute path it prints is what runs.
  const locateRg = async (connection: MachineConnection, machine: FileClick['machine'], cwd: string) => {
    const key = machineKey(machine);
    let probe = probes.get(key);
    if (!probe) {
      probe = connection.subprocess
        .exec('/bin/sh', ['-c', 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; command -v rg'], { cwd })
        .then(({ stdout, code }) => {
          const found = Buffer.from(stdout).toString('utf8').trim();
          return code === 0 && found ? found : undefined;
        }, () => undefined);
      probes.set(key, probe);
    }
    return probe;
  };

  // One line of `rg --json` output: what kind of event it is — a match among others — the path it was found in, the line
  // it sits on with that line's text, and where in the line its hits start.
  type RgEvent = { type: string; data: { path?: { text: string }; line_number?: number; lines?: { text: string }; submatches?: { start: number }[] } };

  // How many lines a grep answer carries: the page draws fewer than this, and whether more were found is all it hears.
  const grepCeiling = 500;
  // How many paths a listing carries: the page ranks the whole list before it draws any of it, so this only keeps one
  // answer from being a repository's worth of paths.
  const pathCeiling = 20000;

  const rg = async (connection: MachineConnection, machine: FileClick['machine'], cwd: string, args: string[]) => {
    const command = await locateRg(connection, machine, cwd);
    if (!command) throw new Error('未找到 rg 命令，无法搜索');
    return connection.subprocess.exec(command, args, { cwd });
  };

  // One request runs on its own connection to a machine, closed again at the end unless the body keeps it: a watch
  // outlives the request that asked for it.
  const withConnection = async <T>(machine: FileClick['machine'], body: (connection: MachineConnection, keep: () => void) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    let kept = false;
    try {
      connection = await context.connect(machine, controller.signal);
      controller.signal.throwIfAborted();
      connections.add(connection);
      return await body(connection, () => { kept = true; });
    } finally {
      if (!kept && connection) {
        connection.disconnect();
        connections.delete(connection);
      }
      pending.delete(controller);
    }
  };

  const handlers = ['read', 'resolve'].map((method) => context.ui.handle(method, ({ machine, path, sessionId, base }: { machine: FileClick['machine']; path?: string; sessionId?: string; base?: string }) =>
    withConnection(machine, async (connection) => {
      if (method === 'resolve') {
        const target = path === undefined ? await connection.pty.cwd(sessionId!) : posix.resolve(base!, path);
        const stat = await connection.fs.stat(target);
        if (!stat) throw new Error(`路径不存在: ${target}`);
        return { type: stat.isDirectory ? 'directory' : 'file', machine, path: target };
      }
      const bytes = await connection.fs.readFile(path!);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('暂不支持二进制或非 UTF-8 文件'); }
      if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('暂不支持二进制文件');
      return text;
    })));

  // The paths a file search offers: what rg lists under a workspace, which leaves out what git ignores.
  handlers.push(context.ui.handle('find-files', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
    withConnection(machine, async (connection) => {
      const listed = await rg(connection, machine, path, ['--files', '--color', 'never']);
      if (listed.code !== 0) throw new Error(Buffer.from(listed.stderr).toString('utf8').trim() || '文件列表读取失败');
      const files = Buffer.from(listed.stdout).toString('utf8').split('\n').filter(Boolean);
      return { files: files.slice(0, pathCeiling).map((file) => posix.resolve(path, file)), truncated: files.length > pathCeiling };
    })));

  // A pattern's matches under a workspace, one row per line that holds it. rg is asked for JSON because a match then
  // carries the byte offsets of its hits.
  handlers.push(context.ui.handle('grep', ({ machine, path, query }: { machine: FileClick['machine']; path: string; query: string }) =>
    withConnection(machine, async (connection) => {
      const found = await rg(connection, machine, path, ['--json', '--smart-case', '--max-count', '10', '--max-filesize', '2M', '-e', query]);
      // A pattern that matched nothing is exit code 1, which is an empty list rather than a failure.
      if (found.code > 1) throw new Error(Buffer.from(found.stderr).toString('utf8').trim() || '搜索失败');
      const hits: SearchHit[] = [];
      for (const line of Buffer.from(found.stdout).toString('utf8').split('\n')) {
        let event: RgEvent;
        try { event = JSON.parse(line) as RgEvent; } catch { continue; }
        if (event.type !== 'match' || !event.data.path) continue;
        const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '');
        // The offset counts bytes, so the column counts the characters those bytes spell.
        const start = event.data.submatches?.[0]?.start ?? 0;
        hits.push({
          path: posix.resolve(path, event.data.path.text), line: event.data.line_number ?? 1,
          column: Buffer.from(text).subarray(0, start).toString('utf8').length + 1, text: text.trim(),
        });
      }
      return { hits: hits.slice(0, grepCeiling), truncated: hits.length > grepCeiling };
    })));

  // One watch set per tab: the window keeps a tab per workspace, and a tab that stops showing something must not stop
  // another tab's watch.
  const watchers = new Map<string, { key: string; connection: MachineConnection; close: () => void }>();
  const asked = new Map<string, string>();
  handlers.push(context.ui.handle('watch', async ({ holder, machine, paths }: { holder: string; machine: FileClick['machine']; paths: string[] }) => {
    const key = `${machineKey(machine)}|${JSON.stringify(paths)}`;
    asked.set(holder, key);
    const previous = watchers.get(holder);
    if (previous?.key === key) return;
    // What this tab watched before is given up, since it is about to watch what it shows now.
    if (previous) {
      previous.close();
      // The connection was held only while this tab watched something.
      previous.connection.disconnect();
      connections.delete(previous.connection);
      watchers.delete(holder);
    }
    if (!paths.length) return;
    await withConnection(machine, async (connection, keep) => {
      // A path that cannot be watched is skipped, so one bad path does not cost the others their watch.
      const closes = (await Promise.all(paths.map((path) =>
        connection.fs.watch(path, {}, () => context.ui.publish('changed', path)).catch(() => undefined))))
        .filter((close): close is () => void => close !== undefined);
      // A later request from the same tab took the set over while this one was connecting.
      if (asked.get(holder) !== key || !closes.length || watchers.has(holder)) {
        for (const close of closes) close();
        return;
      }
      keep();
      watchers.set(holder, { key, connection, close: () => { for (const close of closes) close(); } });
    });
  }));

  const historyPath = join(context.host.dataDirectory, 'history.json');
  handlers.push(
    context.ui.handle('history', () => existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {}),
    context.ui.handle('save-history', (history: Record<string, History>) => {
      writeFileSync(`${historyPath}.tmp`, JSON.stringify(history, null, 2));
      renameSync(`${historyPath}.tmp`, historyPath);
    }),
  );
  return async () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
