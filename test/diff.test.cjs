const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { backButton, lists, machine, openEditorWorkspace, clickFile } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');

// A repository with one file committed and then changed in the worktree, so an unstaged comparison has two sides.
const repoWithChange = (home, before = "const greet = 'hi';\nexport const answer = 41;\n", after = "const greet = 'hello';\nexport const answer = 42;\n") => {
  const repo = join(home, 'repo ');
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, HOME: home };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@local');
  const file = join(repo, 'app?.ts');
  writeFileSync(file, before);
  git('add', '.'); git('commit', '-qm', 'initial');
  writeFileSync(file, after);
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
  await page.getByRole('menu', { name: '差异设置' }).waitFor({ state: 'hidden' });
};

test('a git:// comparison opens a read-only diff with both sides, vim motions and ]c', { timeout: 180000 }, () => withWindow('wangcai-editor-diff', { ...lists, tabs: lists.tabs.map(id => id === 'editor' ? { id, config: { fontSizes: { typescript: 15 } } } : id) }, async ({ home, page, errors }) => {
  const file = repoWithChange(home, "const stable = 0;\nconst greet = 'hi';\nexport const answer = 41;\n", "const stable = 0;\nconst greet = 'hello';\nexport const answer = 42;\n");
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  // Both sides draw: the index holds the committed text, the worktree the change.
  await lineShown(page, `${diffHost} .cm-merge-a`, "const greet = 'hi';");
  await lineShown(page, sideB, "const greet = 'hello';");
  assert.equal(await page.locator(`${sideB} .cm-content`).evaluate(el => getComputedStyle(el).fontSize), '15px');
  assert.equal(await page.locator(`${diffHost} .cm-collapsedLines`).count(), 0, 'unchanged lines are not folded');

  // The diff takes the focus and answers vim: a count walks that many lines.
  await page.locator(`${sideB} .cm-content`).focus();
  await until(() => page.evaluate((sel) => document.activeElement?.closest(sel) !== null, sideB));
  const active = page.locator(`${sideB} .cm-activeLine`);
  await active.filter({ hasText: 'const stable = 0;' }).waitFor();
  await page.keyboard.type('2j');
  await active.filter({ hasText: 'export const answer = 42;' }).waitFor();

  // ]c walks to the change, and the toolbar counts it.
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await active.filter({ hasText: 'const stable = 0;' }).waitFor();
  await page.keyboard.type(']c');
  await active.filter({ hasText: "const greet = 'hello';" }).waitFor();
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

test('identical CR-delimited files stay unchanged when switching diff layouts', { timeout: 120000 }, () => withWindow('wangcai-editor-diff-cr', lists, async ({ home, page, errors }) => {
  const content = 'first\rmiddle\rlast';
  const file = repoWithChange(home, content, content);
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@HEAD~:worktree` });
  await forceReading(page, '双栏');
  await lineShown(page, sideB, 'middle');
  assert.deepEqual(await page.locator(`${sideB} .cm-line`).allTextContents(), ['first', 'middle', 'last']);
  await forceReading(page, '单栏');
  const inline = page.locator(`${diffHost} > .cm-editor`);
  await inline.waitFor();
  assert.deepEqual(await inline.locator('.cm-line').allTextContents(), ['first', 'middle', 'last']);
  assert.equal(await inline.locator('.cm-changedLine, .cm-deletedChunk').count(), 0);
  await page.getByRole('button', { name: '差异设置' }).click();
  await page.keyboard.type('jj');
  assert.match(await page.locator('.code-menu :focus').innerText(), /打开文件/);
  assert.deepEqual(errors, []);
}));

test('a historical comparison finds its repository after the parent directory is deleted', { timeout: 120000 }, () => withWindow('wangcai-editor-diff-deleted-dir', lists, async ({ home, page, errors }) => {
  const repo = dirname(repoWithChange(home));
  const directory = join(repo, 'old', 'nested'), file = join(directory, 'gone.md');
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, 'historical note\n');
  execFileSync('git', ['-C', repo, 'add', '--', 'old']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'historical note']);
  rmSync(join(repo, 'old'), { recursive: true });
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@HEAD~:empty` });
  await forceReading(page, '双栏');
  await lineShown(page, `${diffHost} .cm-merge-a`, 'historical note');
  assert.deepEqual(errors, []);
}));

test('a directory replaced by a large file can be loaded from the index or a revision', () => withWindow('wangcai-editor-diff-large-blob', lists, async ({ home, page }) => {
  const repo = dirname(repoWithChange(home));
  const path = join(repo, 'replaced');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  mkdirSync(path);
  writeFileSync(join(path, 'child'), 'old');
  git('add', 'replaced'); git('commit', '-qm', 'directory');
  rmSync(path, { recursive: true });
  const size = 9 * 1024 * 1024;
  writeFileSync(path, 'a'.repeat(size - 4) + 'last');
  git('add', '-A', 'replaced');
  await openEditorWorkspace(page);
  const request = { machine, path, base: 'HEAD', head: ':index' };
  const read = (query) => page.evaluate(async query => {
    const diff = await window.wangcai.call('request', 'editor', 'diff', query);
    return [diff.oldText, diff.newText.length, diff.newText.slice(-4), diff.tooLarge];
  }, query);
  assert.deepEqual(await read(request), ['', 0, '', size]);
  assert.deepEqual(await read({ ...request, force: true }), ['', size, 'last', undefined]);
  git('commit', '-qm', 'replace with file');
  assert.deepEqual(await read({ ...request, base: 'HEAD^', head: 'HEAD', force: true }), ['', size, 'last', undefined]);
  const alias = join(home, 'checkout-link');
  symlinkSync(repo, alias);
  const worktreeSize = 17 * 1024 * 1024;
  writeFileSync(path, 'b'.repeat(worktreeSize - 4) + 'tail');
  const worktree = { machine, path: join(alias, 'replaced'), base: ':empty', head: ':worktree' };
  assert.deepEqual(await read(worktree), ['', 0, '', worktreeSize]);
  assert.deepEqual(await read({ ...worktree, force: true }), ['', worktreeSize, 'tail', undefined]);
}));

test('worktree comparisons show link targets and submodule revisions', () => withWindow('wangcai-editor-diff-entries', lists, async ({ home, page, errors }) => {
  const repo = dirname(repoWithChange(home));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Demo', '-c', 'user.email=demo@local', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  await openEditorWorkspace(page);
  const diff = path => page.evaluate(query => window.wangcai.call('request', 'editor', 'diff', query), { machine, path, base: ':index', head: ':worktree' });
  const link = join(repo, 'linked');
  symlinkSync('app?.ts', link);
  git(repo, 'add', 'linked');
  assert.deepEqual(await diff(link), { oldText: 'app?.ts', newText: 'app?.ts' });
  unlinkSync(link);
  symlinkSync('missing\n', link);
  assert.deepEqual(await diff(link), { oldText: 'app?.ts', newText: 'missing\n' });

  const old = join(repo, 'old'), renamed = join(repo, 'renamed');
  mkdirSync(old);
  writeFileSync(join(old, 'note'), 'original entry');
  git(repo, 'add', 'old');
  git(repo, 'commit', '-qm', 'directory before replacement');
  renameSync(old, renamed);
  symlinkSync(renamed, old);
  const historical = (base = 'HEAD') => page.evaluate(query => window.wangcai.call('request', 'editor', 'diff', query),
    { machine, path: join(old, 'note'), base, head: ':empty' });
  assert.deepEqual(await historical(), { oldText: 'original entry', newText: '' });
  git(renamed, 'init', '-q');
  writeFileSync(join(renamed, 'note'), 'other repository');
  git(renamed, 'add', 'note');
  git(renamed, 'commit', '-qm', 'other history');
  assert.deepEqual(await historical(), { oldText: 'original entry', newText: '' });
  unlinkSync(old);
  renameSync(renamed, old);
  assert.deepEqual(await historical(git(repo, 'rev-parse', 'HEAD')), { oldText: 'original entry', newText: '' });
  assert.deepEqual(await historical(git(old, 'rev-parse', 'HEAD')), { oldText: 'other repository', newText: '' });

  const sub = join(repo, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q');
  writeFileSync(join(sub, 'note'), 'first');
  git(sub, 'add', 'note');
  git(sub, 'commit', '-qm', 'first');
  git(repo, 'add', 'sub');
  const oldText = `Subproject commit ${git(sub, 'rev-parse', 'HEAD')}\n`;
  writeFileSync(join(sub, 'note'), 'second');
  git(sub, 'commit', '-qam', 'second');
  git(sub, 'tag', 'v2');
  const hash = git(sub, 'rev-parse', 'HEAD');
  assert.deepEqual(await diff(sub), { oldText, newText: `Subproject commit ${hash}\n` });
  writeFileSync(join(sub, 'untracked'), 'new');
  assert.deepEqual(await diff(sub), { oldText, newText: `Subproject commit ${hash}-dirty\n` });
  unlinkSync(join(sub, 'untracked'));
  writeFileSync(join(sub, 'note'), 'third');
  assert.deepEqual(await diff(sub), { oldText, newText: `Subproject commit ${hash}-dirty\n` });
  renameSync(join(sub, '.git'), join(home, 'sub.git'));
  assert.deepEqual(await diff(sub), { oldText, newText: oldText });
  assert.deepEqual(errors, []);
}));

test('a staged comparison inside nested checkouts uses the repository holding the change', () => withWindow('wangcai-editor-nested-index', lists, async ({ home, page }) => {
  const outer = dirname(repoWithChange(home)), inner = join(outer, 'nested');
  const file = join(inner, 'a'), innerOnly = join(inner, 'b');
  const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Demo', '-c', 'user.email=demo@local', ...args]);
  mkdirSync(inner);
  writeFileSync(file, 'outer HEAD');
  git(outer, 'add', 'nested/a');
  git(outer, 'commit', '-qm', 'outer file');
  writeFileSync(file, 'outer index');
  git(outer, 'add', 'nested/a');
  git(inner, 'init', '-q');
  writeFileSync(innerOnly, 'inner HEAD');
  git(inner, 'add', 'b');
  git(inner, 'commit', '-qm', 'inner file');
  writeFileSync(innerOnly, 'inner index');
  git(inner, 'add', 'b');
  await openEditorWorkspace(page);
  const staged = (path, oldPath) => page.evaluate(query => window.wangcai.call('request', 'editor', 'diff', query),
    { machine, path, oldPath, base: 'HEAD', head: ':index' });
  assert.deepEqual(await staged(file), { oldText: 'outer HEAD', newText: 'outer index' });
  assert.deepEqual(await staged(innerOnly), { oldText: 'inner HEAD', newText: 'inner index' });
  git(inner, 'add', 'a');
  git(inner, 'commit', '-qm', 'also track a');
  assert.deepEqual(await staged(file), { oldText: 'outer HEAD', newText: 'outer index' });
  writeFileSync(file, 'inner staged a');
  git(inner, 'add', 'a');
  assert.deepEqual(await staged(file), { oldText: 'outer index', newText: 'inner staged a' });
  const worktree = await page.evaluate(query => window.wangcai.call('request', 'editor', 'diff', query),
    { machine, path: file, base: ':index', head: ':worktree' });
  assert.deepEqual(worktree, { oldText: 'outer index', newText: 'inner staged a' });
  writeFileSync(file, 'outer index');
  const moved = join(outer, 'moved');
  git(outer, 'mv', 'nested/a', 'moved');
  assert.deepEqual(await staged(moved, file), { oldText: 'outer HEAD', newText: 'outer index' });
}));

test('a renamed worktree base is watched and opened at its old path', { timeout: 120000 }, () => withWindow('wangcai-editor-diff-renamed', { ...lists, tabs: lists.tabs.map(id => id === 'editor' ? { id, config: { fontSizes: { markdown: 17, typescript: 14 } } } : id) }, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  const old = join(home, 'repo ', 'old?.md');
  writeFileSync(old, 'old worktree\n');
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:worktree~HEAD?old=${old}` });
  await forceReading(page, '双栏');
  const sideA = `${diffHost} .cm-merge-a`;
  await lineShown(page, sideA, 'old worktree');
  assert.equal(await page.locator(`${sideA} .cm-content`).evaluate(el => getComputedStyle(el).fontSize), '17px');
  assert.equal(await page.locator(`${sideB} .cm-content`).evaluate(el => getComputedStyle(el).fontSize), '14px');
  writeFileSync(old, 'updated base\n');
  await lineShown(page, sideA, 'updated base');
  await page.evaluate(() => {
    window.previews = [];
    window.wangcai.subscribe('preview:open', file => window.previews.push(file.path));
  });
  await page.getByRole('button', { name: '预览', exact: true }).click();
  for (const key of ['Control+Space', 'g', 'p']) await page.keyboard.press(key);
  await until(async () => (await page.evaluate(() => window.previews.length)) === 2);
  assert.deepEqual(await page.evaluate(() => window.previews), [old, old]);

  await clickFile(page, { type: 'file', machine, path: `git://${file}@:worktree~:worktree?old=${old}` });
  await lineShown(page, sideB, "const greet = 'hello';");
  writeFileSync(old, 'updated old path\n');
  await lineShown(page, sideA, 'updated old path');
  writeFileSync(file, 'updated new path\n');
  await lineShown(page, sideB, 'updated new path');
  assert.deepEqual(errors, []);
}));

test('a comparison shows its git url, switches buffers with C-w h/l and walks the jumps with C-o/C-i', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-nav', lists, async ({ home, page, errors }) => {
  const file = repoWithChange(home);
  await openEditorWorkspace(page);
  const uri = `git://${file}@:index~:worktree`;
  await clickFile(page, { type: 'file', machine, path: uri });
  await forceReading(page, '单栏');
  await page.locator(`${diffHost} > .cm-editor .cm-content`).focus();
  await page.keyboard.press('Control+w'); await page.keyboard.press('h');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(await backButton(page).isDisabled());
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
  const sideA = `${diffHost} .cm-merge-a`;
  await page.locator(`${sideA} .cm-line`).filter({ hasText: "const greet = 'hi';" }).click();
  await until(() => page.evaluate(sel => !!document.activeElement?.closest(sel), sideA));
  await page.keyboard.type('2G');
  const left = page.locator(`${sideA} .cm-activeLine`).filter({ hasText: 'answer = 41' });
  await left.waitFor();
  await page.keyboard.type('gf');
  await page.locator('.editor-code .cm-activeLine').filter({ hasText: 'answer = 42' }).waitFor();
  await page.keyboard.press('Control+o');
  await left.waitFor();
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:empty` });
  await lineShown(page, sideA, "const greet = 'hi';");
  await page.getByRole('button', { name: '差异设置' }).click();
  assert.ok(await page.getByRole('button', { name: '打开文件（gf）' }).isDisabled());
  await page.keyboard.press('Escape');
  await page.locator(`${sideA} .cm-content`).focus();
  await page.keyboard.type('gf');
  assert.equal(await page.locator(diffHost).count(), 1);
  assert.deepEqual(errors, []);
}));

test('a vertical move with the caret scrolled off screen steps one line rather than leaping into view', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-offscreen', lists, async ({ home, page, errors }) => {
  const lines = Array.from({ length: 300 }, (_, at) => `const line${at} = ${at};`);
  lines[150] = 'const CHANGED_OLD = 1;';
  const before = lines.join('\n') + '\n';
  lines[150] = 'const CHANGED_NEW = 2;';
  const file = repoWithChange(home, before, lines.join('\n') + '\n');

  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  await until(() => page.locator(`${diffHost} .cm-mergeView`).count().then(n => n > 0));
  await page.locator(`${sideB} .cm-content`).focus();
  await until(() => page.evaluate((sel) => document.activeElement?.closest(sel) !== null, sideB));

  const activeText = () => page.evaluate((sel) => document.querySelector(`${sel} .cm-activeLine`)?.textContent.trim() ?? '', sideB);
  await page.keyboard.type('gg');
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.querySelector('.editor-diff .cm-mergeView').scrollTop = 2000; });
  await page.waitForTimeout(300);
  const relY = await page.evaluate((sel) => {
    const sc = document.querySelector('.editor-diff .cm-mergeView');
    const c = document.querySelector(`${sel} .cm-cursor-primary`);
    return c ? c.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
  }, sideB);
  assert.ok(relY !== null && relY < 0, 'the caret must be scrolled out of view before the step');
  await page.keyboard.type('j');
  await until(async () => (await activeText()) === 'const line1 = 1;');
  assert.deepEqual(errors, []);
}));

test('a worktree refresh keeps the scroll where the reader left it, not at the caret', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-refresh', lists, async ({ home, page, errors }) => {
  const lines = Array.from({ length: 300 }, (_, at) => `const line${at} = ${at};`);
  lines[150] = 'const OLD = 1;';
  const oldText = lines.join('\n') + '\n';
  lines[150] = 'const NEW = 2;';
  const file = repoWithChange(home, oldText, lines.join('\n') + '\n');

  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  await until(() => page.locator(`${diffHost} .cm-mergeView`).count().then(n => n > 0));
  await page.locator(`${sideB} .cm-content`).focus();
  await page.keyboard.type('gg');
  await page.waitForTimeout(200);
  const scroller = '.editor-diff .cm-mergeView';
  await page.evaluate((s) => { document.querySelector(s).scrollTop = 2000; }, scroller);
  await page.waitForTimeout(300);
  const before = await page.evaluate((s) => document.querySelector(s).scrollTop, scroller);
  assert.ok(before > 1000, 'the reader scrolled away from the caret');
  await page.keyboard.press('Control+w'); await page.keyboard.press('l');
  const afterKey = await page.locator(scroller).evaluate(el => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.scrollTop)))));
  assert.ok(Math.abs(afterKey - before) <= 1);
  const address = page.getByRole('textbox', { name: '路径', exact: true });
  await address.focus();

  // A second change on disk refreshes the comparison; the scroll stays where the reader left it.
  lines[200] = 'const EXTERNAL = 9;';
  writeFileSync(file, lines.join('\n') + '\n');
  await until(() => page.getByRole('button', { name: '差异设置' }).getAttribute('title').then(t => /2 处改动/.test(t ?? '')));
  const after = await page.evaluate((s) => document.querySelector(s).scrollTop, scroller);
  assert.ok(Math.abs(after - before) < 50, `the refresh yanked the scroll: ${before} -> ${after}`);
  assert.ok(await address.evaluate(el => el === document.activeElement));
  const box = await page.locator(scroller).boundingBox();
  await page.mouse.click(box.x + 100, box.y + 30);
  await until(() => page.evaluate(() => !!document.activeElement?.closest('.cm-merge-a')));
  const clicked = await page.locator(scroller).evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return el.scrollTop;
  });
  assert.ok(Math.abs(clicked - after) < 50, `switching panes moved the scroll from ${after} to ${clicked}`);
  assert.deepEqual(errors, []);
}));

test('a large comparison marks only changed lines, not one crude block', { timeout: 180000 }, () => withWindow('wangcai-editor-diff-large', lists, async ({ home, page, errors }) => {
  const lines = Array.from({ length: 1000 }, (_, at) => `const line${at} = ${at};`);
  const before = lines.join('\n') + '\n';
  for (let at = 100; at <= 900; at += 1) if (at !== 500) lines[at] += 'X';
  const file = repoWithChange(home, before, lines.join('\n') + '\n');

  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: `git://${file}@:index~:worktree` });
  await forceReading(page, '双栏');
  await until(() => page.locator(`${diffHost} .cm-mergeView`).count().then(n => n > 0));
  // Scroll into the changed region: the one unchanged line there must not be painted as changed.
  await page.evaluate(() => { document.querySelector('.editor-diff .cm-mergeView').scrollTop = 9800; });
  await lineShown(page, sideB, 'const line500 = 500;');
  const marked = await page.evaluate((sel) => {
    const line = [...document.querySelectorAll(`${sel} .cm-line`)].find(l => l.textContent.includes('const line500 = 500;'));
    return line ? line.className.includes('cm-changedLine') : null;
  }, sideB);
  assert.equal(marked, false, 'an unchanged line in the changed region must not be marked changed');
  assert.deepEqual(errors, []);
}));


