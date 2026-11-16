const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { alert, editorPlugin, lists, showFile, shownPanel, showWritten } = require('./editor-ui.cjs');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { starts } = require('./lsp-fixtures.cjs');

// A server named for both C and C++: a project's source and its header are two languages, and a server that keeps one
// index per project serves nothing in a second process of itself.
const counted = join(tmpdir(), `wangcai-shared-${process.pid}-${Date.now()}`);
const command = [process.execPath, join(__dirname, 'opens-server.cjs'), counted];
const shared = { ...lists, tabs: lists.tabs.map((tab) => (tab === editorPlugin ? { id: tab, config: { lsp: { c: { command }, cpp: { command } } } } : tab)) };

test('two languages that run the same program share one server', { timeout: 90000 }, () => withWindow('wangcai-editor-lsp-shared', shared, async ({ home, page, errors }) => {
  await showWritten(page, join(home, 'main.cc'), 'int main() { return 0; }\n', 'int main');
  // Each file is waited for by the name its own server says, so the count below is read after both have been read.
  await alert(page).filter({ hasText: 'main.cc' }).waitFor({ timeout: 60000 });
  const header = join(home, 'main.h');
  writeFileSync(header, 'int answer;\n');
  await showFile(shownPanel(page), header, 'int answer');
  await alert(page).filter({ hasText: 'main.h' }).waitFor({ timeout: 60000 });
  assert.equal(starts(counted), 1);
  assert.deepEqual(errors, []);
}));