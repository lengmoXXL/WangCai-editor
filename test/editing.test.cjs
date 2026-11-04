const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, codeShowing, drawnLines, editorFocused, lists, refreshButton, showAfter, showFile, showWritten, shownPanel } = require('./editor-ui.cjs');

// The key the plugin answers a write with itself, beside the `:w` that `writeWithEx` below types.
const saveKey = 'Control+s';

// What the cases below open and type, and the same texts as the page draws them.
const keptLine = 'const kept = 1;';
const keptBody = `${keptLine}\n`;
const noteLine = '// note';
const noteBody = `${noteLine}\n`;
const draftLine = '// draft';
const draftBody = `${draftLine}\n`;
// The file as the page's first write leaves it: the typed line above the line it was opened with.
const writtenBody = `${noteBody}${keptBody}`;

// The mark the header carries while the text has parted from the file it came from.
const dirtyMark = (scope) => scope.locator('.editor-dirty');
// A write that landed: the file holds that text, and the header no longer marks the page.
const wroteBack = async (page, file, text) => {
  await until(() => readFileSync(file, 'utf8') === text);
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
};
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
  await showWritten(page, file, keptBody, keptLine);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  await typeInto(page, noteBody);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  // The insert ends on the line its newline made, so `k` steps back onto the text it typed; `dd` takes that line away, and the
  // mark goes with it.
  await page.keyboard.press('k');
  await page.keyboard.press('d');
  // The vim layer holds a prefix like `d` open until the next key.
  await page.waitForTimeout(60);
  await page.keyboard.press('d');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  await typeInto(page, noteBody);
  await writeWithEx(page);
  await wroteBack(page, file, writtenBody);
  // The same write, asked for by the other key the plugin answers itself.
  const addedLine = 'const added = 2;';
  const addedBody = `${addedLine}\n`;
  // The whole file once that line has been written: the note above it, the line kept from the start below.
  const addedWrittenBody = `${noteBody}${addedBody}${keptBody}`;
  await typeInto(page, addedBody);
  await page.keyboard.press(saveKey);
  await wroteBack(page, file, addedWrittenBody);
  assert.deepEqual(errors, []);
}));

test('a refresh drops what has not been written back and draws the file as it is', { timeout: 120000 }, () => withWindow('wangcai-editor-refresh', lists, async ({ home, page, errors }) => {
  const file = join(home, 'refresh.ts');
  await showWritten(page, file, keptBody, keptLine);
  // Written back first so the disk holds a text of its own: what the refresh draws then differs both from the draft typed
  // over it and from the file this page was opened as.
  await typeInto(page, noteBody);
  await writeWithEx(page);
  await wroteBack(page, file, writtenBody);
  const droppedLine = 'const dropped = 2;';
  const droppedBody = `${droppedLine}\n`;
  await typeInto(page, droppedBody);
  await refreshButton(shownPanel(page)).click();
  await codeShowing(shownPanel(page), droppedLine).waitFor({ state: 'detached' });
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(readFileSync(file, 'utf8'), writtenBody);
  assert.deepEqual(errors, []);
}));

test('a save that fails says so on the header and keeps what is on the page', { timeout: 120000 }, () => withWindow('wangcai-editor-save-fails', lists, async ({ home, page, errors }) => {
  const folder = join(home, 'fenced');
  mkdirSync(folder);
  const file = join(folder, 'fenced.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  // A directory the node cannot write into is a write that fails while the text is there to be kept.
  chmodSync(folder, 0o555);
  await page.keyboard.press(saveKey);
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 1);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  chmodSync(folder, 0o755);
  await page.keyboard.press(saveKey);
  await wroteBack(page, file, writtenBody);
  assert.equal(await alert(shownPanel(page)).count(), 0);
  assert.deepEqual(errors, []);
}));

test('an unsaved edit stays with its file while the tab shows another one', { timeout: 120000 }, () => withWindow('wangcai-editor-edit-kept', lists, async ({ home, page, errors }) => {
  const edited = join(home, 'edited.ts');
  const other = join(home, 'other.ts');
  const editedLine = 'const edited = 1;';
  const editedBody = `${editedLine}\n`;
  const otherLine = 'const other = 1;';
  const otherBody = `${otherLine}\n`;
  await showWritten(page, edited, editedBody, editedLine);
  writeFileSync(other, otherBody);
  await typeInto(page, draftBody);
  await showFile(shownPanel(page), other, otherLine);
  assert.deepEqual(await drawnLines(page), [otherLine, '']);
  await showAfter(page, backButton(page), draftLine);
  await dirtyMark(shownPanel(page)).waitFor();
  assert.equal(readFileSync(edited, 'utf8'), editedBody);
  assert.deepEqual(errors, []);
}));

test('a file changed on disk by something else replaces what the page held', { timeout: 120000 }, () => withWindow('wangcai-editor-edit-changed', lists, async ({ home, page, errors }) => {
  const file = join(home, 'changed.ts');
  const beforeLine = 'const before = 1;';
  const beforeBody = `${beforeLine}\n`;
  const afterLine = 'const after = 2;';
  const afterBody = `${afterLine}\n`;
  await showWritten(page, file, beforeBody, beforeLine);
  await typeInto(page, draftBody);
  writeFileSync(file, afterBody);
  await codeShowing(shownPanel(page), afterLine).waitFor();
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), [afterLine, '']);
  assert.deepEqual(errors, []);
}));
