const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, codeShowing, conflictKeep, conflictLoad, conflictMark, conflictRow, dirtyMark, drawnLines, editorFocused, focusOn, lists, loadButton, refreshButton, showAfter, showFile, shownPanel, showWritten, typeInto } = require('./editor-ui.cjs');

// The key the plugin answers a write with itself, beside the `:w` that `writeWithEx` below types.
const saveKey = 'Control+s';
// The key that puts the keyboard on the answer to a file that changed on disk.
const answerKey = 'Control+g';

// What the cases below open and type, and the same texts as the page draws them.
const keptLine = 'const kept = 1;';
const keptBody = `${keptLine}\n`;
const noteLine = '// note';
const noteBody = `${noteLine}\n`;
const draftLine = '// draft';
const draftBody = `${draftLine}\n`;
// The file as the page's first write leaves it: the typed line above the line it was opened with.
const writtenBody = `${noteBody}${keptBody}`;
// What another writer leaves a file holding while the page has a draft over it.
const changedLine = 'const changed = 2;';
const changedBody = `${changedLine}\n`;

// A write that landed: the file holds that text, and the header no longer marks the page.
const wroteBack = async (page, file, text) => {
  await until(() => readFileSync(file, 'utf8') === text);
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
};

// A write typed the way vim takes one, from the command line the page opens with `:`.
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

test('a load drops what has not been written back and draws the file as it is', { timeout: 120000 }, () => withWindow('wangcai-editor-load', lists, async ({ home, page, errors }) => {
  const file = join(home, 'load.ts');
  await showWritten(page, file, keptBody, keptLine);
  // Written back first so the disk holds a text of its own: what the load draws then differs both from the draft typed
  // over it and from the file this page was opened as.
  await typeInto(page, noteBody);
  await writeWithEx(page);
  await wroteBack(page, file, writtenBody);
  const droppedLine = 'const dropped = 2;';
  const droppedBody = `${droppedLine}\n`;
  await typeInto(page, droppedBody);
  await loadButton(shownPanel(page)).click();
  await codeShowing(shownPanel(page), droppedLine).waitFor({ state: 'detached' });
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(readFileSync(file, 'utf8'), writtenBody);
  assert.deepEqual(errors, []);
}));

test('a file changed on disk under a draft is said so, and the draft is what the page goes on drawing', { timeout: 120000 }, () => withWindow('wangcai-editor-conflict', lists, async ({ home, page, errors }) => {
  const file = join(home, 'conflict.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  writeFileSync(file, changedBody);
  await conflictRow(shownPanel(page)).waitFor();
  await conflictMark(shownPanel(page)).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(readFileSync(file, 'utf8'), changedBody);
  // Keeping the draft puts the row away and leaves the mark, and the mark asks for the row again.
  await conflictKeep(shownPanel(page)).click();
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await conflictMark(shownPanel(page)).click();
  await conflictRow(shownPanel(page)).waitFor();
  // The refresh reads the file again with the draft still there, so what it finds is said once more.
  await conflictKeep(shownPanel(page)).click();
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await refreshButton(shownPanel(page)).click();
  await conflictRow(shownPanel(page)).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  // The row's own load hands the page the file's text, and nothing is left to mark.
  await conflictLoad(shownPanel(page)).click();
  await codeShowing(shownPanel(page), changedLine).waitFor();
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), [changedLine, '']);
  assert.equal(readFileSync(file, 'utf8'), changedBody);
  assert.deepEqual(errors, []);
}));

test('a save that fails says so over the page, keeps what is on the page, and takes the word back by itself', { timeout: 120000 }, () => withWindow('wangcai-editor-save-fails', lists, async ({ home, page, errors }) => {
  const directory = join(home, 'fenced');
  mkdirSync(directory);
  const file = join(directory, 'fenced.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  // A directory the node cannot write into is a write that fails while the text is there to be kept.
  chmodSync(directory, 0o555);
  await page.keyboard.press(saveKey);
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 1);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  // A write that lands takes the word back with it.
  chmodSync(directory, 0o755);
  await page.keyboard.press(saveKey);
  await wroteBack(page, file, writtenBody);
  assert.equal(await alert(shownPanel(page)).count(), 0);
  // One that is not answered leaves on its own, with nothing done to dismiss it.
  chmodSync(directory, 0o555);
  await page.keyboard.press(saveKey);
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  await until(async () => (await alert(shownPanel(page)).count()) === 0);
  chmodSync(directory, 0o755);
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
  // A draft of its own is no conflict: the file it was made on is the file still there.
  assert.equal(await conflictRow(shownPanel(page)).count(), 0);
  assert.equal(readFileSync(edited, 'utf8'), editedBody);
  assert.deepEqual(errors, []);
}));

