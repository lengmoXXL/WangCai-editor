const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { editorFocused, lists, openOn } = require('./editor-ui.cjs');

test('a key that shows the view puts the keys in its editor', { timeout: 180000 }, () => withWindow('wangcai-editor-keys', lists, async ({ home, page, errors }) => {
  const main = join(home, 'main.ts');
  writeFileSync(main, 'export const answer = 42;\n');
  await openOn(page, main, 'answer = 42');
  // The keys are elsewhere: no box in the window holds them.
  await page.evaluate(() => document.activeElement?.blur());
  // The leader is a space unless `init.ts` says otherwise.
  for (const key of ['Space', 'f', 'e']) await page.keyboard.press(key);
  // Nothing is clicked between the key and the caret.
  await until(() => editorFocused(page));
  assert.deepEqual(errors, []);
}));
