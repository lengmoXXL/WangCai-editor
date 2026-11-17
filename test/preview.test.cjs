const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, showWritten, shownPanel, drawnLines, lineBoxes, cursorAt, tableGrid, tableCells, pickedCells, taskBoxes, taskMarkers, taskCentreDelta, codeBlockHeader, codeCopyButton, codeSourceToggle, clearClipboard, clipboardText, codeContent } = require('./editor-ui.cjs');
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
  await until(async () => (await md(page, 'cm-md-task').count()) > 0);
  await md(page, 'cm-md-task').click();
  await until(() => readFileSync(file, 'utf8').startsWith('- [x] a task'));
  assert.deepEqual(errors, []);
}));

test('a task checkbox sits on the text centreline and its source marker reads blue', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-task-align', lists, async ({ home, page, errors }) => {
  const file = join(home, 'taskalign.md');
  await showWritten(page, file, '# T\n\n- [x] 视图\n- [ ] item2\n', 'T');
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await taskBoxes(shownPanel(page)).count()) > 0);
  const delta = await taskCentreDelta(shownPanel(page));
  assert.ok(delta <= 0.5, `checkbox off the text centreline by ${delta}px`);
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
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
  assert.ok(await codeCopyButton(shownPanel(page)).count() > 0);
  assert.ok(await md(page, 'cm-codeblock-content').count() > 0);
  assert.deepEqual(errors, []);
}));

test('an indented code block keeps its box, which the community inline mode does not draw', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-indentcode', lists, async ({ home, page, errors }) => {
  const file = join(home, 'indent.md');
  await showWritten(page, file, '    const x = 1;\n    const y = 2;\n\ntail\n', 'tail');
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.ok(await md(page, 'cm-md-codeblock-bottom').count() > 0);
  assert.deepEqual(errors, []);
}));

test('the code block Copy button lifts every line of the code', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codecopy', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codecopy.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\ntail\n', 'tail');
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
  await clearClipboard(page);
  await codeCopyButton(shownPanel(page)).click();
  await until(async () => (await clipboardText(page)).trim() === 'const a = 1;\nconst b = 2;\nconst c = 3;');
  assert.deepEqual(errors, []);
}));

test('code lines stay editable text and a drag across them copies every line', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codeedit', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codeedit.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\ntail\n', 'tail');
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
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

test('the MD button reads the fences and code as source', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-codesource', lists, async ({ home, page, errors }) => {
  const file = join(home, 'codesource.md');
  await showWritten(page, file, '# T\n\n```ts\nconst a = 1;\n```\n\ntail\n', 'tail');
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
  await codeSourceToggle(shownPanel(page)).click();
  await until(async () => (await lineBoxes(shownPanel(page)).filter({ hasText: '```ts' }).count()) > 0);
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

// A page holding every mark the preview draws, one element per line, so a case can read each render and walk each
// editable line; the two fences are widget rows the walk steps over.
const sinkBody = '# H1\n## H2\n### H3\nplain **bold** *it* ~~strike~~ `code`\n[link](https://example.com)\n![alt](./local.png)\n- item one\n- [ ] task\n> quote line\n---\n```ts\nconst x = 1;\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\ntail\n';
const sinkRows = sinkBody.trimEnd().split('\n');

// The community code block swaps each fence for a header/footer widget row, so widget rows and line boxes each count as
// one source line. Read the shown pane only: a hidden tab keeps its own rows in the document.
const activeLineNo = (page) => codeContent(shownPanel(page)).evaluate((content) => {
  let src = 0;
  let active = 0;
  for (const row of content.children) {
    if (!row.classList.contains('cm-line') && !row.classList.contains('cm-codeblock-header') && !row.classList.contains('cm-codeblock-footer')) continue;
    src += 1;
    if (row.classList.contains('cm-activeLine')) active = src;
  }
  return active;
});

test('every markdown element renders on a page the caret is not editing', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sink', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sink.md');
  await showWritten(page, file, sinkBody, 'tail');
  for (const cls of ['cm-md-h1', 'cm-md-h2', 'cm-md-h3', 'cm-md-bold', 'cm-md-italic', 'cm-md-strike', 'cm-md-code', 'cm-md-link', 'cm-md-image', 'cm-md-bullet', 'cm-md-task', 'cm-md-quote', 'cm-md-rule', 'cm-codeblock-content', 'cm-md-table']) {
    await until(async () => (await md(page, cls).count()) > 0, { timeout: 30000 });
  }
  assert.ok(await codeCopyButton(shownPanel(page)).count() > 0);
  assert.deepEqual(errors, []);
}));

