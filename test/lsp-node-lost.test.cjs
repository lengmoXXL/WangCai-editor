const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { lists, localMachineState, refreshButton, showAfter } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { languageServers, nodeServer, openTs } = require('./lsp-fixtures.cjs');

test('a language server the node lost is started again by the window', { timeout: 180000 }, () => withWindow('wangcai-editor-node-lost', lists, async ({ home, env, page, errors }) => {
  const computeToken = 'computeTotal';
  const firstBody = `export function ${computeToken}() {\n  return 1;\n}\n`;
  const main = await openTs(home, page, firstBody, computeToken);
  await until(() => languageServers(home).length === 1, { timeout: 30000 });
  const initial = await localMachineState(page);
  assert.equal(initial.status, 'connected');
  nodeServer(env, 'stop');
  await until(() => !languageServers(home).length, { timeout: 30000 });
  await until(async () => {
    const state = await localMachineState(page);
    return state?.status === 'connected' && state.generation > initial.generation;
  }, { timeout: 60000 });
  const secondReturn = 'return 2;';
  const secondBody = `export function ${computeToken}() {\n  ${secondReturn}\n}\n`;
  writeFileSync(main, secondBody);
  await showAfter(page, refreshButton(page), secondReturn);
  await until(() => languageServers(home).length === 1, { timeout: 90000 });
  assert.deepEqual(errors, []);
}));
