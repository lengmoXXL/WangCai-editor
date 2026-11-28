const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { lists, machine, openEditorWorkspace, showFile, shownPanel } = require('./editor-ui.cjs');

test('autosave follows a chain of links and preserves the links when recreating their target', () => withWindow('wangcai-editor-save-link', lists, async ({ home, page, errors }) => {
  const target = join(home, 'target\n'), inner = join(home, 'inner'), link = join(home, 'note.txt');
  writeFileSync(target, 'first');
  symlinkSync('target\n', inner);
  symlinkSync(inner, link);
  await openEditorWorkspace(page);
  await showFile(shownPanel(page), link, 'first');
  await page.keyboard.press('i');
  await page.keyboard.type('edit ');
  await until(() => readFileSync(target, 'utf8') === 'edit first');
  assert.equal(readlinkSync(link), inner);
  assert.equal(readlinkSync(inner), 'target\n');
  unlinkSync(target);
  await page.evaluate(data => window.wangcai.call('request', 'editor', 'write', data), { machine, path: link, text: 'again' });
  assert.equal(readFileSync(target, 'utf8'), 'again');
  assert.equal(readlinkSync(inner), 'target\n');
  assert.deepEqual(errors, []);
}));
