const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, showWritten, shownPanel, drawnLines, lineBoxes, cursorAt, tableGrid, tableCells, pickedCells, taskBoxes, taskMarkers, taskCentreDelta, selectionMarks, clearClipboard, clipboardText, codeContent } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// The header's switch between the rendered page and its source, and the marks the live preview draws.
const previewToggle = (page) => page.getByRole('button', { name: '切换实时预览', exact: true });
const md = (page, cls) => shownPanel(page).locator(`.${cls}`);

const body = '# Title\n\nSome **bold** text.\n';

test('a markdown file opens rendered, and the caret line keeps its syntax', { timeout: 120000 }, () => withWindow('wangcai-editor-preview', lists, async ({ home, page, errors }) => {
  const file = join(home, 'preview.md');
  await showWritten(page, file, body, 'Title');
  await previewToggle(page).waitFor();
  await until(async () => (await md(page, 'cm-md-h1').count()) > 0);
  assert.ok(await md(page, 'cm-md-bold').count() > 0);
  // The caret rests on the title, so the bold line below it reads clean, without its marks.
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await drawnLines(page))[2] === 'Some bold text.');
  // The caret onto the bold line brings its marks back, the line being edited reading as text.
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await drawnLines(page))[2] === 'Some **bold** text.');
  assert.deepEqual(errors, []);
}));

test('a bold run closed against a CJK letter still renders, its stars hidden', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-cjk-bold', lists, async ({ home, page, errors }) => {
  const file = join(home, 'cjk.md');
  const line = '**1885 年《伦敦之后》**第一次系统写;**1912 年《猩红瘟疫》**把镜头移开。';
  await showWritten(page, file, `# Title\n\n${line}\n`, 'Title');
  await until(async () => (await md(page, 'cm-md-bold').count()) >= 2);
  // The caret rests on the title, so the CJK line reads clean: both runs closed even though a CJK letter follows each.
  await until(async () => (await drawnLines(page))[2] === '1885 年《伦敦之后》第一次系统写;1912 年《猩红瘟疫》把镜头移开。');
  assert.deepEqual(errors, []);
}));

test('the toggle swaps the rendered page for its source and back', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-toggle', lists, async ({ home, page, errors }) => {
  const file = join(home, 'toggle.md');
  await showWritten(page, file, body, 'Title');
  await until(async () => (await md(page, 'cm-md-bold').count()) > 0);
  assert.equal(await previewToggle(page).getAttribute('aria-pressed'), 'true');
  await previewToggle(page).click();
  // Source: the preview marks are gone and the raw syntax shows on every line.
  await until(async () => (await md(page, 'cm-md-bold').count()) === 0);
  assert.ok((await drawnLines(page)).some((l) => l.includes('**bold**')));
  assert.equal(await previewToggle(page).getAttribute('aria-pressed'), 'false');
  await previewToggle(page).click();
  await until(async () => (await md(page, 'cm-md-bold').count()) > 0);
  assert.equal(await previewToggle(page).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
}));

test('a task checkbox ticks the task over in the file', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-task', lists, async ({ home, page, errors }) => {
  const file = join(home, 'task.md');
  await showWritten(page, file, '- [ ] a task\n\nplain\n', 'a task');
  // The caret leaves the task line so its checkbox is drawn, then the checkbox is clicked.
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await taskBoxes(shownPanel(page)).count()) > 0);
  await taskBoxes(shownPanel(page)).click();
  await until(() => readFileSync(file, 'utf8').startsWith('- [x] a task'));
  assert.deepEqual(errors, []);
}));

test('a task checkbox answers the keyboard, shows a focus ring and falls back under high contrast', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-task-a11y', lists, async ({ home, page, errors }) => {
  const file = join(home, 'taska11y.md');
  await showWritten(page, file, '- [ ] a task\n\nplain\n', 'a task');
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await taskBoxes(shownPanel(page)).count()) > 0);
  const box = taskBoxes(shownPanel(page)).first();
  await box.evaluate((el) => el.focus());
  await page.keyboard.press('Space');
  await until(() => readFileSync(file, 'utf8').startsWith('- [x] a task'));
  const ring = await box.evaluate((el) => { el.focus(); return { visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineWidth }; });
  assert.ok(ring.visible, 'the focused checkbox shows no focus ring');
  assert.equal(ring.outline, '2px');
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await box.evaluate((el) => getComputedStyle(el).appearance), 'auto');
  assert.deepEqual(errors, []);
}));

