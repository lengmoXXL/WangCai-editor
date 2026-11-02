const { test } = require('node:test');
const assert = require('node:assert/strict');
const { statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createWorkspace, until, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, clickFile, codeView, collectErrors, drawnCloseButtons, drawnLines, editorLines, editorPanels, editorTab, forwardButton, goToPath, lists, machine, openEditorWorkspace, openOn, openWorkspaces, pathBox, refreshButton, showFile, shownPanel, storedHistory, viewMenu, waitForLine, waitForPath, workspaceTabs } = require('./editor-ui.cjs');

test('a file link opens as its text, and a path that cannot be read says so', { timeout: 180000 }, () => withWindow('wangcai-editor-open', lists, async ({ home, page, errors }) => {
  const code = join(home, 'sample.ts');
  const markdown = join(home, '说明 file.md');
  const binary = join(home, 'binary.bin');
  writeFileSync(code, 'const first = 1;\nconst second = "CODE_AS_TEXT";\n');
  writeFileSync(markdown, '# Markdown source\n');
  writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
  await openEditorWorkspace(page);
  await clickFile(page, { type: 'file', machine, path: code });
  await codeView(shownPanel(page), 'CODE_AS_TEXT').waitFor();
  assert.equal(await pathBox(shownPanel(page)).inputValue(), code);
  // A page is a file like any other here: its own text is what is drawn.
  await showFile(shownPanel(page), markdown, '# Markdown source');
  // The text is shown, never taken: a key typed into it changes nothing.
  const lines = editorLines(shownPanel(page));
  const before = await lines.innerText();
  await lines.click();
  await page.keyboard.type('SHOULD_NOT_EDIT');
  assert.equal(await lines.innerText(), before);
  await page.screenshot({ path: 'test/output/screenshots/editor-text.png' });
  await goToPath(shownPanel(page), binary);
  await alert(page).filter({ hasText: '暂不支持二进制' }).waitFor();
  await goToPath(shownPanel(page), join(home, 'missing.ts'));
  await alert(page).filter({ hasText: '路径不存在' }).waitFor();
  assert.deepEqual(errors, []);
}));

