const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { clickFile, codeShowing, dismissSearch, editorFocused, fileSearchEmpty, landedOn, lists, machine, openSearch, queryApplied, search, searchInput, searchMarks, searchPanel, searchRow, searchRowEntries, searchRows, shownPanel, shows, showWritten, storedHistory, submitSearch, waitForPath } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

const rowLimit = 200;

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
  // The list comes from the workspace's own directory, and opening it leaves the page where it was.
  await openSearch(page);
  const mainRow = searchRow(page, basename(main));
  await mainRow.waitFor();
  // Longer than the picker's rest before it follows a selection, so a page that was going to move has moved.
  await page.waitForTimeout(400);
  assert.ok(await shows(shownPanel(page), main));
  assert.equal(await searchPanel(page).locator('[aria-current]').count(), 0);
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

  // A row is a whole path, and a query that runs through a directory into the name marks both on that one line.
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
  await fileSearchEmpty(page).waitFor();
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('rows that score the same keep the order the list came in', { timeout: 120000 }, () => withWindow('wangcai-editor-search-order', lists, async ({ home, page, errors }) => {
  // Two files of one name in two directories of one name length: a query for that name scores them the same, so only the order
  // the workspace's list of files comes in decides which prints first.
  const dupQuery = 'dup';
  const dupName = `${dupQuery}.ts`;
  const oneDir = join(home, 'one');
  const twoDir = join(home, 'two');
  const onePath = join(oneDir, dupName);
  const twoPath = join(twoDir, dupName);
  mkdirSync(oneDir);
  mkdirSync(twoDir);
  writeFileSync(twoPath, '');
  await showWritten(page, onePath, '');
  await openSearch(page);
  const dupRowTexts = async () => (await searchRowEntries(page)).map((row) => row.text).filter((text) => text.endsWith(dupName));
  await until(async () => (await dupRowTexts()).length === 2);
  const listOrder = await dupRowTexts();
  await searchInput(page).fill(dupQuery);
  await queryApplied(page);
  assert.deepEqual(await dupRowTexts(), listOrder);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('a query matching more rows than the picker shows brings them all to the cap', { timeout: 180000 }, () => withWindow('wangcai-editor-search-cap', lists, async ({ home, page, errors }) => {
  const manyDir = join(home, 'many');
  mkdirSync(manyDir);
  const capPrefix = 'cap-';
  const names = Array.from({ length: rowLimit + 1 }, (_, index) => `${capPrefix}${String(index).padStart(3, '0')}.ts`);
  for (const name of names) writeFileSync(join(manyDir, name), '');
  await showWritten(page, join(manyDir, names[0]), '');
  await search(page, capPrefix);
  await queryApplied(page);
  assert.equal(await searchRows(page).count(), rowLimit);
  await dismissSearch(page);
  const hitPrefix = 'HIT_';
  const hitsPerFile = 10;
  const hitFiles = Math.ceil((rowLimit + 1) / hitsPerFile);
  const hitsBody = (index) => Array.from({ length: hitsPerFile }, (_, line) => `${hitPrefix}${index}_${line}`).join('\n');
  for (let index = 0; index < hitFiles; index++) writeFileSync(join(home, `hits${index}.txt`), hitsBody(index));
  await search(page, `>${hitPrefix}`);
  assert.equal(await searchRows(page).count(), rowLimit);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('nothing is under the selection until a row is chosen', { timeout: 120000 }, () => withWindow('wangcai-editor-search-open', lists, async ({ home, page, errors }) => {
  const listed = join(home, 'listed.ts');
  const listedLine = 'export const listed = 1;';
  await showWritten(page, listed, `${listedLine}\n`, listedLine);
  await openSearch(page);
  const firstRow = searchRows(page).first();
  await firstRow.waitFor();
  assert.equal(await searchPanel(page).locator('[aria-current]').count(), 0);
  // Enter with nothing under the selection opens nothing: the picker stays, and the page stays on the file it shows.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.equal(await searchPanel(page).count(), 1);
  assert.ok(await shows(shownPanel(page), listed));
  // A key that asks for a row still takes the first of them.
  await page.keyboard.press('ArrowDown');
  assert.equal(await firstRow.getAttribute('aria-current'), 'true');
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('the flags after the separator are handed to rg', { timeout: 120000 }, () => withWindow('wangcai-editor-search-flags', lists, async ({ home, page, errors }) => {
  const keptLine = 'export const kept = 1;';
  const kept = join(home, 'kept.ts');
  writeFileSync(join(home, 'dropped.md'), '# dropped\n');
  await showWritten(page, kept, `${keptLine}\n`, keptLine);
  // A query of flags alone lists what they name: only the TypeScript file, with the row of the file on show still under the
  // selection.
  await search(page, '-- -g *.ts');
  const keptRow = searchRow(page, 'kept.ts');
  await keptRow.waitFor();
  assert.equal(await searchRow(page, 'dropped.md').count(), 0);
  assert.equal(await keptRow.getAttribute('aria-current'), 'true');
  // A name ahead of the separator is what the rows are ranked by, so a name the glob left out has no row of its own.
  await searchInput(page).fill('dropped -- -g *.ts');
  await fileSearchEmpty(page).waitFor();
  // The same name with the glob that holds it.
  await searchInput(page).fill('dropped -- -g *.md');
  const droppedRow = searchRow(page, 'dropped.md');
  await droppedRow.waitFor();
  assert.equal(await searchRow(page, 'kept.ts').count(), 0);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('the flags after the separator narrow what a content search greps', { timeout: 120000 }, () => withWindow('wangcai-editor-search-grep-flags', lists, async ({ home, page, errors }) => {
  const token = 'GREP_FLAGGED';
  const hitLine = `const ${token} = 1;`;
  const one = join(home, 'one.ts');
  const two = join(home, 'two.md');
  writeFileSync(two, `${hitLine}\n`);
  await showWritten(page, one, `${hitLine}\n`, hitLine);
  // A pattern without flags finds the line in both files.
  await search(page, `>${token}`);
  await searchRow(page, `${basename(one)}:1`).waitFor();
  await searchRow(page, `${basename(two)}:1`).waitFor();
  await dismissSearch(page);
  // A type picks the files rg reads, and a glob does too.
  await search(page, `>${token} -- -t ts`);
  await searchRow(page, `${basename(one)}:1`).waitFor();
  assert.equal(await searchRow(page, `${basename(two)}:1`).count(), 0);
  await dismissSearch(page);
  await search(page, `>${token} -- -g *.md`);
  await searchRow(page, `${basename(two)}:1`).waitFor();
  assert.equal(await searchRow(page, `${basename(one)}:1`).count(), 0);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('a row under the mouse is shown without being visited, and a key in the box walks nothing', { timeout: 120000 }, () => withWindow('wangcai-editor-search-peek', lists, async ({ home, page, errors }) => {
  const first = join(home, 'firstShown.ts');
  const second = join(home, 'secondShown.ts');
  const firstLine = 'export const firstShown = 1;';
  const secondLine = 'export const secondShown = 1;';
  writeFileSync(second, `${secondLine}\n`);
  await showWritten(page, first, `${firstLine}\n`, firstLine);
  await clickFile(page, { type: 'file', machine, path: second });
  await landedOn(page, second, secondLine);
  await openSearch(page);
  const row = searchRow(page, basename(first));
  await row.waitFor();
  await row.hover();
  await waitForPath(shownPanel(page), first);
  const [history] = Object.values(await storedHistory(page));
  assert.equal(history.entries.length, 2);
  await searchInput(page).click();
  await page.keyboard.type('Shown', { delay: 60 });
  await page.keyboard.press('Control+o');
  await page.waitForTimeout(600);
  assert.equal(await searchPanel(page).count(), 1);
  await dismissSearch(page);
  await waitForPath(shownPanel(page), second);
  assert.deepEqual(errors, []);
}));
