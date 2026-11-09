const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lspDot, noServerReason, shownPanel } = require('./editor-ui.cjs');
const { openRust, serverFor, unexpected } = require('./lsp-fixtures.cjs');

// The program this case installs after the window has already looked for it, in the directory a login shell puts first:
// what the window remembers about a program it did not find is what the second try has to ask again.
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