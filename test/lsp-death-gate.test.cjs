const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { clickFile, lists, localMachineState, lspDot, machine, shownPanel } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { languageServers, nodeServer, openTs, unexpected } = require('./lsp-fixtures.cjs');

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

test('a restart asked for across a node outage leaves one server, the old one killed', { timeout: 240000 }, (t) => withWindow('wangcai-editor-death-gate', lists, async ({ home, env, page, errors }) => {
  const computeToken = 'computeTotal';
  await openTs(home, page, `export function ${computeToken}() {\n  return 1;\n}\n`, computeToken);
  let servers;
  await until(() => (servers = languageServers(home)).length === 1, { timeout: 30000 });
  const [old] = servers;
  const panel = shownPanel(page);
  const { pid } = JSON.parse(nodeServer(env, 'status', '--json'));
  // Holding the startup lock keeps a reconnect from replacing the paused node.
  const pause = spawn('python3', [join(__dirname, 'pause-node.py'), join(home, '.local/share/wangcai/startup.lock'), String(pid)],
    { stdio: ['pipe', 'pipe', 'inherit'], signal: t.signal });
  const exited = once(pause, 'close');
  try {
    await Promise.race([once(pause.stdout, 'data'), exited.then(() => { throw new Error('outage fixture exited before pausing the node'); })]);
    await until(async () => (await localMachineState(page))?.status === 'connecting', { timeout: 60000 });
    await lspDot(panel, 'open').click();
    await lspDot(panel, 'missing').waitFor();
    assert.deepEqual(languageServers(home), [old], 'a server started while the old one was unconfirmed');
  } finally {
    pause.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, 'the outage fixture failed');
  }
  await until(() => !languageServers(home).includes(old), { timeout: 60000 });
  await lspDot(panel, 'missing').click();
  await until(() => {
    const now = languageServers(home);
    return now.length === 1 && now[0] !== old;
  }, { timeout: 120000 });
  assert.deepEqual(unexpected(errors), []);
}));
