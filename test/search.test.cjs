const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeView, dismissSearch, editorFocused, filesEmpty, landedOn, lists, openOn, openSearch, pathBox, search, searchInput, searchMarks, searchPanel, searchRow, searchRows, shownPanel, submitSearch, waitForPath } = require('./editor-ui.cjs');

test('the search box finds files and text, and Enter opens what it found', { timeout: 120000 }, () => withWindow('wangcai-editor-search', lists, async ({ home, page, errors }) => {
  const main = join(home, 'main.ts');
  const nested = join(home, 'nested-name.ts');
  writeFileSync(join(home, 'answer.ts'), 'export const answer = 42;\n');
  writeFileSync(main, [
    'import { answer } from "./answer";',
    'const GREP_TARGET = answer;',
    '',
  ].join('\n'));
  writeFileSync(nested, 'export const nested = 1;\n');
  await openOn(page, main, 'GREP_TARGET');
  // The list comes from the workspace's own directory, and nothing is chosen yet: the selection stands on the row of the
  // entry the tab is on, and the page stays there.
  await openSearch(page);
  const mainRow = searchRow(page, 'main.ts');
  await mainRow.waitFor();
  // Longer than the picker's rest before it follows a selection, so a page that was going to move has moved.
  await page.waitForTimeout(400);
  assert.equal(await pathBox(shownPanel(page)).inputValue(), main);
  assert.equal(await mainRow.getAttribute('aria-current'), 'true');
  assert.equal(await searchPanel(page).evaluate((element) => getComputedStyle(element).fontSize), '12px');
  // Typed a letter at a time, with a pause long enough for the page to follow each one: none of that may take the
  // keyboard out of the input.
  await page.keyboard.type('nest', { delay: 150 });
  assert.equal(await searchInput(page).inputValue(), 'nest');
  const nestedRow = searchRow(page, 'nested-name.ts');
  await nestedRow.waitFor();
  // The row marks the letters it matched, so what put it on the list is visible.
  assert.ok((await searchMarks(nestedRow)).length > 0);
  // The page above the picker follows the chosen row, so the file is there before Enter closes the picker.
  await waitForPath(shownPanel(page), nested);
  assert.equal(await searchPanel(page).count(), 1);
  await codeView(shownPanel(page), 'nested = 1').waitFor();
  await submitSearch(page);
  // The picker that closes hands the keyboard to the page it opened.
  await until(() => editorFocused(page));

  // A leading > asks rg for the pattern, and a row says the file and line it was found on.
  await search(page, '>GREP_TARGET');
  await searchRow(page, 'main.ts:2').waitFor();
  // The row under the selection is where the page sits already, so the match is shown before Enter.
  await landedOn(page, main, 'const GREP_TARGET = answer;');
  await submitSearch(page);

  // The picker is opened again from the header, and Escape leaves without moving the page.
  await openSearch(page);
  await dismissSearch(page);
  assert.equal(await pathBox(shownPanel(page)).inputValue(), main);

  // A row is a whole path, and a query that runs through a folder into the name marks both on that one line.
  mkdirSync(join(home, 'deep/dir'), { recursive: true });
  writeFileSync(join(home, 'deep/dir/path-only.ts'), 'export const only = 1;\n');
  await search(page, 'dir/path');
  const pathRow = searchRow(page, 'path-only.ts');
  await pathRow.waitFor();
  assert.deepEqual(await searchMarks(pathRow), ['dir/path']);
  await dismissSearch(page);

  // A name holding a character outside the basic plane still prints whole, and the letters after it are marked on their
  // own.
  writeFileSync(join(home, '📁abc.ts'), 'export const emoji = 1;\n');
  await search(page, 'abc');
  const emojiRow = searchRow(page, 'abc.ts');
  await emojiRow.waitFor();
  assert.deepEqual(await searchMarks(emojiRow), ['abc']);
  assert.equal(await emojiRow.innerText(), '📁abc.ts');
  await dismissSearch(page);
  // A query that falls on that character marks both of its units as one run.
  await search(page, '📁');
  assert.deepEqual(await searchMarks(emojiRow), ['📁']);
  await dismissSearch(page);

  // Letters the query finds scattered score below what the page lists, so a weak query reports nothing rather than a
  // screen of near misses.
  await openSearch(page);
  // The list has to be in before the query is typed: an empty list is also what the picker shows while it waits for one.
  await searchRows(page).first().waitFor();
  await searchInput(page).fill('nst');
  await filesEmpty(page).waitFor();
  await dismissSearch(page);

  // A grep answer longer than the page draws is cut at the row limit: 25 files of 10 matching lines, and 200 rows drawn.
  for (let index = 0; index < 25; index++) {
    writeFileSync(join(home, `hits${index}.txt`), Array.from({ length: 10 }, (_, line) => `HIT_${index}_${line}`).join('\n'));
  }
  await search(page, '>HIT_');
  assert.equal(await searchRows(page).count(), 200);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));
