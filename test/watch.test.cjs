const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, editorTab, goToPath, lists, openEditorWorkspace, pathBox, shownPanel, workspaceTabs } = require('./editor-ui.cjs');

test('an open file shows what it holds now', { timeout: 180000 }, () => withWindow('wangcai-editor-watch-file', lists, async ({ home, page, errors }) => {
  const code = join(home, 'sample.ts');
  writeFileSync(code, 'const first = "CODE_FIRST";\n');
  await openEditorWorkspace(page);
  const panel = shownPanel(page);
  await goToPath(panel, code);
  await codeView(panel, 'CODE_FIRST').waitFor();
  await until(() => codeView(panel, 'CODE_SECOND').isVisible(), { act: () => writeFileSync(code, 'const second = "CODE_SECOND";\n') });
  assert.equal(await pathBox(panel).inputValue(), code);
  assert.deepEqual(errors, []);
}));

test('a tab that is shown again follows the machine', { timeout: 180000 }, () => withWindow('wangcai-editor-watch-tab', lists, async ({ home, page, errors }) => {
  // A file of its own for the second workspace, so that the first tab is hidden while the change below arrives.
  const other = join(home, 'other.ts');
  const code = join(home, 'sample.ts');
  writeFileSync(code, 'const first = "CODE_FIRST";\n');
  writeFileSync(other, 'const other = "OTHER";\n');
  await openEditorWorkspace(page);
  await goToPath(shownPanel(page), code);
  await codeView(shownPanel(page), 'CODE_FIRST').waitFor();
  await openEditorWorkspace(page);
  await goToPath(shownPanel(page), other);
  await codeView(shownPanel(page), 'OTHER').waitFor();
  writeFileSync(code, 'const first = "CODE_LATER";\n');
  // Showing the first tab again finds what the file holds now, and the watch is still on it.
  await until(() => codeView(shownPanel(page), 'CODE_LATER').isVisible(), {
    act: async () => { await workspaceTabs(page).first().click(); await editorTab(page).click(); },
  });
  writeFileSync(code, 'const first = "CODE_LAST";\n');
  await until(() => codeView(shownPanel(page), 'CODE_LAST').isVisible());
  assert.deepEqual(errors, []);
}));