test('j and k walk every editable line of a fully rendered page, stepping over the code fences', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sweep', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sweep.md');
  await showWritten(page, file, sinkBody, 'tail');
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  const walk = sinkRows.map((_, i) => i + 1).filter((n) => !sinkRows[n - 1].startsWith('```'));
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await activeLineNo(page)) === walk[0]);
  // Down through headings, marks, link, image, list, task, quote, rule, code and table, stepping over the two fences: no
  // editable line may be skipped.
  for (let i = 1; i < walk.length; i++) {
    await page.keyboard.press('j');
    await until(async () => (await activeLineNo(page)) === walk[i]);
  }
  // The block renders survive the walk (the caret ends on the plain tail line).
  for (const cls of ['cm-md-rule', 'cm-codeblock-content', 'cm-md-quote']) {
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
  // Up over the opening fence, the blank, the code heading and the blank onto the table: no editable line skipped.
  for (const n of [8, 7, 6, 5]) {
    await page.keyboard.press('k');
    await until(async () => (await activeLineNo(page)) === n);
  }
  assert.equal(await md(page, 'cm-md-table').count(), 0);
  for (let i = 0; i < 3; i++) await page.keyboard.press('k');
  await until(async () => (await activeLineNo(page)) === 2);
  await until(async () => (await md(page, 'cm-md-table').count()) === 1);
  // Back down onto the blank line below the closing fence: a blank source line beside a widget row still counts itself.
  for (let i = 0; i < 8; i++) await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 12);
  assert.deepEqual(errors, []);
}));

test('j and k at a document edge never rest the caret on a code fence', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-fenceedge', lists, async ({ home, page, errors }) => {
  const file = join(home, 'edge.md');
  await showWritten(page, file, '```ts\nconst a = 1;\n```', 'const a');
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
  await lineBoxes(shownPanel(page)).filter({ hasText: 'const a = 1;' }).click();
  await page.keyboard.press('k');
  await until(async () => (await activeLineNo(page)) === 2);
  await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 2);
  await showWritten(page, join(home, 'edge2.md'), '# T\n\n```ts\nconst a = 1;\n```', 'const a');
  await until(async () => (await codeBlockHeader(shownPanel(page)).count()) > 0);
  await lineBoxes(shownPanel(page)).filter({ hasText: 'const a = 1;' }).click();
  await page.keyboard.press('j');
  await until(async () => (await activeLineNo(page)) === 4);
  await page.keyboard.press('k');
  await until(async () => (await activeLineNo(page)) === 2);
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
  const file = join(home, 'image.md');
  await showWritten(page, file, '# Pic\n\n![a picture](./pic.png)\n\n![gone](./missing.png)\n\n![bad](./100%.png)\n\ntail\n', 'tail');
  // The present image's bytes come through the channel and draw; the missing and the malformed keep the named card.
  await until(async () => (await shownPanel(page).locator('.cm-md-image img').count()) > 0 && loadedPicture(page), { timeout: 30000 });
  await until(async () => (await md(page, 'cm-md-image-missing').count()) === 2, { timeout: 30000 });
  // The tall picture must not leave the line-number gutter drifted from the content below it.
  const drift = await page.evaluate(() => {
    const tops = new Map([...document.querySelectorAll('.cm-gutterElement')].map((el) => [el.textContent.trim(), el.getBoundingClientRect().top]));
    let max = 0;
    document.querySelectorAll('.cm-content .cm-line').forEach((el, i) => {
      const top = tops.get(String(i + 1));
      if (top !== undefined) max = Math.max(max, Math.abs(top - el.getBoundingClientRect().top));
    });
    return max;
  });
  assert.ok(drift < 3, `gutter drifted ${drift}px from the content`);
  // The caret onto the picture's line brings its markdown back as text.
  await lineBoxes(shownPanel(page)).nth(2).click();
  await until(async () => (await drawnLines(page))[2] === '![a picture](./pic.png)');
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
