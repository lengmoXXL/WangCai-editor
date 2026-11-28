const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, renameSync, symlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { clickFile, codeShowing, editorTab, lists, machine, openEditorWorkspace, refreshButton, shownPanel, shows, showWritten, workspaceTabs } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

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

test('refreshing a newly created file restores its watch', { timeout: 90000 }, () => withWindow('wangcai-editor-watch-created', lists, async ({ home, page, errors }) => {
  const path = join(home, 'created.txt');
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path });
  const panel = shownPanel(page);
  await panel.getByRole('alert').waitFor();
  writeFileSync(path, 'created');
  await refreshButton(panel).click();
  await codeShowing(panel, 'created').waitFor();
  writeFileSync(path, 'edited elsewhere');
  await codeShowing(panel, 'edited elsewhere').waitFor();
  assert.deepEqual(errors, []);
}));

test('a watched link follows atomic saves and a replacement target in another directory', () => withWindow('wangcai-editor-watch-link', lists, async ({ home, page, errors }) => {
  const directory = join(home, 'files'), link = join(home, 'current.txt');
  mkdirSync(directory);
  const first = join(directory, 'first'), next = join(directory, 'next'), staging = join(home, 'staging');
  writeFileSync(first, 'initial');
  symlinkSync(first, link);
  await openEditorWorkspace(page);
  const panel = shownPanel(page);
  await clickFile(page, { type: 'file', machine, path: link });
  await codeShowing(panel, 'initial').waitFor();
  writeFileSync(staging, 'atomic save');
  renameSync(staging, first);
  await codeShowing(panel, 'atomic save').waitFor();
  writeFileSync(next, 'next target');
  symlinkSync(next, staging);
  renameSync(staging, link);
  await codeShowing(panel, 'next target').waitFor();
  writeFileSync(next, 'edited elsewhere');
  await codeShowing(panel, 'edited elsewhere').waitFor();
  const alias = join(home, 'current'), other = join(home, 'other');
  symlinkSync(directory, alias);
  await clickFile(page, { type: 'file', machine, path: join(alias, 'first') });
  await codeShowing(panel, 'atomic save').waitFor();
  mkdirSync(other);
  writeFileSync(join(other, 'first'), 'another directory');
  symlinkSync(other, staging);
  renameSync(staging, alias);
  await codeShowing(panel, 'another directory').waitFor();
  writeFileSync(join(other, 'first'), 'external change');
  await codeShowing(panel, 'external change').waitFor();
  assert.deepEqual(errors, []);
}));

test('a file follows its path when an entire ancestor directory is replaced', () => withWindow('wangcai-editor-watch-tree', lists, async ({ home, page, errors }) => {
  const tree = join(home, 'tree'), staged = join(home, 'staged');
  for (const [directory, text] of [[tree, 'first version'], [staged, 'second version']]) {
    mkdirSync(join(directory, 'a', 'b'), { recursive: true });
    writeFileSync(join(directory, 'a', 'b', 'doc.txt'), text);
  }
  const file = join(tree, 'a', 'b', 'doc.txt');
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: file });
  const panel = shownPanel(page);
  await codeShowing(panel, 'first version').waitFor();
  renameSync(tree, join(home, 'previous'));
  renameSync(staged, tree);
  await codeShowing(panel, 'second version').waitFor();
  writeFileSync(file, 'third version');
  await codeShowing(panel, 'third version').waitFor();
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
