const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { diagnostics, lspDetail, lspDot, shownPanel } = require('./editor-ui.cjs');
const { openRust, serverFor, starts, unexpected } = require('./lsp-fixtures.cjs');

const server = serverFor('rust', [process.execPath, join(__dirname, 'opens-server.cjs'), '4']);

test('the status dot restarts a server after its three automatic retries fail', { timeout: 90000 }, () => withWindow('wangcai-editor-tries-spent', server, async ({ home, page, errors }) => {
  await openRust(home, page);
  const panel = shownPanel(page);
  await lspDetail(panel).getByText('语言服务已退出 (4)', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(starts(home), 4);
  await lspDot(panel, 'closed').click();
  await lspDot(panel, 'open').waitFor();
  await diagnostics(panel).first().waitFor();
  assert.equal(starts(home), 5);
  assert.deepEqual(unexpected(errors), []);
}));
