const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, codeView, drawnLines, editorFocused, lists, openOn, refreshButton, showFile, shownPanel } = require('./editor-ui.cjs');

// The mark the header carries while the text has parted from the file it came from.
const dirtyMark = (scope) => scope.locator('.editor-dirty');
// Text typed into the page on show: the vim layer is in the normal mode, so the insert mode is entered first, and the mark
// appearing is what says the typing has landed.
const typeInto = async (page, text) => {
  await until(() => editorFocused(page));
  await page.keyboard.press('i');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await dirtyMark(shownPanel(page)).waitFor();
};
const writeWithEx = async (page) => {
  await page.keyboard.press(':');
  const line = shownPanel(page).locator('.cm-vim-panel input');
  await line.waitFor();
  // vim's line takes the keyboard a moment after it appears, and the command goes where the keyboard is.
  await until(() => line.evaluate((element) => element === document.activeElement));
  await page.keyboard.type('w');
  await page.keyboard.press('Enter');
  await line.waitFor({ state: 'detached' });
};

test('an edit is written back by :w and by <C-s>, and the header says when it has not been', { timeout: 120000 }, () => withWindow('wangcai-editor-edit-save', lists, async ({ home, page, errors }) => {
  const file = join(home, 'edit.ts');
  writeFileSync(file, 'const kept = 1;\n');
  await openOn(page, file, 'const kept = 1;');
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  await typeInto(page, '// note\n');
  assert.equal(readFileSync(file, 'utf8'), 'const kept = 1;\n');
  // The insert ends on the line its newline made, so `k` steps back onto the text it typed; `dd` takes that line away, and the
  // mark goes with it.
  await page.keyboard.press('k');
  await page.keyboard.press('d');
  // The vim layer holds a prefix like `d` open until the next key.
  await page.waitForTimeout(60);
  await page.keyboard.press('d');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  await typeInto(page, '// note\n');
  await writeWithEx(page);
  await until(() => readFileSync(file, 'utf8') === '// note\nconst kept = 1;\n');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  // The same write, asked for by the other key the plugin answers itself.
  await typeInto(page, 'const added = 2;\n');
  await page.keyboard.press('Control+s');
  await until(() => readFileSync(file, 'utf8') === '// note\nconst added = 2;\nconst kept = 1;\n');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}));

test('a refresh drops what has not been written back and draws the file as it is', { timeout: 120000 }, () => withWindow('wangcai-editor-refresh', lists, async ({ home, page, errors }) => {
  const file = join(home, 'refresh.ts');
  writeFileSync(file, 'const kept = 1;\n');
  await openOn(page, file, 'const kept = 1;');
  // Written back first so the disk holds a text of its own: what the refresh draws then differs both from the draft typed
  // over it and from the file this page was opened as.
  await typeInto(page, '// note\n');
  await writeWithEx(page);
  await until(() => readFileSync(file, 'utf8') === '// note\nconst kept = 1;\n');
  await typeInto(page, 'const dropped = 2;\n');
  await refreshButton(shownPanel(page)).click();
  await codeView(shownPanel(page), 'const dropped').waitFor({ state: 'detached' });
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), ['// note', 'const kept = 1;', '']);
  assert.equal(readFileSync(file, 'utf8'), '// note\nconst kept = 1;\n');
  assert.deepEqual(errors, []);
}));

test('a save that fails says so on the header and keeps what is on the page', { timeout: 120000 }, () => withWindow('wangcai-editor-save-fails', lists, async ({ home, page, errors }) => {
  const folder = join(home, 'fenced');
  mkdirSync(folder);
  const file = join(folder, 'fenced.ts');
  writeFileSync(file, 'const kept = 1;\n');
  await openOn(page, file, 'const kept = 1;');
  await typeInto(page, '// note\n');
  // A directory the node cannot write into is a write that fails while the text is there to be kept.
  chmodSync(folder, 0o555);
  await page.keyboard.press('Control+s');
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  assert.deepEqual(await drawnLines(page), ['// note', 'const kept = 1;', '']);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 1);
  assert.equal(readFileSync(file, 'utf8'), 'const kept = 1;\n');
  chmodSync(folder, 0o755);
  await page.keyboard.press('Control+s');
  await until(() => readFileSync(file, 'utf8') === '// note\nconst kept = 1;\n');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.equal(await alert(shownPanel(page)).count(), 0);
  assert.deepEqual(errors, []);
}));

test('an unsaved edit stays with its file while the tab shows another one', { timeout: 120000 }, () => withWindow('wangcai-editor-edit-kept', lists, async ({ home, page, errors }) => {
  const edited = join(home, 'edited.ts');
  const other = join(home, 'other.ts');
  writeFileSync(edited, 'const edited = 1;\n');
  writeFileSync(other, 'const other = 1;\n');
  await openOn(page, edited, 'const edited = 1;');
  await typeInto(page, '// draft\n');
  await showFile(shownPanel(page), other, 'const other = 1;');
  assert.deepEqual(await drawnLines(page), ['const other = 1;', '']);
  await backButton(page).click();
  await codeView(shownPanel(page), '// draft').waitFor();
  await dirtyMark(shownPanel(page)).waitFor();
  assert.equal(readFileSync(edited, 'utf8'), 'const edited = 1;\n');
  assert.deepEqual(errors, []);
}));

test('a file changed on disk by something else replaces what the page held', { timeout: 120000 }, () => withWindow('wangcai-editor-edit-changed', lists, async ({ home, page, errors }) => {
  const file = join(home, 'changed.ts');
  writeFileSync(file, 'const before = 1;\n');
  await openOn(page, file, 'const before = 1;');
  await typeInto(page, '// draft\n');
  writeFileSync(file, 'const after = 2;\n');
  await codeView(shownPanel(page), 'const after = 2;').waitFor();
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), ['const after = 2;', '']);
  assert.deepEqual(errors, []);
}));