test('a file is shown again where it was left', { timeout: 120000 }, () => withWindow('wangcai-editor-position', lists, async ({ home, page, errors }) => {
  const long = join(home, 'long.ts');
  const other = join(home, 'other.ts');
  writeFileSync(long, Array.from({ length: 400 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n') + '\n');
  writeFileSync(other, 'export const other = 1;\n');
  await openOn(page, long, 'const line1 = 1;');
  // Down at the end of the file, which is where the offset is written down as the editor scrolls.
  await page.keyboard.press('G');
  await codeView(shownPanel(page), 'const line400 = 400;').waitFor();
  await goToPath(shownPanel(page), other);
  await waitForLine(page, 'export const other = 1;');
  await backButton(page).click();
  await waitForPath(shownPanel(page), long);
  // The editor comes back where it was left rather than at its top: what it draws is far into the file.
  await until(async () => (await drawnLines(page)).some((line) => /^const line3\d\d =/.test(line)));
  assert.deepEqual(errors, []);
}));

test('navigation history recovers its position and follows workspace tab ownership', { timeout: 180000 }, () => withHome('wangcai-editor-recover', { workspaces: ['terminal-agent'], tabs: ['editor'] }, async ({ home, open }) => {
  let { page, close } = await open();
  const code = join(home, 'first.ts');
  const middle = join(home, 'middle.md');
  const latest = join(home, 'latest.md');
  writeFileSync(code, 'const first = 1;\nconst recovered = true;\n');
  // A body line of its own, which is what the case waits for while it walks the history.
  writeFileSync(middle, '# Middle page\n\nmiddle-body\n');
  writeFileSync(latest, '# Latest page\n\nlatest-body\n');
  const first = { type: 'file', machine, path: code, line: 2, column: 3 };
  const second = { type: 'file', machine, path: middle };
  const third = { type: 'file', machine, path: latest };
  const errors = [];
  collectErrors(page, errors);
  // A plugin's menu entries are drawn when it registers its views, and the clicks below go to those views, so the entry
  // is waited for; the menu is closed at this point, which is why the entry is asked for as attached.
  await viewMenu(page).getByRole('button', { name: '编辑器', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await clickFile(page, first);
  await codeView(shownPanel(page), 'recovered').waitFor();
  await clickFile(page, second);
  await codeView(shownPanel(page), 'middle-body').waitFor();
  await clickFile(page, third);
  await codeView(shownPanel(page), 'latest-body').waitFor();
  await backButton(page).click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  assert.deepEqual((await storedHistory(page))[''], { entries: [first, second, third], index: 1 });
  await close();
  ({ page, close } = await open());
  collectErrors(page, errors);
  await codeView(shownPanel(page), 'middle-body').waitFor();
  assert.ok(await backButton(page).isEnabled());
  assert.ok(await forwardButton(page).isEnabled());
  await createWorkspace(page);
  const firstWorkspace = (await openWorkspaces(page))[0].id;
  await clickFile(page, second);
  await codeView(shownPanel(page), 'middle-body').waitFor();
  await goToPath(shownPanel(page), code);
  await backButton(page).click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  await createWorkspace(page);
  const secondWorkspace = (await openWorkspaces(page))[1].id;
  await clickFile(page, third);
  await codeView(shownPanel(page), 'latest-body').waitFor();
  const history = await storedHistory(page);
  assert.ok(!('' in history));
  assert.deepEqual(history[firstWorkspace], { entries: [first, second, { type: 'file', machine, path: code }], index: 1 });
  assert.deepEqual(history[secondWorkspace], { entries: [third], index: 0 });
  await close();
  ({ page, close } = await open());
  collectErrors(page, errors);
  const address = pathBox(shownPanel(page));
  await editorPanels(page).nth(1).waitFor({ state: 'attached' });
  assert.deepEqual(await storedHistory(page), history);
  const workspaces = workspaceTabs(page);
  await workspaces.first().click();
  const onlyTab = editorTab(page);
  assert.equal(await onlyTab.count(), 1);
  await onlyTab.click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  const back = backButton(page);
  const forward = forwardButton(page);
  assert.equal(await address.inputValue(), middle);
  assert.ok(await back.isEnabled());
  assert.ok(await forward.isEnabled());
  const historyPath = join(home, '.local/share/wangcai/data/editor/history.json');
  const mtimeBefore = statSync(historyPath, { bigint: true }).mtimeNs;
  await refreshButton(page).click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  await onlyTab.click();
  // Asking for the history is a read: the file it comes from is not written again for it.
  await storedHistory(page);
  assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, mtimeBefore);
  await forward.click();
  await codeView(shownPanel(page), 'recovered').waitFor();
  await back.click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  await back.click();
  await codeView(shownPanel(page), 'recovered').waitFor();
  assert.equal(await address.inputValue(), code);
  assert.ok(await back.isDisabled());
  await showFile(shownPanel(page), middle, 'middle-body');
  assert.ok(await forward.isDisabled());
  assert.deepEqual((await storedHistory(page))[firstWorkspace], {
    entries: [first, { type: 'file', machine, path: middle }], index: 1,
  });
  await workspaces.last().click();
  await onlyTab.click();
  await codeView(shownPanel(page), 'latest-body').waitFor();
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  await drawnCloseButtons(page).last().click();
  const remaining = await storedHistory(page);
  assert.ok(!(secondWorkspace in remaining));
  assert.ok(firstWorkspace in remaining);
  // The workspace that is left still has its tab, and the entry it was left on.
  await workspaces.first().click();
  await editorTab(page).click();
  await codeView(shownPanel(page), 'middle-body').waitFor();
  assert.ok(await back.isEnabled());
  assert.ok(await forward.isDisabled());
  assert.deepEqual(errors, []);
}));