test('a task checkbox sits on the text centreline and its source marker reads blue', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-task-align', lists, async ({ home, page, errors }) => {
  const file = join(home, 'taskalign.md');
  await showWritten(page, file, '# T\n\n- [x] 视图\n- [ ] item2\n', 'T');
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await taskBoxes(shownPanel(page)).count()) > 0);
  const delta = await taskCentreDelta(shownPanel(page));
  // The chosen baseline offset leaves the box under a pixel off the centreline; a whole pixel still catches a real misplacement.
  assert.ok(delta <= 1, `checkbox off the text centreline by ${delta}px`);
  // The caret line reads the marker as source; its hue is the heading blue, not the numeric yellow.
  await lineBoxes(shownPanel(page)).nth(3).click();
  await until(async () => (await taskMarkers(shownPanel(page)).count()) > 0);
  const [marker, heading] = await Promise.all([
    taskMarkers(shownPanel(page)).last().evaluate((el) => getComputedStyle(el).color),
    md(page, 'cm-md-h1').evaluate((el) => getComputedStyle(el).color),
  ]);
  assert.equal(marker, heading);
  assert.deepEqual(errors, []);
}));

test('a fenced code block is drawn as a bordered block', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-code', lists, async ({ home, page, errors }) => {
  const file = join(home, 'code.md');
  await showWritten(page, file, '```ts\nconst x = 1;\n```\n\nafter\n', 'const x');
  await lineBoxes(shownPanel(page)).filter({ hasText: 'after' }).click();
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.ok(await md(page, 'cm-md-codeblock-bottom').count() > 0);
  assert.ok(await md(page, 'cm-md-codeblock').count() > 0);
  assert.equal(await md(page, 'cm-md-code-lang').innerText(), 'ts');
  assert.ok(await md(page, 'cm-md-code-lang').evaluate((el) => el.closest('.cm-line').classList.contains('cm-md-codeblock-top')));
  assert.deepEqual(errors, []);
}));

test('an indented code block keeps its box', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-indentcode', lists, async ({ home, page, errors }) => {
  const file = join(home, 'indent.md');
  await showWritten(page, file, '    const x = 1;\n    const y = 2;\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).filter({ hasText: 'tail' }).click();
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.ok(await md(page, 'cm-md-codeblock-bottom').count() > 0);
  assert.deepEqual(errors, []);
}));

test('an unnamed fence hides its first row like the last', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-unnamed', lists, async ({ home, page, errors }) => {
  const file = join(home, 'unnamed.md');
  await showWritten(page, file, '# T\n\n```\nplain\n```\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).filter({ hasText: 'tail' }).click();
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.equal(await md(page, 'cm-md-code-lang').count(), 0);
  assert.equal(await md(page, 'cm-md-codeblock-lang').count(), 0);
  assert.equal(await md(page, 'cm-md-codeblock-top').innerText(), 'plain');
  assert.equal(await lineBoxes(shownPanel(page)).filter({ hasText: '```' }).count(), 0);
  for (const language of ['js', '']) {
    writeFileSync(file, `# T\n\n\`\`\`${language}\n\n\`\`\`\n\ntail`);
    const row = md(page, language ? 'cm-md-codeblock-start' : 'cm-md-codeblock-top');
    await until(async () => await row.evaluateAll(nodes => nodes.some(el => !el.textContent && el.classList.contains('cm-md-codeblock-bottom'))));
  }
  assert.deepEqual(errors, []);
}));

test('a drag across code lines selects them visibly and copies every line', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codecopy', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codecopy.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\ntail\n', 'tail');
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  const lines = lineBoxes(shownPanel(page));
  const a = await lines.filter({ hasText: 'const a = 1;' }).boundingBox();
  const b = await lines.filter({ hasText: 'const c = 3;' }).boundingBox();
  await page.mouse.move(a.x + 5, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await until(async () => (await selectionMarks(shownPanel(page)).count()) > 0);
  await clearClipboard(page);
  await page.keyboard.press('Meta+c');
  await until(async () => (await clipboardText(page)).trim() === 'const a = 1;\nconst b = 2;\nconst c = 3;');
  assert.deepEqual(errors, []);
}));

