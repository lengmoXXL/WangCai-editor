const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { lists, machine, openEditorWorkspace, clickFile } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// A repository with one file committed and then changed in the worktree, so an unstaged comparison has two sides.
const repoWithChange = (home) => {
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, HOME: home };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@local');
  const file = join(repo, 'app.ts');
  writeFileSync(file, "const greet = 'hi';\nexport const answer = 41;\n");
  git('add', '.'); git('commit', '-qm', 'initial');
  writeFileSync(file, "const greet = 'hello';\nexport const answer = 42;\n");
  return file;
};

const diffHost = '.editor-diff .git-editor';
const sideB = `${diffHost} .cm-merge-b`;
const lineShown = (page, side, text) => until(() => page.locator(`${side} .cm-line`).filter({ hasText: text }).count().then(n => n > 0));

// The reading habit is chosen through the gear menu; cycle it to the label asked for and close the menu.
const forceReading = async (page, label) => {
  await page.getByRole('button', { name: '差异设置' }).click();
  const reading = page.locator('.code-menu button').filter({ hasText: /^阅读方式/ });
  for (let at = 0; at < 3 && (await reading.innerText()) !== `阅读方式：${label}`; at += 1) await reading.click();
  await page.keyboard.press('Escape');
};

test('a git:// comparison opens a read-only diff with both sides, vim motions and ]c', { timeout: 180000 }, () => withWindow('wangcai-editor-diff', lists, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  // Both sides draw: the index holds the committed text, the worktree the change.
  await lineShown(page, `${diffHost} .cm-merge-a`, "const greet = 'hi';");
  await lineShown(page, sideB, "const greet = 'hello';");
  assert.equal(await page.locator(`${diffHost} .cm-collapsedLines`).count(), 0, 'unchanged lines are not folded');

  // The diff takes the focus and answers vim: a count walks that many lines.
  await page.locator(`${sideB} .cm-content`).focus();
  await until(() => page.evaluate((sel) => document.activeElement?.closest(sel) !== null, sideB));
  await page.keyboard.type('2j');
  await lineShown(page, sideB, 'export const answer = 42;');

  // ]c walks to the change, and the toolbar counts it.
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await page.keyboard.type(']c');
  await lineShown(page, sideB, "const greet = 'hello';");
  assert.match(await page.getByRole('button', { name: '差异设置' }).getAttribute('title'), /1 处改动/);

  // The reading toggle draws the inline view, a single editor rather than the split pair.
  await forceReading(page, '单栏');
  await until(() => page.locator(`${diffHost} > .cm-editor`).count().then(n => n > 0));
  assert.equal(await page.locator(`${diffHost} .cm-mergeView`).count(), 0, 'inline draws no split merge view');
  // gf leaves the comparison for the worktree file as a normal editable view, sharing the same address bar.
  await page.locator(`${diffHost} .cm-content`).focus();
  await page.keyboard.type('gf');
  await until(() => page.locator('.editor-diff').count().then(n => n === 0));
  assert.equal(await page.locator('.editor-path').inputValue(), file);
  // Ctrl+O walks back to the comparison, which takes the keyboard again so its motions answer.
  await page.keyboard.press('Control+o');
  await until(() => page.locator(diffHost).count().then(n => n > 0));
  await until(() => page.evaluate((sel) => document.activeElement?.closest(sel) !== null, diffHost));
  const cursorTop = () => page.locator(`${diffHost} .cm-fat-cursor.cm-cursor-primary`).boundingBox().then(box => box?.y);
  const before = await cursorTop();
  await page.keyboard.type('j');
  await until(async () => (await cursorTop()) !== before);
  assert.deepEqual(errors, []);
}));

test('a comparison shows its git url, switches buffers with C-w h/l and walks the jumps with C-o/C-i', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-nav', lists, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  await openEditorWorkspace(page);
  const uri = `git://${file}@:index~:worktree`;
  await clickFile(page, { type: 'file', machine, path: uri });
  await forceReading(page, '双栏');
  await until(() => page.locator(`${diffHost} .cm-mergeView`).count().then(n => n > 0));
  // The address bar carries the comparison's own git:// resource, not just the worktree path.
  assert.equal(await page.locator('.editor-path').inputValue(), uri);
  const focusedSide = () => page.evaluate(() => document.activeElement?.closest('.cm-merge-a') ? 'a' : document.activeElement?.closest('.cm-merge-b') ? 'b' : null);
  await page.locator(`${sideB} .cm-content`).focus();
  await until(async () => (await focusedSide()) === 'b');
  // C-w h/l hand the keyboard between the two buffers.
  await page.keyboard.press('Control+w'); await page.keyboard.press('h');
  await until(async () => (await focusedSide()) === 'a');
  await page.keyboard.press('Control+w'); await page.keyboard.press('l');
  await until(async () => (await focusedSide()) === 'b');
  // C-o/C-i walk the jumplist the switches left, across the buffers, without leaving the comparison.
  await page.keyboard.press('Control+o');
  await until(async () => (await focusedSide()) === 'a');
  assert.equal(await page.locator(diffHost).count(), 1);
  await page.keyboard.press('Control+i');
  await until(async () => (await focusedSide()) === 'b');
  // The comparison offers no search: neither a button nor C-f opens a picker over it.
  assert.equal(await page.getByRole('button', { name: '搜索' }).count(), 0);
  await page.keyboard.press('Control+f');
  assert.equal(await page.locator('.search-panel').count(), 0);
  assert.deepEqual(errors, []);
}));

test('leaving a comparison with gf and returning with C-o seats the caret where it was', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-return', lists, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  await until(() => page.locator(`${diffHost} .cm-mergeView`).count().then(n => n > 0));
  await page.locator(`${sideB} .cm-content`).focus();
  // The line of the primary cursor within a side, read off the line it sits on.
  const caretLine = (sel) => page.evaluate((s) => {
    const root = document.querySelector(s);
    const cursor = root?.querySelector('.cm-cursor-primary');
    if (!cursor) return 0;
    const y = cursor.getBoundingClientRect().top;
    const lines = [...root.querySelectorAll('.cm-content .cm-line')];
    return lines.findIndex((l) => { const b = l.getBoundingClientRect(); return y >= b.top - 1 && y <= b.bottom + 1; }) + 1;
  }, sel);
  await page.keyboard.type('2j');
  await until(async () => (await caretLine(sideB)) > 1);
  const left = await caretLine(sideB);
  // gf leaves for the worktree file; C-o returns and the caret is back on the same line, not the top.
  await page.keyboard.type('gf');
  await until(() => page.locator('.editor-diff').count().then(n => n === 0));
  await page.keyboard.press('Control+o');
  await until(() => page.locator(diffHost).count().then(n => n > 0));
  await until(async () => (await caretLine(sideB)) === left);
  assert.deepEqual(errors, []);
}));


