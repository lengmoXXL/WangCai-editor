const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { alert, backButton, codeShowing, dirtyMark, drawnLines, lists, showAfter, showFile, shownPanel, showWritten, typeInto } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// The keys that used to write the file, and which now do nothing: the buffer is written back on its own.
const saveKey = 'Control+s';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What the cases below open and type, and the same texts as the page draws them.
const keptLine = 'const kept = 1;';
const keptBody = `${keptLine}\n`;
const noteLine = '// note';
const noteBody = `${noteLine}\n`;
const addedLine = 'const added = 2;';
const addedBody = `${addedLine}\n`;
// The file as the page's first write leaves it: the typed line above the line it was opened with.
const writtenBody = `${noteBody}${keptBody}`;

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

test('an edit is written back on its own, and the header marks the wait', { timeout: 120000 }, () => withWindow('wangcai-editor-auto-save', lists, async ({ home, page, errors }) => {
  const file = join(home, 'edit.ts');
  await showWritten(page, file, keptBody, keptLine);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  await typeInto(page, noteBody);
  // The mark is up while the write is pending, and it goes once the file holds the text — no save key pressed.
  await dirtyMark(shownPanel(page)).waitFor();
  await until(() => readFileSync(file, 'utf8') === writtenBody);
  await dirtyMark(shownPanel(page)).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
}));

test(':w and <C-s> no longer write the file', { timeout: 120000 }, () => withWindow('wangcai-editor-no-save-key', lists, async ({ home, page, errors }) => {
  const file = join(home, 'nosave.ts');
  await showWritten(page, file, keptBody, keptLine);
  await typeInto(page, noteBody);
  // Neither key writes: straight after them the disk still holds what it did before the typing was written back.
  await page.keyboard.press(saveKey);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  await writeWithEx(page);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  // :w answers with a note that the file writes itself back, rather than writing.
  await alert(shownPanel(page)).filter({ hasText: '文件自动写回' }).waitFor();
  // The buffer is written back on its own regardless.
  await until(() => readFileSync(file, 'utf8') === writtenBody);
  assert.deepEqual(errors, []);
}));

test('a file changed on disk with no edit of its own is drawn as the disk holds it, and not written again', { timeout: 120000 }, () => withWindow('wangcai-editor-merge-noop', lists, async ({ home, page, errors }) => {
  const file = join(home, 'noop-merge.ts');
  await showWritten(page, file, keptBody, keptLine);
  await sleep(700);
  const changedLine = 'const changed = 2;';
  writeFileSync(file, `${changedLine}\n`);
  const mtime = statSync(file).mtimeMs;
  // The buffer takes the disk's text, and since the merge leaves the disk as it is, no write is asked for.
  await codeShowing(shownPanel(page), changedLine).waitFor();
  await sleep(700);
  assert.deepEqual(await drawnLines(page), [changedLine, '']);
  assert.equal(readFileSync(file, 'utf8'), `${changedLine}\n`);
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  assert.deepEqual(errors, []);
}));

test('changes that do not overlap are kept from both sides and written back', { timeout: 120000 }, () => withWindow('wangcai-editor-merge-clean', lists, async ({ home, page, errors }) => {
  const file = join(home, 'merge.ts');
  await showWritten(page, file, 'a\nb\nc\n', 'a');
  // A local edit on the first line, then a disk edit on the last line before the local one is written back.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  writeFileSync(file, 'a\nb\nC\n');
  // Both changes survive: the buffer's first line and the disk's last line, and the merge is written back.
  await until(() => readFileSync(file, 'utf8') === 'Xa\nb\nC\n');
  assert.deepEqual(await drawnLines(page), ['Xa', 'b', 'C', '']);
  assert.deepEqual(errors, []);
}));