test('code lines stay editable text and a drag across them copies every line', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codeedit', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codeedit.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\ntail\n', 'tail');
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  const lines = lineBoxes(shownPanel(page));
  const first = lines.filter({ hasText: 'const a = 1;' });
  const a = await first.boundingBox();
  const b = await lines.filter({ hasText: 'const c = 3;' }).boundingBox();
  await page.mouse.move(a.x + 5, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await clearClipboard(page);
  await page.keyboard.press('Meta+c');
  await until(async () => (await clipboardText(page)).trim() === 'const a = 1;\nconst b = 2;\nconst c = 3;');
  await first.click();
  await page.keyboard.press('I');
  await page.keyboard.type('Q');
  await until(async () => (await lineBoxes(shownPanel(page)).filter({ hasText: 'Qconst a = 1;' }).count()) > 0);
  assert.deepEqual(errors, []);
}));

test('rendered code carries highlight spans over the box', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codehl', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codehl.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\n```\n\ntail\n', 'tail');
  const keyword = md(page, 'cm-md-codeblock').locator('.hljs-keyword');
  await until(async () => (await keyword.count()) > 0);
  const colour = await keyword.first().evaluate((el) => getComputedStyle(el).color);
  const plain = await md(page, 'cm-md-codeblock').first().evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(colour, plain);
  writeFileSync(file, '# T\n\n```ts\nconst answer = 42;');
  await md(page, 'cm-md-codeblock').filter({ hasText: 'const answer = 42;' }).waitFor();
  writeFileSync(file, '# T\n\n> ```js\n> const a = 1;\n> const b = 2;\n> const c = 3;\n> ```');
  await md(page, 'cm-md-codeblock-bottom').filter({ hasText: 'const c = 3;' }).waitFor();
  assert.deepEqual(await keyword.allTextContents(), ['const', 'const', 'const']);
  assert.deepEqual(errors, []);
}));

test('the caret inside a code block reads it as raw source and leaving renders it again', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codesource', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codesource.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\n```\n\ntail\n', 'tail');
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.equal(await lineBoxes(shownPanel(page)).filter({ hasText: '```ts' }).count(), 0);
  assert.ok(await md(page, 'cm-md-codeblock').count() > 0);
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await lineBoxes(shownPanel(page)).filter({ hasText: '```ts' }).count()) > 0);
  assert.equal(await md(page, 'cm-md-codeblock').count(), 0);
  await lineBoxes(shownPanel(page)).filter({ hasText: 'tail' }).click();
  await until(async () => (await lineBoxes(shownPanel(page)).filter({ hasText: '```ts' }).count()) === 0);
  assert.ok(await md(page, 'cm-md-codeblock').count() > 0);
  assert.deepEqual(errors, []);
}));

test('a file that is not markdown has no preview toggle', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-notmd', lists, async ({ home, page, errors }) => {
  const file = join(home, 'code.ts');
  await showWritten(page, file, 'const x = 1;\n', 'const x');
  assert.equal(await previewToggle(page).count(), 0);
  assert.deepEqual(errors, []);
}));

test('a table is drawn as a bordered grid with alignment and inline marks', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-table', lists, async ({ home, page, errors }) => {
  const file = join(home, 'table.md');
  await showWritten(page, file, '| a | b |\n| :--- | ---: |\n| **x** | `y` |\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).nth(4).click();
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  const table = md(page, 'cm-md-table');
  assert.equal(await table.locator('th').count(), 2);
  assert.equal(await table.locator('td').count(), 2);
  assert.equal(await table.locator('td').nth(1).evaluate((el) => el.style.textAlign), 'right');
  assert.ok(await table.locator('td strong.cm-md-bold').count() > 0);
  assert.ok(await table.locator('td code.cm-md-code').count() > 0);
  assert.deepEqual(errors, []);
}));

test('a table cell keeps an escaped pipe and reads its inline marks from the tree', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-table-tree', lists, async ({ home, page, errors }) => {
  const file = join(home, 'tabletree.md');
  await showWritten(page, file, '| a | b |\n| --- | --- |\n| p\\|q | **x** |\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).nth(4).click();
  await until(async () => (await tableGrid(shownPanel(page)).count()) > 0);
  const cells = tableCells(shownPanel(page));
  assert.equal(await cells.count(), 2);
  assert.equal(await cells.nth(0).innerText(), 'p|q');
  assert.ok(await cells.nth(1).locator('strong.cm-md-bold').count() > 0);
  assert.equal(await cells.nth(1).innerText(), 'x');
  assert.deepEqual(errors, []);
}));

