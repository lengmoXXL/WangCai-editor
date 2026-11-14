const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, showWritten, shownPanel, drawnLines, lineBoxes } = require('./editor-ui.cjs');
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