test('a conflict answered by a write leaves the file holding what the page held', { timeout: 120000 }, () => withWindow('wangcai-editor-conflict-write', lists, async ({ home, page, errors }) => {
  const file = join(home, 'over.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  writeFileSync(file, changedBody);
  await conflictRow(shownPanel(page)).waitFor();
  await page.keyboard.press(saveKey);
  await wroteBack(page, file, writtenBody);
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  // The watch hears this page's own write, which is nothing to choose between.
  await page.waitForTimeout(500);
  assert.equal(await conflictRow(shownPanel(page)).count(), 0);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  assert.deepEqual(errors, []);
}));

test('a file that changed while the tab showed another one says so when it comes back', { timeout: 120000 }, () => withWindow('wangcai-editor-conflict-away', lists, async ({ home, page, errors }) => {
  const away = join(home, 'away.ts');
  const other = join(home, 'away-other.ts');
  const otherLine = 'const other = 1;';
  await showWritten(page, away, keptBody, keptLine);
  writeFileSync(other, `${otherLine}\n`);
  await typeInto(page, noteBody);
  await showFile(shownPanel(page), other, otherLine);
  writeFileSync(away, changedBody);
  await showAfter(page, backButton(page), noteLine);
  await conflictRow(shownPanel(page)).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(readFileSync(away, 'utf8'), changedBody);
  // The header's load is the same answer from outside the row.
  await loadButton(shownPanel(page)).click();
  await codeShowing(shownPanel(page), changedLine).waitFor();
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(await drawnLines(page), [changedLine, '']);
  assert.deepEqual(errors, []);
}));

test('the conflict row is answered from the keyboard, and the keys go back to the text with it', { timeout: 120000 }, () => withWindow('wangcai-editor-conflict-keys', lists, async ({ home, page, errors }) => {
  const file = join(home, 'keys.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  writeFileSync(file, changedBody);
  await conflictRow(shownPanel(page)).waitFor();
  // A row that appears under typing leaves the keyboard where it was.
  assert.ok(await editorFocused(page));
  await page.keyboard.press(answerKey);
  await focusOn(page, '载入磁盘的那份');
  assert.ok(!(await editorFocused(page)));
  // j and k walk the two answers, wrapping at the ends of them.
  await page.keyboard.press('j');
  await focusOn(page, '留着我的改动');
  await page.keyboard.press('j');
  await focusOn(page, '载入磁盘的那份');
  await page.keyboard.press('k');
  await focusOn(page, '留着我的改动');
  await page.keyboard.press('ArrowRight');
  await focusOn(page, '载入磁盘的那份');
  await page.keyboard.press('Enter');
  await codeShowing(shownPanel(page), changedLine).waitFor();
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  await until(() => editorFocused(page));
  assert.deepEqual(await drawnLines(page), [changedLine, '']);
  assert.equal(readFileSync(file, 'utf8'), changedBody);
  assert.deepEqual(errors, []);
}));

test('Escape from the row keeps the draft, and the answer key asks for a row that was put away', { timeout: 120000 }, () => withWindow('wangcai-editor-conflict-esc', lists, async ({ home, page, errors }) => {
  const file = join(home, 'escape.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  writeFileSync(file, changedBody);
  await conflictRow(shownPanel(page)).waitFor();
  await page.keyboard.press(answerKey);
  await focusOn(page, '载入磁盘的那份');
  await page.keyboard.press('j');
  await focusOn(page, '留着我的改动');
  await page.keyboard.press('Enter');
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await conflictMark(shownPanel(page)).waitFor();
  await until(() => editorFocused(page));
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  // The row was put away, so the key brings it back before the keyboard lands on it.
  await page.keyboard.press(answerKey);
  await conflictRow(shownPanel(page)).waitFor();
  await focusOn(page, '载入磁盘的那份');
  await page.keyboard.press('Escape');
  await conflictRow(shownPanel(page)).waitFor({ state: 'detached' });
  await until(() => editorFocused(page));
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(readFileSync(file, 'utf8'), changedBody);
  assert.deepEqual(errors, []);
}));

test('with no conflict the answer key lands on the header load, in insert mode as well', { timeout: 120000 }, () => withWindow('wangcai-editor-load-key', lists, async ({ home, page, errors }) => {
  const file = join(home, 'load-key.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  // The key answers while the text is being typed into, which is where a change on disk usually arrives.
  await page.keyboard.press('i');
  await page.keyboard.press(answerKey);
  await focusOn(page, '载入');
  assert.equal(await conflictRow(shownPanel(page)).count(), 0);
  await page.keyboard.press('Enter');
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  await until(() => editorFocused(page));
  assert.deepEqual(await drawnLines(page), [keptLine, '']);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  assert.deepEqual(errors, []);
}));
