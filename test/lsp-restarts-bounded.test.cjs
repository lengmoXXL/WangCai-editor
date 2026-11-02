const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { countingServer, openRust, starts, unexpected } = require('./lsp-fixtures.cjs');

// The first start stays up past the window and every later start exits at once, so the starts that follow are the ones a
// spent budget allows.
const bounded = countingServer('bounded', '$n -eq 1');

test('a healthy server\'s death leaves the restarts after it bounded', { timeout: 240000 }, () => withWindow('wangcai-editor-restarts-bounded', bounded.server, async ({ home, page, errors }) => {
  await openRust(home, page);
  // Its death has been met by now, so the tries after it are on their way.
  await until(() => starts(bounded.file) >= 2, { timeout: 120000 });
  // Four starts is the first server plus the three tries its death earns: the waits between them add up to about eleven
  // seconds, and the window leaves room for all three to be spent.
  await page.waitForTimeout(25000);
  assert.ok(starts(bounded.file) <= 4, `started ${starts(bounded.file)} times`);
  rmSync(bounded.file, { force: true });
  assert.deepEqual(unexpected(errors), []);
}));
