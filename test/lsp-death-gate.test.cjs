const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { clickFile, lists, lspDot, machine, shownPanel } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { languageServers, openTs, pids, unexpected } = require('./lsp-fixtures.cjs');
const { activate } = require('../main.cjs');

test('leaving the last language editor retires its server on every page type', { timeout: 120000 }, () => withWindow('wangcai-editor-leave-lsp', lists, async ({ home, page, errors }) => {
  const file = await openTs(home, page, 'export const answer = 1;\n', 'answer');
  const plain = join(home, 'note.txt');
  writeFileSync(plain, 'plain text');
  execFileSync('git', ['-C', home, 'init', '-q']);
  for (const path of [plain, `git://${file}@:empty~:worktree`, join(home, 'missing.ts')]) {
    await clickFile(page, { type: 'file', machine, path: file });
    await lspDot(shownPanel(page), 'open').waitFor();
    await until(() => languageServers(home).length === 1);
    await clickFile(page, { type: 'file', machine, path });
    await until(() => languageServers(home).length === 0);
  }
  assert.deepEqual(errors, []);
}));

test('a server whose stream is unavailable is closed before a replacement starts', async () => {
  let connected = true, nextId = 0, references = 0;
  const processes = new Set(), states = new Set(), handlers = new Map();
  let lost;
  const connection = {
    fs: { async stat() { return { isDirectory: true }; } },
    onState(listener) {
      states.add(listener);
      listener({ status: connected ? 'connected' : 'disconnected' });
      return () => states.delete(listener);
    },
    subprocess: {
      async exec() { return { code: 0, stdout: Buffer.from('/bin\0/bin/clangd\n') }; },
      async spawn() { const id = ++nextId; processes.add(id); return { id }; },
      async attach(id) {
        if (id === 1) { connected = false; throw new Error('connection lost'); }
        const exits = new Set();
        lost = () => { for (const listener of [...exits]) listener(undefined); };
        return { id, onData() {}, onExit(listener) { exits.add(listener); return () => exits.delete(listener); } };
      },
      async close(id) { processes.delete(id); },
    },
    disconnect() { references--; },
  };
  const dispose = activate({
    host: { config: {}, dataDirectory: __dirname },
    ui: { handle(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); }, publish() {} },
    async connect() { references++; return connection; },
  });
  const open = handlers.get('lsp-open');
  const file = { machine: { id: 'local' }, path: '/project/test.c', language: 'c' };
  try {
    await assert.rejects(open(file), /connection lost/);
    const replacement = open(file);
    await new Promise(setImmediate);
    assert.deepEqual([...processes], [1]);
    connected = true;
    for (const listener of states) listener({ status: 'connected' });
    await replacement;
    assert.deepEqual([...processes], [2]);
    connected = false;
    lost();
    const reconnected = open(file);
    await new Promise(setImmediate);
    assert.deepEqual([...processes], [2]);
    connected = true;
    for (const listener of states) listener({ status: 'connected' });
    await reconnected;
    assert.deepEqual([...processes], [3]);
  } finally {
    await dispose();
  }
  assert.equal(processes.size, 0);
  assert.equal(references, 0);
});

// The agent a window talks to, frozen rather than killed: the servers it holds stay up while the window's connection
// to it is down, which is the shape of a network outage.
const agentPids = (home) => pids('wangcai server start --foreground')
  .filter((pid) => execFileSync('sh', ['-c', `ps eww -o command= -p ${pid} 2>/dev/null || true`], { encoding: 'utf8' }).includes(`HOME=${home}`));

test('a restart asked for across a node outage leaves one server, the old one killed', { timeout: 240000 }, () => withWindow('wangcai-editor-death-gate', lists, async ({ home, page, errors }) => {
  const computeToken = 'computeTotal';
  await openTs(home, page, `export function ${computeToken}() {\n  return 1;\n}\n`, computeToken);
  await until(() => languageServers(home).length === 1, { timeout: 30000 });
  const old = languageServers(home)[0];
  // The node stops answering without dying, so the close a restart asks for cannot reach it now.
  const stopped = agentPids(home);
  assert.ok(stopped.length > 0, 'the agent was never found');
  // A reconnect's `server start` must not raise a second node while the first is frozen: hold the startup lock the
  // agent takes before it probes for a running one, so every start attempt waits out its timeout instead.
  const lock = spawn('python3', ['-c', 'import fcntl,sys,time; fcntl.flock(open(sys.argv[1], "a"), fcntl.LOCK_EX); print("held", flush=True); time.sleep(300)', join(home, '.local/share/wangcai/startup.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => lock.stdout.once('data', resolve));
  for (const pid of stopped) process.kill(Number(pid), 'SIGSTOP');
  // Past the heartbeat and the request timeouts, so the window's connection is down rather than merely delayed.
  await page.waitForTimeout(20000);
  try {
    await lspDot(shownPanel(page), 'open').click();
    // Let the doomed close and open settle, then watch for a spawn that must not come while the death is unconfirmed.
    await page.waitForTimeout(3000);
    assert.deepEqual(languageServers(home), [old], 'a server started while the old one was unconfirmed');
  } finally {
    for (const pid of stopped) process.kill(Number(pid), 'SIGCONT');
    lock.kill();
  }
  // Once the node answers again, the retried close kills the old server before a new one starts: the dot's missing
  // state is the restart whose open could not reach the node, and clicking it asks again.
  await until(() => !languageServers(home).includes(old), { timeout: 60000 });
  await lspDot(shownPanel(page), 'missing').click();
  await until(() => {
    const now = languageServers(home);
    return now.length === 1 && now[0] !== old;
  }, { timeout: 120000 });
  assert.deepEqual(unexpected(errors), []);
}));
