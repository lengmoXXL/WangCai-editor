const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../main.cjs');

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
