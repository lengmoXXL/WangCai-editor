const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lspDot, shownPanel } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { openRust, pids, serverFor, unexpected } = require('./lsp-fixtures.cjs');

// The command this case runs as a server: it comes up, takes a write, and dies again. The probe below looks for that same
// command line, so the fixture and the probe cannot drift apart.
const dyingCommand = 'sleep 3; exit 1 # wangcai-dying-server';
// Its processes while they live: one per start, which is what the tries are counted by.
const dyingServers = () => pids(dyingCommand);

test('a server that keeps dying is left stopped once its tries are spent', { timeout: 180000 }, () => withWindow('wangcai-editor-tries-spent', serverFor('rust', ['/bin/sh', '-c', dyingCommand]), async ({ home, page, errors }) => {
  await openRust(home, page);
  // What the tries are worth is counted rather than timed: each start of this server is a process of its own, and once the
  // tries are spent no new one comes up.
  const started = new Set();
  let grownAt = Date.now();
  // The waits between tries add up to about eleven seconds and each life lasts three seconds, so the last start comes at
  // around twenty seconds; the window is long enough to watch twenty more go by without one.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const before = started.size;
    for (const pid of dyingServers()) started.add(pid);
    if (started.size > before) grownAt = Date.now();
    await page.waitForTimeout(250);
  }
  assert.ok(started.size > 0, 'the server was never started');
  // The stretch at the end of the window that no start has interrupted.
  assert.ok(Date.now() - grownAt > 20000, `a server started ${Date.now() - grownAt}ms ago`);
  await lspDot(shownPanel(page), 'closed').waitFor();
  // A server whose tries are spent is not a dead end: the dot starts it again by hand.
  const beforeClick = started.size;
  await lspDot(shownPanel(page), 'closed').click();
  await until(() => { for (const pid of dyingServers()) started.add(pid); return started.size > beforeClick; }, { timeout: 20000 });
  assert.deepEqual(unexpected(errors), []);
}));
