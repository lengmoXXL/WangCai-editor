import { posix } from 'node:path';
import type { MachineConnection, Process } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { locate, type machineAccess } from './machines';
import { machineKey, type LspProcess, type LspData, type LspSession, type OpenOptions, type Settings } from '../shared';

type LanguageServer = { commands: string[][]; markers: string[] };

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
  markdown: { commands: [['markdown-oxide']], markers: ['.obsidian'] },
};

type Spawned = { connection: MachineConnection; id: string; release: () => void };
type Running = Spawned & { handle: Process; info: LspSession };

export function registerLanguageServers(context: MainContext, machines: ReturnType<typeof machineAccess>) {
  const sessions = new Map<string, Running>();
  const starts = new Map<string, Promise<LspSession>>();
  const closing = new Map<string, Promise<void>>();
  const settings: Settings = context.host.config;
  let stopping = false;
  let generation = 0;

  // Only these SDK errors confirm process death. A timeout or disconnect still leaves the process running.
  const nodeRefusal = (error: unknown) =>
    /no longer exists|Process has exited/.test(String((error as Error)?.message ?? error));

  // A replacement must wait for confirmed death, even if the connection drops during close.
  const confirmDeath = (session: string, { connection, id, release, handle }: Spawned & { handle?: Process }): Promise<void> => {
    const held = closing.get(session);
    if (held) return held;
    let finish!: () => void;
    const confirmed = new Promise<void>((resolve) => { finish = resolve; });
    const done = confirmed.then(() => {
      closing.delete(session);
      offState();
      offExit?.();
      release();
    });
    closing.set(session, done);
    const offState = connection.onState((state) => {
      if (state.status !== 'connected') return;
      void connection.subprocess.close(id).then(finish, (error: unknown) => {
        if (nodeRefusal(error)) finish();
      });
    });
    const offExit = handle?.onExit(code => { if (code !== undefined) finish(); });
    return done;
  };

  const closeServer = (running: Running) => {
    const { session } = running.info;
    sessions.delete(session);
    void confirmDeath(session, running);
  };

  const findRoot = async (connection: MachineConnection, directory: string, markers: string[]) => {
    const names = ['.git', ...markers];
    for (let current = directory; ; ) {
      for (const name of names) if (await connection.fs.stat(posix.join(current, name))) return current;
      const parent = posix.dirname(current);
      if (parent === current) return directory;
      current = parent;
    }
  };

  const open = async ({ machine, path, language }: OpenOptions) => {
    const override = settings.lsp?.[language];
    if (override === false) return null;
    const builtin = languageServers[language];
    const commands = override?.command ? [override.command] : builtin?.commands;
    if (!commands) return null;
    return machines.withConnection(machine, async (connection, keep) => {
      const directory = posix.dirname(path);
      const root = await findRoot(connection, directory, override?.markers ?? builtin?.markers ?? []);
      const located = await locate(connection, commands, root);
      if (!located) throw new Error(`未找到 ${commands.map(([program]) => program).join(' / ')}`);
      const executable = located.program.includes('/') ? posix.resolve(root, located.program) : located.program;
      const session = `${machineKey(machine)}|${JSON.stringify([executable, ...located.args])}|${root}`;
      const existing = sessions.get(session);
      if (existing) return existing.info;
      let start = starts.get(session);
      if (!start) {
        start = (async () => {
          // A replacement waits until the node confirms the previous process is gone: an unconfirmed death is a close
          // still being retried, and spawning past it would put two servers on one project.
          await closing.get(session);
          if (stopping) throw new Error('语言服务已关闭');
          const { id } = await connection.subprocess.spawn(located.program, located.args, { cwd: root, env: { PATH: located.envPath } });
          const spawned = { connection, id, release: keep() };
          let handle: Process;
          try {
            handle = await connection.subprocess.attach(id);
          } catch (error) {
            void confirmDeath(session, spawned);
            throw error;
          }
          const process: LspProcess = { session, generation: ++generation };
          const info: LspSession = { ...process, server: posix.basename(located.program), root };
          const running = { ...spawned, handle, info };
          sessions.set(session, running);
          handle.onData(({ stream, data }) => {
            if (stream === 'stdout') context.ui.publish('lsp-data', { ...process, data: Buffer.from(data).toString('base64') });
            else context.ui.publish('lsp-log', { ...process, text: Buffer.from(data).toString('utf8').trimEnd() });
          });
          handle.onExit((code) => {
            if (sessions.get(session) !== running) return;
            sessions.delete(session);
            // The SDK may deliver an exit synchronously, before the renderer receives the open reply.
            info.exit = { code };
            // Losing the stream leaves the process ID live until the node acknowledges its close.
            if (code === undefined) void confirmDeath(session, running);
            else running.release();
            context.ui.publish('lsp-exit', { ...process, code });
          });
          if (stopping) { closeServer(running); throw new Error('语言服务已关闭'); }
          return info;
        })();
        starts.set(session, start);
        const settle = () => starts.delete(session);
        void start.then(settle, settle);
      }
      return start;
    });
  };

  const handlers = [
    context.ui.handle('lsp-open', open),
    context.ui.handle('lsp-write', async ({ session, generation, data }: LspData) => {
      const running = sessions.get(session);
      if (!running || running.info.generation !== generation) throw new Error('语言服务已关闭');
      try {
        await running.handle.write(Buffer.from(data, 'base64'));
      } catch (error) {
        // A node refusal ends the process. Transport errors leave it eligible to reconnect.
        if (sessions.get(session) === running && nodeRefusal(error)) {
          sessions.delete(session);
          void confirmDeath(session, running);
          context.ui.publish('lsp-exit', { session, generation });
        }
        throw error;
      }
    }),
    context.ui.handle('lsp-close', ({ session, generation }: LspProcess) => {
      const running = sessions.get(session);
      if (running && running.info.generation === generation) closeServer(running);
    }),
  ];

  return async () => {
    stopping = true;
    for (const remove of handlers) remove();
    // An offline node must not hold the plugin open indefinitely.
    for (const running of sessions.values()) closeServer(running);
    const grace = new Promise((resolve) => { setTimeout(resolve, 5000).unref(); });
    const stopped = Promise.allSettled(starts.values()).then(() => Promise.all(closing.values()));
    await Promise.race([stopped, grace]);
  };
}
