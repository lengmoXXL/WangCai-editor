const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../main.cjs');

const setup = () => {
  const handlers = new Map();
  const published = [];
  const dispose = activate({
    host: { dataDirectory: __dirname, config: {} },
    ui: {
      handle(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); },
      publish(topic, data) { published.push({ topic, data }); },
    },
    async connect() { throw new Error('cursor needs no machine'); },
  });
  return { handlers, published, dispose };
};

test('cursor asks the page and answers with what the visible tab replies', async () => {
  const { handlers, published, dispose } = setup();
  try {
    const asking = handlers.get('cursor')();
    assert.equal(published.length, 1);
    assert.equal(published[0].topic, 'cursor-query');
    const cursor = { type: 'file', machine: { id: 'm', name: 'm' }, path: '/r/report.md', line: 12, column: 3 };
    handlers.get('cursor-reply')({ nonce: published[0].data.nonce, cursor });
    assert.deepEqual(await asking, cursor);
  } finally {
    dispose();
  }
  assert.equal(handlers.size, 0);
});

test('cursor gives up when no tab answers', async () => {
  const { handlers, dispose } = setup();
  try {
    assert.equal(await handlers.get('cursor')(), undefined);
  } finally {
    dispose();
  }
});