test('changes that overlap leave conflict markers in the buffer and on the disk', { timeout: 120000 }, () => withWindow('wangcai-editor-merge-conflict', lists, async ({ home, page, errors }) => {
  const file = join(home, 'conflict.ts');
  await showWritten(page, file, 'a\nb\nc\n', 'a');
  // A local edit and a disk edit on the same line, before the local one is written back.
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  writeFileSync(file, 'Ya\nb\nc\n');
  await until(() => readFileSync(file, 'utf8').includes('<<<<<<<'));
  await sleep(300);
  const disk = readFileSync(file, 'utf8');
  assert.ok(disk.includes('<<<<<<< 编辑器') && disk.includes('Xa') && disk.includes('=======') && disk.includes('Ya') && disk.includes('>>>>>>> 磁盘'), disk);
  const lines = await drawnLines(page);
  assert.ok(lines.some((line) => line.includes('<<<<<<< 编辑器')) && lines.some((line) => line.includes('>>>>>>> 磁盘')), JSON.stringify(lines));
  assert.deepEqual(errors, []);
}));

test('an edit is written back when the tab shows another file', { timeout: 120000 }, () => withWindow('wangcai-editor-flush', lists, async ({ home, page, errors }) => {
  const edited = join(home, 'edited.ts');
  const other = join(home, 'other.ts');
  const otherLine = 'const other = 1;';
  await showWritten(page, edited, keptBody, keptLine);
  writeFileSync(other, `${otherLine}\n`);
  await typeInto(page, noteBody);
  // Leaving the file writes back what the typing left, even before the wait is up.
  await showFile(shownPanel(page), other, otherLine);
  await until(() => readFileSync(edited, 'utf8') === writtenBody);
  assert.deepEqual(await drawnLines(page), [otherLine, '']);
  // Coming back draws what was written, with nothing left to mark.
  await showAfter(page, backButton(page), noteLine);
  await until(() => readFileSync(edited, 'utf8') === writtenBody);
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.deepEqual(errors, []);
}));

test('typing back to what the disk holds asks for no write', { timeout: 120000 }, () => withWindow('wangcai-editor-noop-write', lists, async ({ home, page, errors }) => {
  const file = join(home, 'noop.ts');
  await showWritten(page, file, keptBody, keptLine);
  const mtime = statSync(file).mtimeMs;
  // Type a character and take it back within the wait, so the buffer ends where the disk already is.
  await page.keyboard.press('i');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  await sleep(700);
  // A write of the same text would still touch the file; the unchanged mtime says none was asked for.
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 0);
  assert.deepEqual(errors, []);
}));

test('a write that fails says so over the page, keeps the text, and takes the word back by itself', { timeout: 120000 }, () => withWindow('wangcai-editor-save-fails', lists, async ({ home, page, errors }) => {
  const directory = join(home, 'fenced');
  mkdirSync(directory);
  const file = join(directory, 'fenced.ts');
  await showWritten(page, file, keptBody, keptLine);
  // A directory the node cannot write into is a write that fails while the text is there to be kept.
  chmodSync(directory, 0o555);
  await typeInto(page, noteBody);
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  assert.deepEqual(await drawnLines(page), [noteLine, keptLine, '']);
  assert.equal(await dirtyMark(shownPanel(page)).count(), 1);
  assert.equal(readFileSync(file, 'utf8'), keptBody);
  // Editing again once the directory is writable retries the write, which lands and takes the word back.
  chmodSync(directory, 0o755);
  await typeInto(page, addedBody);
  await until(() => readFileSync(file, 'utf8') !== keptBody);
  await until(async () => (await alert(shownPanel(page)).count()) === 0);
  // A failure that is not answered leaves on its own, with nothing done to dismiss it.
  chmodSync(directory, 0o555);
  await typeInto(page, '// more\n');
  await alert(shownPanel(page)).filter({ hasText: 'Permission denied' }).waitFor();
  await until(async () => (await alert(shownPanel(page)).count()) === 0);
  chmodSync(directory, 0o755);
  assert.deepEqual(errors, []);
}));