test('a drag across the drawn table selects it visibly and copies it', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-table-copy', lists, async ({ home, page, errors }) => {
  const file = join(home, 'tablecopy.md');
  await showWritten(page, file, '| 大类 | 数量 |\n| --- | --- |\n| 核战 | 21 |\n| 瘟疫 | 22 |\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).nth(5).click();
  await until(async () => (await tableGrid(shownPanel(page)).count()) > 0);
  const cells = tableCells(shownPanel(page));
  const from = await cells.nth(0).boundingBox();
  const to = await cells.nth(3).boundingBox();
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const wanted = '核战\t21\n瘟疫\t22';
  await until(async () => (await pickedCells(shownPanel(page)).count()) === 4);
  await clearClipboard(page);
  await page.keyboard.press('Meta+c');
  await until(async () => (await clipboardText(page)) === wanted);
  assert.deepEqual(errors, []);
}));

test('a table keeps its source lines above the drawn grid', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-table-edit', lists, async ({ home, page, errors }) => {
  const file = join(home, 'tableedit.md');
  await showWritten(page, file, '| a | b |\n| --- | --- |\n| x | y |\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).nth(4).click();
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  const lines = await drawnLines(page);
  assert.ok(lines.some((l) => l.includes('| a | b |')));
  assert.ok(lines.some((l) => l.includes('| x | y |')));
  assert.deepEqual(errors, []);
}));

test('entering the table shows full source and hides the grid; leaving restores it', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-jk', lists, async ({ home, page, errors }) => {
  const file = join(home, 'jk.md');
  await showWritten(page, file, '# t\n\n| a | b |\n| --- | --- |\n| x | y |\n\ntail\n', 'tail');
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  await lineBoxes(shownPanel(page)).nth(1).click();
  assert.equal(await md(page, 'cm-md-table').count(), 1);
  await page.keyboard.press('j');
  await until(() => cursorAt(page, '| a | b |'));
  await until(async () => (await md(page, 'cm-md-table').count()) === 0);
  assert.ok((await drawnLines(page)).some((l) => l.includes('| x | y |')));
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 5);
  assert.equal(await md(page, 'cm-md-table').count(), 0);
  for (let i = 0; i < 3; i++) await page.keyboard.press('k');
  await until(async () => (await activeLineNo(page)) === 2);
  await until(async () => (await md(page, 'cm-md-table').count()) === 1);
  for (let i = 0; i < 4; i++) await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 6);
  await until(async () => (await md(page, 'cm-md-table').count()) === 1);
  await page.keyboard.type('2k');
  await until(async () => (await activeLineNo(page)) === 4);
  await page.keyboard.type('2k');
  await until(async () => (await activeLineNo(page)) === 2);
  await page.keyboard.type('Vj');
  await page.keyboard.press('d');
  await until(async () => !(await drawnLines(page)).some(line => line.includes('| a | b |')));
  await page.keyboard.type('u');
  await until(async () => (await md(page, 'cm-md-table').count()) === 1);
  await lineBoxes(shownPanel(page)).nth(1).click();
  await page.keyboard.type('dj');
  await until(async () => (await drawnLines(page))[1] === '| --- | --- |');
  assert.deepEqual(errors, []);
}));

test('display-line movement stays on a wrapped heading above a collapsed table', { timeout: 120000 }, () => withWindow('wangcai-editor-wrapped-motion', lists, async ({ home, page, errors }) => {
  const file = join(home, 'wrapped.md');
  const heading = '# ' + 'long heading '.repeat(24);
  await showWritten(page, file, `${heading}\n| a | b |\n| --- | --- |\n| x | y |\n`, 'long heading');
  await md(page, 'cm-md-table').waitFor();
  await codeContent(shownPanel(page)).focus();
  await page.keyboard.type('gg0gj');
  const cursor = await page.evaluate(() => window.wangcai.call('request', 'editor', 'cursor'));
  assert.equal(cursor.line, 1);
  assert.ok(cursor.column > 1);
  await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 2);
  assert.deepEqual(errors, []);
}));

