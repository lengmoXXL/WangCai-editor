const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { join } = require('node:path');
const { lists, lspDot, shownPanel } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { languageServers, openTs, pids, unexpected } = require('./lsp-fixtures.cjs');

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
