const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../../main.cjs');

test('grep keeps the matched snapshot when a file changes or disappears after rg returns', async () => {
  const handlers = new Map();
  const paths = ['same.md', 'removed.md', 'replaced.md', 'moved.md'];
  const records = paths.map(path => JSON.stringify({ type: 'match', data: {
    path: { text: path }, lines: { text: 'aaa dog here\n' }, line_number: 2, submatches: [{ start: 4, end: 7 }],
  } })).join('\n');
  const dispose = activate({
    host: { dataDirectory: __dirname },
    ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
    async connect() { return {
      disconnect() {},
      subprocess: { async exec(program, args) {
        if (program === '/bin/sh' && args[1].includes('RIPGREP_CONFIG_PATH')) throw new Error('machine disconnected');
        if (program === 'mktemp') return { code: 0, stdout: Buffer.from('/tmp/search-output\n') };
        return { code: 0, stdout: Buffer.from(args.includes('/bin/rg') ? records : '/bin\0/bin/rg\n') };
      } },
      fs: { async readFile(path) {
        if (path.endsWith('removed.md')) throw new Error('file removed');
        const line = path.endsWith('replaced.md') ? 'abc cat here' : path.endsWith('moved.md') ? 'other dog line' : 'aaa dog here';
        return Buffer.from(`first\rnext\n${line}\n`);
      } },
    }; },
  });
  try {
    for (const args of [[], ['-E', 'none'], ['-E', 'latin1']]) {
      const hits = await handlers.get('grep')({ machine: { id: 'local', name: '本机' }, path: '/work', query: 'dog', args });
      assert.deepEqual(hits, paths.map(path => ({
        path: `/work/${path}`, line: path === 'same.md' ? 3 : 2, column: 5, text: 'aaa dog here',
      })));
    }
  } finally { await dispose(); }
});
