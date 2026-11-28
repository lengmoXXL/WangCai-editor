const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, symlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { lspDot, noServerReason, openEditorWorkspace, showFile, shownPanel } = require('./editor-ui.cjs');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { openRust, serverFor, unexpected } = require('./lsp-fixtures.cjs');

test('a relative server command is found in its own project root from a nested file', () => withWindow('wangcai-editor-relative-server',
  serverFor('rust', ['./language-server', join(__dirname, 'symbols-server.cjs'), '[]']), async ({ home, page, errors }) => {
    const withServer = join(home, 'with-server'), withoutServer = join(home, 'without-server');
    const body = 'fn main() {}';
    for (const root of [withServer, withoutServer]) {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '');
      writeFileSync(join(root, 'src', 'main.rs'), body);
    }
    symlinkSync(process.execPath, join(withServer, 'language-server'));
    await openEditorWorkspace(page);
    await showFile(shownPanel(page), join(withServer, 'src', 'main.rs'), body);
    await lspDot(shownPanel(page), 'open').waitFor();
    await showFile(shownPanel(page), join(withoutServer, 'src', 'main.rs'), body);
    assert.match(await noServerReason(page), /未找到/);
    assert.deepEqual(unexpected(errors), []);
  }));

const lateProgram = 'wangcai-late-server';

test('a server installed after the window looked for it is found by the next try', { timeout: 180000 }, () => withWindow('wangcai-editor-installed-later', serverFor('rust', [lateProgram]), async ({ home, page, errors }) => {
  await openRust(home, page);
  // The dot names the language rather than a binary it never found, and says what it tried.
  const reason = await noServerReason(page);
  assert.ok(reason.includes('未找到'), reason);
  // The install a reader makes while the window runs, as the stub server of the other cases.
  const installed = join(home, '.local/bin', lateProgram);
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(installed, `#!/bin/sh\nexec '${process.execPath}' '${join(__dirname, 'symbols-server.cjs')}' '[]'\n`);
  chmodSync(installed, 0o755);
  // The dot of a file with no server behind it starts one again, and this try finds the program that was not there.
  await lspDot(shownPanel(page), 'missing').click();
  await lspDot(shownPanel(page), 'open').waitFor({ timeout: 30000 });
  assert.deepEqual(unexpected(errors), []);
}));
