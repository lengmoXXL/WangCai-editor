const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { buildSync } = require('esbuild');
const { clickFile, codeShowing, dismissSearch, editorFocused, fileSearchEmpty, landedOn, lists, machine, openSearch, queryApplied, search, searchInput, searchMarks, searchPanel, searchRow, searchRowEntries, searchRows, shownPanel, shows, showWritten, storedHistory, submitSearch, waitForPath } = require('./editor-ui.cjs');
const { until, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');

const rowLimit = 200;

test('grep returns its first 500 hits when rg writes more than 8 MiB', () => withWindow('wangcai-editor-large-grep', lists, async ({ home, page }) => {
  const path = join(home, 'corpus');
  mkdirSync(path);
  const context = 'x'.repeat(18000);
  for (let i = 0; i < 60; i++) {
    const name = String(i).padStart(2, '0') + '.txt';
    writeFileSync(join(path, name), Array.from({ length: 10 }, (_, row) => `target ${row}\n${context}\n`).join(''));
  }
  const hits = await page.evaluate(query => window.wangcai.call('request', 'editor', 'grep', query),
    { machine, path, query: 'target', args: ['--sort', 'path', '-A1'] });
  assert.equal(hits.length, 500);
  assert.deepEqual(hits[0], { path: join(path, '00.txt'), line: 1, column: 1, text: 'target 0' });
  assert.deepEqual(hits.at(-1), { path: join(path, '49.txt'), line: 19, column: 1, text: 'target 9' });
}));

test('search uses the machine’s rg encoding and only lists terminated filenames', () => withHome('wangcai-editor-rg-config', lists, async ({ home, env, open }) => {
  env.RIPGREP_CONFIG_PATH = join(home, 'rg.conf');
  writeFileSync(env.RIPGREP_CONFIG_PATH, '--encoding=none\n');
  const { page } = await open();
  const file = join(home, 'signature.txt');
  await showWritten(page, file, '\uFEFFx\rnext\nlast', 'x');
  for (const [query, args, coordinates] of [['^\uFEFFx', [], [[1, 1]]], ['x', [], [[1, 1], [2, 3]]], ['last', ['-N'], [[3, 1]]]]) {
    const hits = await page.evaluate(payload => window.wangcai.call('request', 'editor', 'grep', payload), {
      machine, path: home, query, args: [...args, '--', file],
    });
    assert.deepEqual(hits.map(hit => [hit.line, hit.column]), coordinates);
  }
  for (const args of [['--version'], ['--type-list'], ['--count', '--null-data', '-H', 'next', file]]) {
    const paths = await page.evaluate(payload => window.wangcai.call('request', 'editor', 'find-files', payload), { machine, path: home, args });
    assert.deepEqual(paths, []);
  }
  const directory = join(home, 'nested'), name = 'source.txt';
  mkdirSync(directory);
  const source = '中文🐈 CodeMirror 猫';
  writeFileSync(join(directory, name), source);
  for (const encoding of ['latin1', 'shift_jis', 'big5', 'euc-kr']) {
    writeFileSync(env.RIPGREP_CONFIG_PATH, `--encoding=${encoding}\n`);
    for (const args of [[], ['-E', encoding]]) {
      const hits = await page.evaluate(payload => window.wangcai.call('request', 'editor', 'grep', payload), {
        machine, path: home, query: 'CodeMirror', args: [...args, '--path-separator', '@', '--', `nested/${name}`],
      });
      assert.deepEqual(hits, [{ path: join(directory, name), line: 1, column: source.indexOf('CodeMirror') + 1, text: source }]);
    }
  }
  const paths = await page.evaluate(payload => window.wangcai.call('request', 'editor', 'find-files', payload), {
    machine, path: home, args: ['--color', 'always', '--path-separator', '@', '--', `nested/${name}`],
  });
  assert.deepEqual(paths, [join(directory, name)]);
}));

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
  await clickFile(page, { type: 'file', machine: { ...machine, id: 'external-local' }, path: nested });
  await waitForPath(shownPanel(page), nested);
  await search(page, `>${grepToken}`);
  await searchRow(page, `${basename(main)}:${grepRow}`).click();
  await landedOn(page, main, grepLine);
  const cursor = await page.evaluate(() => window.wangcai.call('request', 'editor', 'cursor'));
  assert.deepEqual(cursor.machine, machine);
  await clickFile(page, { type: 'file', machine: { ...machine, id: 'external-local' }, path: onlyFile });
  await waitForPath(shownPanel(page), onlyFile);
  await search(page, basename(main));
  await mainRow.waitFor();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.wangcai.call('publish', 'workspace:active', null));
  await page.clock.runFor(20);
  await mainRow.waitFor({ state: 'detached' });
  assert.equal(await searchInput(page).inputValue(), basename(main));
  await page.clock.resume();
  await searchInput(page).fill(`${basename(main)} -- -- '${main}'`);
  const [workspaceId] = Object.keys(await storedHistory(page));
  await page.evaluate(active => window.wangcai.call('publish', 'workspace:active', active), { workspaceId, machine, path: '/', base: '/' });
  await until(async () => await mainRow.innerText() === main.slice(1));
  await searchInput(page).fill(`>${grepToken} -- -- '${main}'`);
  const detail = searchRow(page, `${basename(main)}:${grepRow}`).locator('.search-detail');
  await until(async () => await detail.innerText() === `${main.slice(1)}:${grepRow}`);
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

