const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, showWritten, shownPanel, drawnLines, lineBoxes, cursorAt } = require('./editor-ui.cjs');
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

test('a fenced code block is drawn as a bordered block', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-code', lists, async ({ home, page, errors }) => {
  const file = join(home, 'code.md');
  await showWritten(page, file, '```ts\nconst x = 1;\n```\n\nafter\n', 'const x');
  // The caret leaves the code so its fences give way to the box's edges.
  await lineBoxes(shownPanel(page)).nth(4).click();
  await until(async () => (await md(page, 'cm-md-codeblock-top').count()) > 0);
  assert.ok(await md(page, 'cm-md-codeblock-bottom').count() > 0);
  assert.equal(await md(page, 'cm-md-code-lang').innerText(), 'ts');
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
  const code = shownPanel(page).locator('.cm-content');
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
const sinkLines = sinkBody.trimEnd().split('\n').length;
const activeLineNo = (page) => page.evaluate(() => {
  const gutter = document.querySelector('.cm-activeLineGutter');
  if (gutter && gutter.textContent.trim()) return Number(gutter.textContent);
  const lines = [...document.querySelectorAll('.cm-content .cm-line')];
  const active = document.querySelector('.cm-content .cm-activeLine');
  return active ? lines.indexOf(active) + 1 : 0;
});

test('every markdown element renders on a page the caret is not editing', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sink', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sink.md');
  await showWritten(page, file, sinkBody, 'tail');
  for (const cls of ['cm-md-h1', 'cm-md-h2', 'cm-md-h3', 'cm-md-bold', 'cm-md-italic', 'cm-md-strike', 'cm-md-code', 'cm-md-link', 'cm-md-image', 'cm-md-bullet', 'cm-md-task', 'cm-md-quote', 'cm-md-rule', 'cm-md-codeblock-top', 'cm-md-table']) {
    await until(async () => (await md(page, cls).count()) > 0, { timeout: 30000 });
  }
  assert.equal(await md(page, 'cm-md-code-lang').innerText(), 'ts');
  assert.deepEqual(errors, []);
}));

test('j and k walk every source line of a fully rendered page, keeping each line box', { timeout: 120000 }, () => withWindow('wangcai-editor-preview-sweep', lists, async ({ home, page, errors }) => {
  const file = join(home, 'sweep.md');
  await showWritten(page, file, sinkBody, 'tail');
  await until(async () => (await md(page, 'cm-md-table').count()) > 0);
  await lineBoxes(shownPanel(page)).nth(0).click();
  await until(async () => (await activeLineNo(page)) === 1);
  // Down through headings, marks, link, image, list, task, quote, rule, fence, table: no line may be skipped.
  for (let n = 2; n <= sinkLines; n++) {
    await page.keyboard.press('j');
    await until(async () => (await activeLineNo(page)) === n);
  }
  // The block renders survive the walk (the caret ends on the plain tail line).
  for (const cls of ['cm-md-rule', 'cm-md-codeblock-top', 'cm-md-quote']) {
    assert.ok(await md(page, cls).count() > 0, `${cls} collapsed during the walk`);
  }
  // And back up to the top, one line at a time.
  for (let n = sinkLines - 1; n >= 1; n--) {
    await page.keyboard.press('k');
    await until(async () => (await activeLineNo(page)) === n);
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
  await lineBoxes(shownPanel(page)).nth(9).click();
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
  assert.deepEqual(errors, []);
}));