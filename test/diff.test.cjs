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

test('a git:// comparison opens a read-only diff with both sides, vim motions and ]c', { timeout: 180000 }, () => withWindow('wangcai-editor-diff', lists, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  const readingButton = page.getByRole('button', { name: /^阅读方式/ });
  const forceReading = async (label) => {
    for (let at = 0; at < 3; at += 1) {
      if (await readingButton.getAttribute('aria-label') === `阅读方式 ${label}`) return;
      await readingButton.click();
    }
  };
  await forceReading('双栏');
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
  assert.match(await page.locator('.editor-diff-count').innerText(), /1 处改动/);

  // The reading toggle draws the inline view, a single editor rather than the split pair.
  await forceReading('单栏');
  await until(() => page.locator(`${diffHost} > .cm-editor`).count().then(n => n > 0));
  assert.equal(await page.locator(`${diffHost} .cm-mergeView`).count(), 0, 'inline draws no split merge view');
  assert.deepEqual(errors, []);
}));
