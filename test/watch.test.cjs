const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeShowing, editorTab, lists, shownPanel, shows, showWritten, workspaceTabs } = require('./editor-ui.cjs');

// The file both cases open, and the text it is opened with.
const sampleFile = 'sample.ts';
const firstWord = 'CODE_FIRST';
const firstBody = `const first = "${firstWord}";\n`;

test('an open file shows what it holds now', { timeout: 180000 }, () => withWindow('wangcai-editor-watch-file', lists, async ({ home, page, errors }) => {
  const code = join(home, sampleFile);
  const secondWord = 'CODE_SECOND';
  const secondBody = `const second = "${secondWord}";\n`;
  await showWritten(page, code, firstBody, firstWord);
  const panel = shownPanel(page);
  await until(() => codeShowing(panel, secondWord).isVisible(), { act: () => writeFileSync(code, secondBody) });
  assert.ok(await shows(panel, code));
  assert.deepEqual(errors, []);
}));

test('a tab that is shown again follows the machine', { timeout: 180000 }, () => withWindow('wangcai-editor-watch-tab', lists, async ({ home, page, errors }) => {
  // A file of its own for the second workspace, so that the first tab is hidden while the change below arrives.
  const other = join(home, 'other.ts');
  const code = join(home, sampleFile);
  const otherWord = 'OTHER';
  const otherBody = `const other = "${otherWord}";\n`;
  const laterWord = 'CODE_LATER';
  const laterBody = `const first = "${laterWord}";\n`;
  const lastWord = 'CODE_LAST';
  const lastBody = `const first = "${lastWord}";\n`;
  await showWritten(page, code, firstBody, firstWord);
  await showWritten(page, other, otherBody, otherWord);
  writeFileSync(code, laterBody);
  // Showing the first tab again finds what the file holds now, and the watch is still on it.
  await until(() => codeShowing(shownPanel(page), laterWord).isVisible(), {
    act: async () => { await workspaceTabs(page).first().click(); await editorTab(page).click(); },
  });
  writeFileSync(code, lastBody);
  await until(() => codeShowing(shownPanel(page), lastWord).isVisible());
  assert.deepEqual(errors, []);
}));