test('the divider narrows the rendered page and the choice is kept', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-width', lists, async ({ home, page, errors }) => {
  const file = join(home, 'width.md');
  await showWritten(page, file, '# T\n\na paragraph of text\n', 'T');
  const divider = shownPanel(page).locator('.editor-divider');
  await divider.waitFor();
  const code = codeContent(shownPanel(page));
  const before = (await code.boundingBox()).width;
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await code.boundingBox()).width;
  assert.ok(after < before - 100, `page did not narrow: ${before} -> ${after}`);
  // The toggle takes the divider away and brings it back at the kept width.
  await previewToggle(page).click();
  assert.equal(await divider.count(), 0);
  await previewToggle(page).click();
  await divider.waitFor();
  const restored = (await code.boundingBox()).width;
  assert.ok(Math.abs(restored - after) < 4, `width not kept: ${after} -> ${restored}`);
  assert.deepEqual(errors, []);
}));

// A page holding every mark the preview draws, one element per line, so a case can read each render and walk each line.
const sinkBody = '# H1\n## H2\n### H3\nplain **bold** *it* ~~strike~~ `code`\n[link](https://example.com)\n![alt](./local.png)\n- item one\n- [ ] task\n> quote line\n---\n```ts\nconst x = 1;\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\ntail\n';
const sinkRows = sinkBody.trimEnd().split('\n');

// Every source line keeps a line box, so the active line's index among them is its source line. Read the shown pane
// only: a hidden tab keeps its own rows in the document.
const activeLineNo = (page) => codeContent(shownPanel(page)).evaluate((content) => {
  const lines = [...content.children].filter((row) => row.classList.contains('cm-line'));
  return lines.findIndex((row) => row.classList.contains('cm-activeLine')) + 1;
});

test('every markdown element renders on a page the caret is not editing', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sink', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sink.md');
  await showWritten(page, file, sinkBody, 'tail');
  for (const cls of ['cm-md-h1', 'cm-md-h2', 'cm-md-h3', 'cm-md-bold', 'cm-md-italic', 'cm-md-strike', 'cm-md-code', 'cm-md-link', 'cm-md-image', 'cm-md-bullet', 'cm-md-task', 'cm-md-quote', 'cm-md-rule', 'cm-md-codeblock-top', 'cm-md-table']) {
    await until(async () => (await md(page, cls).count()) > 0, { timeout: 30000 });
  }
  assert.deepEqual(errors, []);
}));

test('j and k walk every source line of a fully rendered page, keeping each line box', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sweep', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sweep.md');
  await showWritten(page, file, sinkBody, 'tail');
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  const walk = sinkRows.map((_, i) => i + 1);
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await activeLineNo(page)) === walk[0]);
  // Down through headings, marks, link, image, list, task, quote, rule, fence, table: no line may be skipped.
  for (let i = 1; i < walk.length; i++) {
    await page.keyboard.press('j');
    await until(async () => (await activeLineNo(page)) === walk[i]);
  }
  // The block renders survive the walk (the caret ends on the plain tail line).
  for (const cls of ['cm-md-rule', 'cm-md-codeblock-top', 'cm-md-quote']) {
    assert.ok(await md(page, cls).count() > 0, `${cls} collapsed during the walk`);
  }
  // And back up to the top, one line at a time.
  for (let i = walk.length - 2; i >= 0; i--) {
    await page.keyboard.press('k');
    await until(async () => (await activeLineNo(page)) === walk[i]);
  }
  assert.deepEqual(errors, []);
}));

test('editing a rendered line redraws it live', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-live', lists, async ({ home, page, errors }) => {
  const file = join(home, 'live.md');
  await showWritten(page, file, sinkBody, 'tail');
  await until(async () => (await md(page, 'cm-md-h1').count()) > 0);
  await lineBoxes(shownPanel(page)).nth(0).click();
  await page.keyboard.press('A');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await until(async () => (await md(page, 'cm-md-h1').innerText()).includes('H1!'));
  assert.deepEqual(errors, []);
}));

test('k leaving a code block steps line by line past a table above it', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-kcode', lists, async ({ home, page, errors }) => {
  const file = join(home, 'kcode.md');
  await showWritten(page, file, '# t\n\n| a | b |\n| --- | --- |\n| x | y |\n\n## code\n\n```ts\nconst x = 1;\n```\n\n> q\n', 'q');
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  await lineBoxes(shownPanel(page)).filter({ hasText: 'const x = 1;' }).click();
  await until(async () => (await activeLineNo(page)) === 10);
  // Up through the fence, the blank, the code heading and the blank onto the table: no line skipped.
  for (const n of [9, 8, 7, 6, 5]) {
    await page.keyboard.press('k');
    await until(async () => (await activeLineNo(page)) === n);
  }
  assert.equal(await md(page, 'cm-md-table').count(), 0);
  for (let i = 0; i < 3; i++) await page.keyboard.press('k');
  await until(async () => (await activeLineNo(page)) === 2);
  await until(async () => (await md(page, 'cm-md-table').count()) === 1);
  // Back down onto the blank line below the closing fence.
  for (let i = 0; i < 10; i++) await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 12);
  assert.deepEqual(errors, []);
}));

