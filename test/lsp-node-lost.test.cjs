const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, refreshButton, showAfter } = require('./editor-ui.cjs');
const { until, wangcaiApp, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { languageServers, openTs, pids } = require('./lsp-fixtures.cjs');

// The agent a window talks to, whose going away takes every server it spawned with it.
const agent = join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai');
// Whether that agent is up again, which is the moment before the window's next request can reach it.
const agentRunning = (home) => pids('wangcai server start --foreground')
  .some((pid) => execFileSync('sh', ['-c', `ps eww -o command= -p ${pid} 2>/dev/null || true`], { encoding: 'utf8' }).includes(`HOME=${home}`));

test('a language server the node lost is started again by the window', { timeout: 180000 }, () => withWindow('wangcai-editor-node-lost', lists, async ({ home, page, errors }) => {
  const computeToken = 'computeTotal';
  const firstBody = `export function ${computeToken}() {\n  return 1;\n}\n`;
  const main = await openTs(home, page, firstBody, computeToken);
  // The process is looked for rather than assumed: lsof can miss one that has only just started.
  await until(() => languageServers(home).length === 1, { timeout: 30000 });
  // The agent goes away and takes its language server with it.
  execFileSync(agent, ['server', 'stop'], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
  await until(() => !languageServers(home).length, { timeout: 30000 });
  // The window reconnects to a fresh agent on its own; the next write then lands on a server that node no longer has,
  // which is the failure the window starts one again from.
  await until(() => agentRunning(home), { timeout: 60000 });
  const secondReturn = 'return 2;';
  const secondBody = `export function ${computeToken}() {\n  ${secondReturn}\n}\n`;
  writeFileSync(main, secondBody);
  await showAfter(page, refreshButton(page), secondReturn);
  await until(() => languageServers(home).length === 1, { timeout: 90000 });
  assert.deepEqual(errors, []);
}));
