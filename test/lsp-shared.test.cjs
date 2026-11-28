const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { alert, closeWorkspace, diagnostics, drawnLines, editorPlugin, lists, lspDot, openEditorWorkspace, search, showFile, shownPanel, showWritten, waitForPath, workspaceTabs } = require('./editor-ui.cjs');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { starts } = require('./lsp-fixtures.cjs');

const command = [process.execPath, join(__dirname, 'opens-server.cjs')];
const shared = { ...lists, tabs: lists.tabs.map((tab) => (tab === editorPlugin ? { id: tab, config: { lsp: { c: { command }, cpp: { command } } } } : tab)) };

test('two languages share one server and both workspaces show its diagnostics for the same file', { timeout: 90000 }, () => withWindow('wangcai-editor-lsp-shared', shared, async ({ home, page, errors }) => {
  await showWritten(page, join(home, 'main.cc'), 'int main() { return 0; }\n', 'int main');
  // Each file is waited for by the name its own server says, so the count below is read after both have been read.
  await alert(page).filter({ hasText: 'main.cc' }).waitFor({ timeout: 60000 });
  const header = join(home, 'main.h');
  writeFileSync(header, 'int first;\nint answer;\nint answer;');
  await showFile(shownPanel(page), header, 'int answer');
  await alert(page).filter({ hasText: 'main.h' }).waitFor({ timeout: 60000 });
  await diagnostics(shownPanel(page)).first().waitFor();
  // Open the second view before CodeMirror's 500 ms document sync.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.keyboard.type('jdd');
  assert.deepEqual(await drawnLines(page), ['int first;', 'int answer;']);
  await openEditorWorkspace(page);
  await showFile(shownPanel(page), header, 'int answer');
  const mark = diagnostics(shownPanel(page)).first();
  assert.deepEqual(await mark.evaluate(el => [el.textContent, el.closest('.cm-line').textContent]), ['int', 'int answer;']);
  await page.clock.resume();
  assert.equal(starts(home), 1);
  const activeFile = join(home, 'visible.h');
  writeFileSync(activeFile, 'int visible;');
  await showFile(shownPanel(page), activeFile, 'int visible');
  await shownPanel(page).getByRole('alert').filter({ hasText: 'visible.h' }).waitFor();
  const project = join(home, 'other-project'), preview = join(project, 'preview.c');
  mkdirSync(project);
  writeFileSync(join(project, '.clangd'), '');
  writeFileSync(preview, 'int preview;');
  await search(page, 'preview.c');
  await waitForPath(shownPanel(page), preview);
  await alert(page).filter({ hasText: 'preview.c' }).waitFor();
  assert.equal(starts(home), 2);
  await closeWorkspace(workspaceTabs(page).first());
  await until(async () => (await workspaceTabs(page).count()) === 1);
  await waitForPath(shownPanel(page), preview);
  await lspDot(shownPanel(page), 'open').waitFor();
  await diagnostics(shownPanel(page)).first().waitFor();
  assert.deepEqual(errors, []);
}));
