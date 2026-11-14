const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { drawnLines, editorFocused, lineBoxes, lists, shownPanel, showWritten } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

const answerLine = 'export const answer = 42;';
const answerBody = `${answerLine}\n`;
// The one file both cases below open, holding that line.
const openAnswer = (home, page) => showWritten(page, join(home, 'main.ts'), answerBody, answerLine);
// The press that leaves the field, and the key that moves the cursor once the keys are back: a move that landed in the text
// instead is how a press that never ended the insert mode shows.
const leaveKeys = 'Control+Shift+Q';
const moveKey = 'j';
// The letter typed into the line in the insert mode, which has to still be there when the keys come back.
const typed = 'Z';

test(`the editor keeps the keyboard through Escapes, and a ${leaveKeys} leaves it after ending what the field was doing`, { timeout: 120000 }, () => withWindow('wangcai-editor-escapes', lists, async ({ home, page, errors }) => {
  await openAnswer(home, page);
  await until(() => editorFocused(page));
  await page.keyboard.press('i');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.ok(await editorFocused(page));
  const firstLineBox = await lineBoxes(shownPanel(page)).first().boundingBox();
  // A press that leaves the field blurs it, and a click back into the text puts the keys there again.
  const leaveAndReturn = async () => {
    await page.keyboard.press(leaveKeys);
    await until(async () => !(await editorFocused(page)));
    await page.mouse.click(firstLineBox.x + 40, firstLineBox.y + firstLineBox.height / 2);
    await until(() => editorFocused(page));
  };
  await leaveAndReturn();
  // The same press taken from the insert mode ends it on the way out, so the key pressed after coming back moves the cursor
  // rather than land in the text.
  await page.keyboard.press('i');
  await page.keyboard.type(typed);
  await leaveAndReturn();
  await page.keyboard.press(moveKey);
  await page.waitForTimeout(300);
  const [line] = await drawnLines(page);
  assert.ok(line.includes(typed) && !line.includes(moveKey), `the line reads ${line}`);
  assert.deepEqual(errors, []);
}));

test('a key that shows the view puts the keys in its editor', { timeout: 180000 }, () => withWindow('wangcai-editor-keys', lists, async ({ home, page, errors }) => {
  await openAnswer(home, page);
  // The keys are elsewhere: no box in the window holds them.
  await page.evaluate(() => document.activeElement?.blur());
  for (const key of ['Control+Space', 'e']) await page.keyboard.press(key);
  // Nothing is clicked between the key and the caret.
  await until(() => editorFocused(page));
  assert.deepEqual(errors, []);
}));