// A scroll far past the parsed region must still render on its own. Pending input stalls the idle parser, and the
// page is long enough that the odd transaction's incidental parse cannot reach the end either, so only the preview's
// own parse drive can decorate the far lines; no click is ever given to wake it.
const scrollBody = Array.from({ length: 6000 }, (_, k) => `## Section ${k + 1}\n\nParagraph ${k + 1} with **bold ${k + 1}** and a longer line so the parser falls behind the scroll.\n`).join('\n');

test('a page scrolled past the parsed region renders without a click', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-scroll', lists, async ({ home, page, errors }) => {
  const file = join(home, 'scroll.md');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'scheduling', { value: { isInputPending: () => true }, configurable: true });
  });
  await showWritten(page, file, scrollBody, 'Section 1');
  await until(async () => (await md(page, 'cm-md-h2').count()) > 0);
  // Scroll to the bottom without touching the editor; the far heading must render on its own.
  await shownPanel(page).locator('.cm-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await until(async () => (await md(page, 'cm-md-h2').allInnerTexts()).some((t) => t.includes('Section 6000')), { timeout: 30000 });
  assert.deepEqual(errors, []);
}));

// A small solid-colour PNG built byte by byte, so a case has a real picture to load rather than a broken path.
const { deflateSync, crc32 } = require('node:zlib');
const pngOf = (w, h, rgb) => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    for (let x = 0; x < w; x++) { const i = row + 1 + x * 3; raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2]; }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const loadedPicture = (page) => shownPanel(page).locator('.cm-md-image img').first()
  .evaluate((el) => el.complete && el.naturalWidth > 0 && el.src.startsWith('data:image/png'));

test('a local image renders as a loaded picture, and a missing one keeps its card', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-image', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'pic.png'), pngOf(24, 16, [214, 66, 112]));
  writeFileSync(join(home, 'my image.png'), pngOf(8, 8, [2, 4, 8]));
  writeFileSync(join(home, 'chart(1).png'), pngOf(8, 8, [2, 4, 8]));
  writeFileSync(join(home, 'pic.constructor'), 'plain text');
  const file = join(home, 'image.md');
  await showWritten(page, file, '# Pic\n\n![a picture](./pic.png)\n\n![space](<my image.png>)\n\n![chart](chart(1).png "Chart")\n\n![gone](./missing.png)\n\n![bad](./100%.png)\n\n![unknown](./pic.constructor)\n\ntail\n', 'tail');
  // The present image's bytes come through the channel and draw; the missing and the malformed keep the named card.
  await until(async () => (await shownPanel(page).locator('.cm-md-image img').count()) > 0 && loadedPicture(page), { timeout: 30000 });
  for (const alt of ['space', 'chart']) await until(() => shownPanel(page).getByRole('img', { name: alt, exact: true }).evaluate(el => el.naturalWidth === 8));
  await until(async () => (await md(page, 'cm-md-image-missing').count()) === 3, { timeout: 30000 });
  // The image load schedules a CodeMirror measurement on the next animation frame.
  await until(() => shownPanel(page).locator('.cm-editor').evaluate(editor => {
    const tops = new Map([...editor.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map(el => [el.textContent.trim(), el.getBoundingClientRect().top]));
    return [...editor.querySelectorAll('.cm-content .cm-line')].every((el, i) => {
      const top = tops.get(String(i + 1));
      return top !== undefined && Math.abs(top - el.getBoundingClientRect().top) < 3;
    });
  }));
  // The caret onto the picture's line brings its markdown back as text.
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await drawnLines(page))[2] === '![a picture](./pic.png)');
  assert.deepEqual(errors, []);
}));

