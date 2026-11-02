const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { countingServer, openRust, starts, unexpected } = require('./lsp-fixtures.cjs');

// The first three starts die at once, which spends the tries; the fourth stays up past the window, so its death earns one
// more start — the one a budget that never forgives would not make.
const forgiven = countingServer('attempts', '$n -ge 4');

test('a server that stayed up long enough is given its tries back', { timeout: 240000 }, () => withWindow('wangcai-editor-tries-back', forgiven.server, async ({ home, page, errors }) => {
  await openRust(home, page);
  await until(() => starts(forgiven.file) >= 5, { timeout: 120000 });
  rmSync(forgiven.file, { force: true });
  assert.deepEqual(unexpected(errors), []);
}));
