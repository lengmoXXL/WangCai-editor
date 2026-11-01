const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { boxOf, codeView, goToPath, lists, openEditorWorkspace, shownPanel } = require('./editor-ui.cjs');

test('the gutter marks git changes the way VS Code does', { timeout: 180000 }, () => withWindow('wangcai-git', lists, async ({ home, page, errors }) => {
  const git = (...args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });
  // One repository holding a file that is changed after the commit and one that is left alone, so the gutter is read
  // both for what it draws and for what it does not.
  writeFileSync(join(home, 'clean.txt'), 'none\n');
  writeFileSync(join(home, 'kept.txt'), Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n') + '\n');
  git('init', '-q');
  // The window keeps its own profile in the same home and writes to it the whole time, so git is told to skip it.
  writeFileSync(join(home, '.git/info/exclude'), 'electron/\n');
  git('add', '-A');
  // A commit is the only call that reads an identity.
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first');
  writeFileSync(join(home, 'kept.txt'), 'line1\nline2 changed\nline3\nline4\ninserted\nline5\nline6\nline7\nline9\nline10\n');
  await openEditorWorkspace(page);
  await goToPath(page, join(home, 'kept.txt'));
  const modified = page.locator('.git-line-modified');
  const added = page.locator('.git-line-added');
  const removed = page.locator('.git-line-deleted');
  await modified.waitFor();
  assert.deepEqual([await added.count(), await modified.count(), await removed.count()], [1, 1, 1]);
  // A click on a mark opens that block: the same three changes, diffed in a peek of their own.
  const markBox = await boxOf(modified.first());
  await page.mouse.click(markBox.x + 3, markBox.y + markBox.height / 2);
  const peek = page.getByRole('dialog', { name: '行变更' });
  await peek.waitFor();
  assert.match(await peek.innerText(), /已修改 · 第 2 行/);
  // The editor draws a space as a non-breaking one, so the block is matched by shape rather than by exact bytes.
  await until(async () => /line2\schanged/.test(await peek.innerText()));
  await page.keyboard.press('Escape');
  await peek.waitFor({ state: 'hidden' });
  // Staging the file empties the diff it held, so the gutter clears without the file being opened again.
  git('add', 'kept.txt');
  await until(async () => (await modified.count()) === 0);
  assert.deepEqual([await added.count(), await removed.count()], [0, 0]);
  // A file with no mark of its own is one the repository never mentioned.
  await goToPath(page, join(home, 'clean.txt'));
  await codeView(shownPanel(page), 'none').waitFor();
  assert.deepEqual([await added.count(), await modified.count(), await removed.count()], [0, 0, 0]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test/output/screenshots/git-gutter.png' });
}));