test('a multiline image renders once and reveals its full source while editing either line', () => withWindow('wangcai-editor-multiline-image', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'photo.png'), pngOf(8, 8, [2, 4, 8]));
  const first = 'before ![Photo](', second = 'photo.png) after';
  await showWritten(page, join(home, 'image.md'), ['# Start', '', first, second, '', 'end'].join('\n'), 'Start');
  const panel = shownPanel(page), picture = panel.getByRole('img', { name: 'Photo', exact: true });
  for (const row of [2, 3]) {
    await picture.waitFor({ timeout: 5000 });
    assert.equal(await picture.count(), 1);
    await until(() => picture.evaluate(el => el.naturalWidth === 8));
    assert.deepEqual((await drawnLines(page)).slice(2, 4), ['before ', ' after']);
    await lineBoxes(panel).nth(row).click();
    await until(async () => (await picture.count()) === 0);
    assert.deepEqual((await drawnLines(page)).slice(2, 4), [first, second]);
    await lineBoxes(panel).first().click();
  }
  await picture.waitFor();
  assert.deepEqual(errors, []);
}));

test('an image far down a long page renders on scroll without a click', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-image-scroll', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'deep.png'), pngOf(24, 16, [80, 140, 220]));
  const file = join(home, 'deep.md');
  const body = Array.from({ length: 6000 }, (_, k) => `## Section ${k + 1}\n\nParagraph ${k + 1} with **bold** text.\n`).join('\n') + '\n![deep picture](./deep.png)\n';
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'scheduling', { value: { isInputPending: () => true }, configurable: true });
  });
  await showWritten(page, file, body, 'Section 1');
  await until(async () => (await md(page, 'cm-md-h2').count()) > 0);
  // Scroll to the picture without touching the editor: it must parse, fetch its bytes and draw on its own.
  await shownPanel(page).locator('.cm-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await until(async () => (await shownPanel(page).locator('.cm-md-image img').count()) > 0 && loadedPicture(page), { timeout: 30000 });
  assert.deepEqual(errors, []);
}));

test('YAML frontmatter is drawn as a block of properties', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-frontmatter', lists, async ({ home, page, errors }) => {
  const file = join(home, 'frontmatter.md');
  await showWritten(page, file, '---\ntags: [papers, distributed-systems]\ntitle: QuePaxa\n---\n\n# Heading\n\nbody text\ntail\n', 'tail');
  // The caret leaves the frontmatter so its lines collapse and the properties draw.
  await lineBoxes(shownPanel(page)).nth(8).click();
  await until(async () => (await md(page, 'cm-md-frontmatter').count()) > 0);
  const box = md(page, 'cm-md-frontmatter');
  assert.deepEqual(await box.locator('.cm-md-frontmatter-key').allInnerTexts(), ['tags', 'title']);
  assert.deepEqual(await box.locator('.cm-md-frontmatter-item').allInnerTexts(), ['papers', 'distributed-systems']);
  assert.equal(await box.locator('.cm-md-frontmatter-row').nth(1).locator('.cm-md-frontmatter-value').innerText(), 'QuePaxa');
  assert.ok(await md(page, 'cm-md-h1').count() > 0);
  assert.deepEqual(errors, []);
}));

test('k steps up into the collapsed frontmatter and reveals its source; j leaves it again', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-frontmatter-jk', lists, async ({ home, page, errors }) => {
  const file = join(home, 'fmjk.md');
  await showWritten(page, file, '---\ntags: [papers]\n---\n\n# Heading\n\ntail\n', 'tail');
  // The blank line just below the block: the caret there keeps the properties drawn.
  await lineBoxes(shownPanel(page)).nth(3).click();
  await until(async () => (await md(page, 'cm-md-frontmatter').count()) > 0);
  await page.keyboard.press('k');
  await until(() => cursorAt(page, '---'));
  await until(async () => (await md(page, 'cm-md-frontmatter').count()) === 0);
  assert.ok((await drawnLines(page)).some((l) => l.includes('tags: [papers]')));
  await page.keyboard.press('j');
  await until(async () => (await md(page, 'cm-md-frontmatter').count()) > 0);
  assert.deepEqual(errors, []);
}));

test('a leading rule followed by prose is not frontmatter', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-frontmatter-rule', lists, async ({ home, page, errors }) => {
  const file = join(home, 'fmrules.md');
  await showWritten(page, file, '---\n# Heading\n\n---\n\ntail\n', 'tail');
  await lineBoxes(shownPanel(page)).nth(5).click();
  await until(async () => (await md(page, 'cm-md-h1').count()) > 0);
  assert.equal(await md(page, 'cm-md-frontmatter').count(), 0);
  assert.deepEqual(errors, []);
}));
