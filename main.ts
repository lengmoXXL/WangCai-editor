import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MachineConnection, Process } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type History, type LspClose, type LspData, type LspSession, type OpenOptions, type SearchHit, type Settings } from './shared';

// The keys this plugin brings: `<leader>e` shows the view wherever the keys are, while the other two name no `global`
// and so answer only while this page holds them — they go out as events, since the file they act on is the one the page
// on show reads, which the main process has no view of.
export const keys = {
  '<leader>e': { global: true, insert: true, desc: '打开编辑器视图', event: 'core:show-view', data: { plugin: 'editor' } },
  '<leader>gp': { insert: true, desc: '在 preview 里打开当前文件', event: 'editor:preview' },
  '<leader>gf': { insert: true, desc: '在 files 里打开文件所在的目录', event: 'editor:reveal' },
};

// Fields this plugin takes from init.ts.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
  // Per-language entries from init.ts, keyed by the language this plugin reads a file as: a command or markers replaces
  // that one default below, false turns the language off, and a language that is not named here keeps its defaults.
  lsp: { type: 'object' },
};

type LanguageServer = { commands: string[][]; markers: string[] };

// The language servers this plugin knows, per language: what to run, and the files that mark the root a server should
// index. A command carries its own arguments, since stdio is not every server's default.
const typescript = { commands: [['typescript-language-server', '--stdio']], markers: ['tsconfig.json', 'jsconfig.json', 'package.json'] };
const clangd = { commands: [['clangd']], markers: ['compile_commands.json', '.clangd', 'CMakeLists.txt'] };
const languageServers: Record<string, LanguageServer> = {
  typescript: typescript, javascript: typescript, typescriptreact: typescript, javascriptreact: typescript,
  go: { commands: [['gopls']], markers: ['go.mod', 'go.work'] },
  rust: { commands: [['rust-analyzer']], markers: ['Cargo.toml'] },
  c: clangd, cpp: clangd,
  java: { commands: [['jdtls']], markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  python: { commands: [['pyright-langserver', '--stdio'], ['pylsp']], markers: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
  shell: { commands: [['bash-language-server', 'start']], markers: [] },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const sessions = new Map<string, { connection: MachineConnection; handle: Process }>();
  // The servers being started now, so a view that shows the file again while one is on its way joins it rather than
  // starting a second.
  const starts = new Map<string, Promise<void>>();
  // A program found on a machine, and the PATH a login shell would give it.
  const probes = new Map<string, Promise<{ program: string; envPath: string } | undefined>>();
  const settings: Settings = context.host.config;

  // A daemon started by the app does not inherit a login shell's PATH, so a program is looked up and started with the PATH
  // a login shell would have: the absolute path finds the program, and that PATH is what the program itself resolves its
  // interpreter with.
  const locate = async (connection: MachineConnection, machine: FileClick['machine'], candidates: string[][], cwd: string) => {
    for (const [program, ...args] of candidates) {
      const key = `${machineKey(machine)}|${program}`;
      let probe = probes.get(key);
      if (!probe) {
        probe = connection.subprocess
          .exec('/bin/sh', ['-c', 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; printf "%s\\n" "$PATH"; command -v "$1"', 'sh', program], { cwd })
          .then(({ stdout, code }) => {
            const [envPath, found] = Buffer.from(stdout).toString('utf8').trim().split('\n');
            return code === 0 && found ? { program: found, envPath } : undefined;
          }, () => undefined);
        probes.set(key, probe);
      }
      const found = await probe;
      if (found) return { ...found, args };
    }
    return undefined;
  };

  // The nearest ancestor holding a marker of this language or the repository root, and the directory itself when
  // neither marks one.
  const findRoot = async (connection: MachineConnection, directory: string, markers: string[]) => {
    const names = ['.git', ...markers];
    for (let current = directory; ; ) {
      for (const name of names) if (await connection.fs.stat(posix.join(current, name))) return current;
      const parent = posix.dirname(current);
      if (parent === current) return directory;
      current = parent;
    }
  };

  // The server a language runs here: the built-in one, with whatever init.ts says about that language on top.
  const serverSpec = (language: string): LanguageServer | undefined => {
    const override = settings.lsp?.[language];
    if (override === false) return undefined;
    const builtin = languageServers[language];
    const commands = override?.command ? [override.command] : builtin?.commands;
    return commands && { commands, markers: override?.markers ?? builtin?.markers ?? [] };
  };

  // One line of `rg --json` output: what kind of event it is — a match among others — the path it was found in, the line
  // it sits on with that line's text, and where in the line its hits start.
  type RgEvent = { type: string; data: { path?: { text: string }; line_number?: number; lines?: { text: string }; submatches?: { start: number }[] } };

  // How many lines a grep answer carries: the page draws only the first rows of it, so this cap never shows itself; it keeps
  // one answer from crossing the channel whole.
  const grepCeiling = 500;
  // How many paths a listing carries: the page ranks the whole list before it draws any of it, so this only keeps one
  // answer from being a repository's worth of paths.
  const pathCeiling = 20000;

  const rg = async (connection: MachineConnection, machine: FileClick['machine'], cwd: string, args: string[]) => {
    const located = await locate(connection, machine, [['rg']], cwd);
    if (!located) throw new Error('未找到 rg 命令，无法搜索');
    return connection.subprocess.exec(located.program, args, { cwd });
  };

  // The server a language and root share, started on this connection or handed back from the one already running or on its
  // way: two views that ask for a file at the same moment share one spawn.
  const startServer = async (connection: MachineConnection, { machine, path, language }: OpenOptions, keep: () => void): Promise<LspSession | null> => {
    const spec = serverSpec(language);
    if (!spec) return null;
    const directory = posix.dirname(path);
    const located = await locate(connection, machine, spec.commands, directory);
    if (!located) throw new Error(`未找到 ${spec.commands.map(([program]) => program).join(' / ')}`);
    const root = await findRoot(connection, directory, spec.markers);
    const name = posix.basename(located.program);
    const session = `${machineKey(machine)}|${language}|${root}`;
    let start = starts.get(session);
    if (!sessions.has(session) && !start) {
      start = (async () => {
        const info = await connection.subprocess.spawn(located.program, located.args, { cwd: root, env: { PATH: located.envPath } });
        const handle = await connection.subprocess.attach(info.id);
        keep();
        sessions.set(session, { connection, handle });
        handle.onData(({ stream, data }) => {
          if (stream === 'stdout') context.ui.publish('lsp-data', { session, data: Buffer.from(data).toString('base64') });
          else context.ui.publish('lsp-log', { session, text: Buffer.from(data).toString('utf8').trimEnd() });
        });
        handle.onExit((code) => {
          // A session a restart has already replaced belongs to the new process, so its exit is not the window's.
          if (sessions.get(session)?.handle.id === handle.id) {
            sessions.delete(session);
            context.ui.publish('lsp-exit', { session, code });
          }
          connection.disconnect();
          connections.delete(connection);
        });
      })();
      starts.set(session, start);
      const settle = () => starts.delete(session);
      void start.then(settle, settle);
    }
    if (start) await start;
    return { session, server: name, root };
  };

  // A server the window is done with: its process is closed, and the connection it ran on goes with it.
  const closeServer = async (session: string) => {
    const running = sessions.get(session);
    if (!running) return;
    sessions.delete(session);
    connections.delete(running.connection);
    await running.connection.subprocess.close(running.handle.id).catch(() => undefined);
    running.connection.disconnect();
  };

  // One request runs on its own connection to a machine, closed again at the end unless the body keeps it: a watch
  // outlives the request that asked for it, and a server outlives the open that started it.
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

  // What the page writes back: the text it holds, whole, over the file it was read from.
  handlers.push(context.ui.handle('write', ({ machine, path, text }: { machine: FileClick['machine']; path: string; text: string }) =>
    withConnection(machine, (connection) => connection.fs.writeFile(path, Buffer.from(text, 'utf8')))));

  // The paths a file search offers: what rg lists under a workspace, which leaves out what git ignores.
  handlers.push(context.ui.handle('find-files', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
    withConnection(machine, async (connection) => {
      const listed = await rg(connection, machine, path, ['--files', '--color', 'never']);
      if (listed.code !== 0) throw new Error(Buffer.from(listed.stderr).toString('utf8').trim() || '文件列表读取失败');
      const files = Buffer.from(listed.stdout).toString('utf8').split('\n').filter(Boolean);
      return files.slice(0, pathCeiling).map((file) => posix.resolve(path, file));
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
      return hits.slice(0, grepCeiling);
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

  handlers.push(
    context.ui.handle('lsp-open', (options: OpenOptions) =>
      withConnection(options.machine, (connection, keep) => startServer(connection, options, keep))),
    context.ui.handle('lsp-write', async ({ session, data }: LspData) => {
      const running = sessions.get(session);
      if (!running) throw new Error('语言服务已关闭');
      await running.handle.write(Buffer.from(data, 'base64'));
    }),
    // The window asks for this whenever it stops wanting a server: a restart by hand, a revival retiring the one that went
    // away, a tab that leaves no file needing it, or a view that left while its server was still starting. The process is
    // closed here and no exit event goes out: the window that asked has already dropped its own session.
    context.ui.handle('lsp-close', ({ session }: LspClose) => closeServer(session)),
  );

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
    // Closing the servers first, so nothing is left running on the machine once the window is gone; the connections left
    // after them are the ones a watch keeps.
    await Promise.all([...sessions.keys()].map(closeServer));
    for (const connection of connections) connection.disconnect();
  };
}
