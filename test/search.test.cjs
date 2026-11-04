const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { codeShowing, dismissSearch, editorFocused, filesEmpty, landedOn, lists, openSearch, search, searchInput, searchMarks, searchPanel, searchRow, searchRows, showWritten, shownPanel, shows, submitSearch, waitForPath } = require('./editor-ui.cjs');

test('the search box finds files and text, and Enter opens what it found', { timeout: 120000 }, () => withWindow('wangcai-editor-search', lists, async ({ home, page, errors }) => {
  const main = join(home, 'main.ts');
  const nested = join(home, 'nested-name.ts');
  const grepToken = 'GREP_TARGET';
  const answerName = 'answer';
  const grepLine = `const ${grepToken} = ${answerName};`;
  const answerBody = `export const ${answerName} = 42;\n`;
  writeFileSync(join(home, `${answerName}.ts`), answerBody);
  const importLine = `import { ${answerName} } from "./${answerName}";`;
  const mainBody = `${importLine}\n${grepLine}\n`;
  const grepRow = mainBody.split('\n').indexOf(grepLine) + 1;
  const nestedLine = 'export const nested = 1;';
  const nestedBody = `${nestedLine}\n`;
  writeFileSync(nested, nestedBody);
  await showWritten(page, main, mainBody, grepToken);
  // The list comes from the workspace's own directory, and nothing is chosen yet: the selection stands on the row of the
  // entry the tab is on, and the page stays there.
  await openSearch(page);
  const mainRow = searchRow(page, basename(main));
  await mainRow.waitFor();
  // Longer than the picker's rest before it follows a selection, so a page that was going to move has moved.
  await page.waitForTimeout(400);
  assert.ok(await shows(shownPanel(page), main));
  assert.equal(await mainRow.getAttribute('aria-current'), 'true');
  assert.equal(await searchPanel(page).evaluate((element) => getComputedStyle(element).fontSize), '12px');
  // Typed a letter at a time, with a pause long enough for the page to follow each one: none of that may take the
  // keyboard out of the input.
  const nestQuery = 'nest';
  await page.keyboard.type(nestQuery, { delay: 150 });
  assert.equal(await searchInput(page).inputValue(), nestQuery);
  const nestedRow = searchRow(page, basename(nested));
  await nestedRow.waitFor();
  // The row marks the letters it matched, so what put it on the list is visible.
  assert.ok((await searchMarks(nestedRow)).length > 0);
  // The page above the picker follows the chosen row, so the file is there before Enter closes the picker.
  await waitForPath(shownPanel(page), nested);
  assert.equal(await searchPanel(page).count(), 1);
  await codeShowing(shownPanel(page), nestedLine).waitFor();
  await submitSearch(page);
  // The picker that closes hands the keyboard to the page it opened.
  await until(() => editorFocused(page));

  // A leading > asks rg for the pattern, and a row says the file and line it was found on.
  await search(page, `>${grepToken}`);
  await searchRow(page, `${basename(main)}:${grepRow}`).waitFor();
  // The row under the selection is where the page sits already, so the match is shown before Enter.
  await landedOn(page, main, grepLine);
  await submitSearch(page);

  // The picker is opened again from the header, and Escape leaves without moving the page.
  await openSearch(page);
  await dismissSearch(page);
  assert.ok(await shows(shownPanel(page), main));

  // A row is a whole path, and a query that runs through a folder into the name marks both on that one line.
  mkdirSync(join(home, 'deep/dir'), { recursive: true });
  const pathTail = 'dir/path';
  const onlyFile = join(home, 'deep', `${pathTail}-only.ts`);
  const onlyBody = 'export const only = 1;\n';
  writeFileSync(onlyFile, onlyBody);
  await search(page, pathTail);
  const pathRow = searchRow(page, basename(onlyFile));
  await pathRow.waitFor();
  assert.deepEqual(await searchMarks(pathRow), [pathTail]);
  await dismissSearch(page);

  // A name holding a character outside the basic plane still prints whole, and the letters after it are marked on their
  // own.
  const emojiChar = '📁';
  const abcQuery = 'abc';
  const emojiFile = `${emojiChar}${abcQuery}.ts`;
  const emojiBody = 'export const emoji = 1;\n';
  writeFileSync(join(home, emojiFile), emojiBody);
  await search(page, abcQuery);
  const emojiRow = searchRow(page, abcQuery);
  await emojiRow.waitFor();
  assert.deepEqual(await searchMarks(emojiRow), [abcQuery]);
  assert.equal(await emojiRow.innerText(), emojiFile);
  await dismissSearch(page);
  // A query that falls on that character marks both of its units as one run.
  await search(page, emojiChar);
  assert.deepEqual(await searchMarks(emojiRow), [emojiChar]);
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
  const hitPrefix = 'HIT_';
  const hitsBody = (index) => Array.from({ length: 10 }, (_, line) => `${hitPrefix}${index}_${line}`).join('\n');
  for (let index = 0; index < 25; index++) writeFileSync(join(home, `hits${index}.txt`), hitsBody(index));
  await search(page, `>${hitPrefix}`);
  assert.equal(await searchRows(page).count(), 200);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));
