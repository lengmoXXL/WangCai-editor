const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { activate } = require('../main.cjs');
const { lists, machine, openEditorWorkspace, showFile, shownPanel } = require('./editor-ui.cjs');

test('a write request carries the text as UTF-8 bytes, and releases connections', async () => {
  const machine = { id: 'remote', name: 'remote', host: 'example.com' };
  const handlers = new Map();
  const written = [];
  let disconnected = 0;
  const dispose = activate({
    host: { dataDirectory: __dirname },
    ui: { handle(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); } },
    async connect() {
      return {
        subprocess: { async exec() { return { code: 1 }; } },
        fs: {
          async writeFile(path, bytes) {
            if (path === '/work/refused.ts') throw new Error('Permission denied (os error 13)');
            written.push([path, Buffer.from(bytes)]);
          },
        },
        disconnect() { disconnected++; },
      };
    },
  });
  try {
    const write = handlers.get('write');
    await write({ machine, path: '/work/说明.md', text: '# 标题\nbody\n' });
    assert.deepEqual(written, [['/work/说明.md', Buffer.from('# 标题\nbody\n', 'utf8')]]);
    await assert.rejects(write({ machine, path: '/work/refused.ts', text: 'x' }), /Permission denied/);
    assert.equal(disconnected, 2);
  } finally {
    dispose();
  }
  assert.equal(handlers.size, 0);
});

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
