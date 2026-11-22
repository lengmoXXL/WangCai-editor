const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { lists, showWritten, shownPanel, codeContent, dirtyMark, typeInto } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// What the text is actually painted in, read off the view that is on screen rather than from the theme it was handed.
const painted = (page) => page.evaluate(() => {
  const editor = document.querySelector('.cm-editor');
  const content = document.querySelector('.cm-content');
  const gutter = document.querySelector('.cm-gutters');
  const keyword = document.querySelector('.cm-content span[class*="ͼ"]');
  const colour = (node) => node ? getComputedStyle(node).color : '';
  return {
    text: colour(content), pane: editor ? getComputedStyle(editor).backgroundColor : '',
    gutter: colour(gutter), first: colour(keyword),
    scheme: document.documentElement.style.colorScheme,
  };
});

const switchTo = async (page, name) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('u');
  await page.keyboard.press('t');
  await page.locator('.prompt-scrim:not([hidden])').waitFor();
  await page.locator('.prompt-list button', { hasText: name }).first().click();
  await page.locator('.prompt-scrim').waitFor({ state: 'hidden' });
};

test('a switch of theme recolours the view already on screen', { timeout: 180000 }, () => withWindow('wangcai-editor-theme', lists, async ({ home, page, errors }) => {
  const file = join(home, 'colours.ts');
  await showWritten(page, file, 'const answer = 42;\nexport default answer;\n', 'const answer');
  // An edit the disk does not have: a view built again would read the file and lose it, so this is what tells a
  // re-coloured view from a rebuilt one.
  await typeInto(page, 'UNSAVED');
  const dark = await painted(page);
  assert.equal(dark.scheme, 'dark');

  await switchTo(page, 'GitHub');
  await until(async () => (await painted(page)).scheme === 'light');
  const light = await painted(page);
  assert.equal(light.pane, 'rgb(255, 255, 255)', 'the editor pane is painted white');
  assert.equal(light.text, 'rgb(31, 35, 40)', 'and its text in GitHub foreground');
  assert.notEqual(light.gutter, dark.gutter, 'the gutter follows too');
  assert.notEqual(light.first, dark.first, 'the syntax colours were rebuilt, not left at the old theme');

  assert.match(await codeContent(shownPanel(page)).innerText(), /UNSAVED/, 'the unsaved edit survived, so the view was re-coloured rather than built again');
  await dirtyMark(shownPanel(page)).waitFor();

  await switchTo(page, 'WangCai');
  await until(async () => (await painted(page)).scheme === 'dark');
  const back = await painted(page);
  assert.equal(back.pane, dark.pane, 'switching back restores the pane');
  assert.equal(back.text, dark.text);
  assert.match(await codeContent(shownPanel(page)).innerText(), /UNSAVED/);
  assert.deepEqual(errors, []);
}));