test('receiving the same search scope keeps the current results after the debounce', () => withWindow('wangcai-editor-search-scope', lists, async ({ page }) => {
  await page.setContent('<main></main>');
  const { outputFiles } = buildSync({ stdin: { resolveDir: join(__dirname, '..'), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Search } from './ui/search';
    const root = createRoot(document.querySelector('main'));
    const machine = { id: 'local' };
    const visited = { type: 'file', machine, path: '/work/one/dup.ts' };
    window.searchCalls = [];
    window.previews = [];
    const context = { ui: { async request(method) {
      window.searchCalls.push(method);
      if (method === 'grep') return [3, 8].map(line => ({ path: '/work/two/dup.ts', line, column: 2, text: 'dup' }));
      const files = ['/work/one/dup.ts', '/work/two/dup.ts'];
      return window.searchCalls.length === 1 ? files : files.reverse();
    } } };
    const noop = () => {};
    const peek = file => window.previews.push([file.path, file.line, file.column]);
    window.activateScope = () => flushSync(() => root.render(<Search context={context} visited={visited}
      workspace={{ type: 'directory', machine: { ...machine }, path: '/work' }} visitedReady peek={peek} navigate={noop} close={noop} />));
  ` }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  await page.evaluate(outputFiles[0].text);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.activateScope());
  await page.clock.runFor(200);
  await searchInput(page).fill('dup');
  await queryApplied(page);
  await page.clock.runFor(150);
  const first = ['/work/one/dup.ts', undefined, undefined];
  assert.deepEqual(await page.evaluate(() => window.previews), [first]);
  await page.evaluate(() => window.activateScope());
  await page.clock.runFor(300);
  assert.deepEqual(await page.evaluate(() => window.searchCalls), ['find-files']);
  assert.deepEqual(await page.evaluate(() => window.previews), [first]);
  assert.deepEqual((await searchRowEntries(page)).map(row => row.text), ['one/dup.ts', 'two/dup.ts']);
  await searchInput(page).fill('>dup');
  await page.clock.runFor(350);
  await page.evaluate(() => window.activateScope());
  await page.clock.runFor(300);
  assert.deepEqual(await page.evaluate(() => window.searchCalls), ['find-files', 'grep']);
  await searchInput(page).press('ArrowDown');
  await page.clock.runFor(150);
  assert.deepEqual(await page.evaluate(() => window.previews), [first, ['/work/two/dup.ts', 3, 2], ['/work/two/dup.ts', 8, 2]]);
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
  const box = await firstRow.boundingBox();
  await dismissSearch(page);
  await until(() => editorFocused(page));
  // Leave the pointer where a result will appear, then open the picker using only the keyboard.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Control+f');
  await firstRow.waitFor();
  await page.waitForTimeout(400);
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
  await searchInput(page).fill('-- -g no-such-file');
  await fileSearchEmpty(page).waitFor();
  await searchInput(page).fill('-- -- kept.ts');
  await keptRow.waitFor();
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('the flags after the separator narrow what a content search greps', { timeout: 120000 }, () => withWindow('wangcai-editor-search-grep-flags', lists, async ({ home, page, errors }) => {
  const token = 'GREP_FLAGGED';
  const hitLine = `const ${token} = 1;`;
  const one = join(home, 'one.ts');
  const two = join(home, 'two.md');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'editor-test-preprocessor'), '#!/bin/sh\ncat "$1"\n', { mode: 0o755 });
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
  await search(page, `>${token} -- --pre editor-test-preprocessor -g '*.md'`);
  await searchRow(page, `${basename(two)}:1`).waitFor();
  await dismissSearch(page);
  const docs = join(home, 'my docs'), mixed = join(docs, 'mixed.md');
  mkdirSync(docs);
  writeFileSync(mixed, `\uFEFF无\r匹配\r\n另\n🐈 ${token}\rsecond ${token}\r\n`);
  await search(page, `>${token} -- -N -E none -g 'my docs/*.md'`);
  await searchRow(page, 'mixed.md:4').waitFor();
  await searchRow(page, 'mixed.md:5').waitFor();
  assert.equal(await searchRow(page, 'two.md').count(), 0);
  await searchRow(page, 'mixed.md:4').click();
  await landedOn(page, mixed, `🐈 ${token}`);
  const cursor = await page.evaluate(() => window.wangcai.call('request', 'editor', 'cursor'));
  assert.deepEqual([cursor.line, cursor.column], [4, 4]);
  const encodingLike = join(docs, 'Enone');
  writeFileSync(encodingLike, '\uFEFFa\nx\nx\n');
  await search(page, '>x -- -NgEnone');
  await searchRow(page, 'Enone:3').waitFor();
  await dismissSearch(page);
  await search(page, '>a -- -E none -g Enone');
  await searchRow(page, 'Enone:1').click();
  await landedOn(page, encodingLike, 'a');
  const first = await page.evaluate(() => window.wangcai.call('request', 'editor', 'cursor'));
  assert.deepEqual([first.line, first.column], [1, 1]);
  await openSearch(page);
  await searchInput(page).fill(`>${token} -- -l -- '${one}'`);
  await searchPanel(page).getByText('没有匹配的内容', { exact: true }).waitFor();
  const events = join(home, 'events.txt');
  const data = { path: { text: 'other.txt' }, lines: { text: token } };
  writeFileSync(events, [data, { ...data, line_number: 1, absolute_offset: 0, submatches: [{ start: 0 }] }]
    .map(data => JSON.stringify({ type: 'match', data })).join('\n'));
  for (const [flags, lines] of [[['--no-json', '--no-filename', '--no-line-number'], []], [['-l', '--json'], [1, 2]]]) {
    const hits = await page.evaluate(payload => window.wangcai.call('request', 'editor', 'grep', payload), {
      machine, path: home, query: token, args: [...flags, '--', events],
    });
    assert.deepEqual(hits.map(hit => [hit.path, hit.line]), lines.map(line => [events, line]));
  }
  assert.deepEqual(errors, []);
}));

test('accepting a file by Enter or click keeps the cursor and scroll reached in its preview', () => withWindow('wangcai-editor-search-accept', lists, async ({ home, page, errors }) => {
  const start = join(home, 'start.txt'), long = join(home, 'long-preview.txt');
  writeFileSync(long, Array.from({ length: 200 }, (_, row) => `text on row ${row + 1}`).join('\n'));
  await showWritten(page, start, 'start', 'start');
  const panel = shownPanel(page), scroller = panel.locator('.cm-scroller');
  for (const [action, top] of [['Enter', 800], ['click', 0]]) {
    await search(page, basename(long));
    await waitForPath(panel, long);
    await panel.locator('.cm-content').focus();
    await page.keyboard.type('80Gl');
    await until(async () => {
      const cursor = await page.evaluate(() => window.wangcai.call('request', 'editor', 'cursor'));
      return cursor?.line === 80 && cursor.column === 2;
    });
    await searchInput(page).click();
    await until(() => scroller.evaluate(element => element.scrollTop > 0));
    await scroller.evaluate(async (element, top) => {
      element.scrollTop = top;
      await new Promise(requestAnimationFrame);
    }, top);
    if (action === 'Enter') await searchInput(page).press('Enter');
    else await searchRow(page, basename(long)).click();
    await searchPanel(page).waitFor({ state: 'detached' });
    let entry;
    await until(async () => {
      const [history] = Object.values(await storedHistory(page));
      entry = history.entries[history.index];
      return entry.path === long;
    });
    assert.deepEqual([entry.line, entry.column, entry.top], [80, 2, top]);
    assert.equal(await scroller.evaluate(element => element.scrollTop), top);
    await page.keyboard.press('Control+o');
    await waitForPath(panel, start);
    await page.keyboard.press('Control+i');
    await waitForPath(panel, long);
    await until(() => editorFocused(page));
    await until(() => scroller.evaluate((element, top) => element.scrollTop === top, top));
    await page.keyboard.press('Control+o');
    await waitForPath(panel, start);
  }
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
