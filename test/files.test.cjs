const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { activate } = require('../main.cjs');

const { outputFiles } = buildSync({ stdin: { resolveDir: __dirname, contents: `
  export * from '../ui/files';
  export { EditorState, Transaction } from '@codemirror/state';
  export { history, undo } from '@codemirror/commands';
` }, bundle: true, format: 'esm', write: false });
let EditorState, Transaction, history, undo, fileBuffers, watch;
before(async () => {
  ({ EditorState, Transaction, history, undo, fileBuffers, watch } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));
});

const buffersWithIO = request => fileBuffers({ ui: {
  async request(method, params) { if (method !== 'watch') return request(method, params); },
  subscribe() { return () => {}; },
} });

const edit = (opened, text) => {
  opened.takeChanges();
  const state = EditorState.create({ doc: opened.buffer.text });
  opened.edit(state.update({ changes: { from: 0, to: state.doc.length, insert: text } }));
};

for (const reply of ['received', 'lost']) test(`an undo survives a write whose acknowledgement is ${reply} and the view is reopened`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers();
  const confirm = Promise.withResolvers();
  let disk = 'A';
  const writes = [];
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    assert.equal(method, 'write');
    writes.push(params.text);
    disk = params.text;
    if (writes.length === 1) { started.resolve(); await confirm.promise; }
  });
  const file = { type: 'file', machine: { id: 'local', name: 'local' }, path: '/note' };
  const loaded = Promise.withResolvers();
  const first = open(file, loaded.resolve);
  await loaded.promise;
  edit(first, 'XA');
  t.mock.timers.tick(500);
  await started.promise;
  edit(first, 'A');
  t.mock.timers.tick(500);
  const leaving = first.close();
  const { buffer: reopened, close } = open(file, () => {});
  assert.deepEqual(writes, ['XA']);
  assert.ok(reopened.dirty);
  if (reply === 'lost') confirm.reject(new Error('connection lost'));
  else confirm.resolve();
  await leaving;
  await reopened.read();
  assert.deepEqual(writes, ['XA', 'A']);
  assert.equal(reopened.text, disk);
  assert.equal(disk, 'A');
  assert.equal(reopened.dirty, false);
  await close();
});

test('edits from stale views preserve the original positions in repeated text', async () => {
  let disk = 'aaa';
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {});
  const second = open(file, () => {});
  await second.buffer.read();
  const state = EditorState.create({ doc: disk });
  first.edit(state.update({ changes: { from: 0, insert: 'a' } }));
  second.edit(state.update({ changes: { from: 2, to: 3, insert: 'B' } }));
  await first.close();
  assert.equal(disk, 'aaaB');
  await second.close();
});

test('deleting a repeated line keeps the surviving line ending', async () => {
  let disk = 'a\r\na\nb\r';
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  });
  const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, () => {});
  await opened.buffer.read();
  const state = EditorState.create({ doc: opened.buffer.text });
  opened.edit(state.update({ changes: { from: 0, to: 2 } }));
  await opened.close();
  assert.equal(disk, 'a\nb\r');
});

test('one grouped undo restores both delimiters across a peer insertion', async () => {
  const original = '\r\n\nx\rz\n';
  let disk = original;
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {}), peer = open(file, () => {});
  await first.buffer.read();
  first.takeChanges();
  let state = EditorState.create({ doc: first.buffer.text, extensions: [history(), first.history] });
  const editor = { get state() { return state; }, dispatch(tr) { state = tr.state; first.edit(tr); } };
  editor.dispatch(state.update({ changes: { from: 0, to: 1 }, userEvent: 'input.type.compose.start' }));
  peer.takeChanges();
  const other = EditorState.create({ doc: peer.buffer.text });
  peer.edit(other.update({ changes: { from: other.doc.length, insert: 'peer\n' } }));
  state = state.update({ changes: first.takeChanges(), annotations: Transaction.addToHistory.of(false) }).state;
  editor.dispatch(state.update({ changes: { from: 0, to: 1 }, userEvent: 'input.type.compose' }));
  await peer.close();
  assert.equal(disk, 'x\rz\npeer\n');
  assert.ok(undo(editor));
  await first.close();
  assert.equal(disk, original + 'peer\n');
});

test('deleting a line between CR and LF preserves the empty line on reopening', async () => {
  let disk = 'a\rx\r\n\nb';
  const request = async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  };
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = buffersWithIO(request)(file, () => {});
  await first.buffer.read();
  const state = EditorState.create({ doc: first.buffer.text });
  first.edit(state.update({ changes: { from: 2, to: 4 } }));
  await first.close();
  const reopened = buffersWithIO(request)(file, () => {});
  await reopened.buffer.read();
  assert.equal(reopened.buffer.text, 'a\n\nb');
  assert.equal(disk, 'a\r\r\nb');
  await reopened.close();
});

test('deleting either copy of a mixed-ending line survives an unrelated disk edit', async () => {
  for (const [initial, from, external, expected, neutralEdit] of [
    ['a\r\na\nb\r\nc', 0, 'a\r\na\nb\r\nC', 'a\nb\r\nC'],
    ['a\r\na\nb\r\nc', 2, 'a\r\na\nb\r\nC', 'a\r\nb\r\nC'],
    ['x\ra\r\na\nb', 2, 'X\ra\r\na\nb', 'X\ra\nb'],
    ['x\ra\r\na\nb', 2, 'X\ra\r\na\nb', 'X\ra\nb', true],
    ['x\ra\r\na', 3, 'x\rA\r\na', 'x\rA'],
    ['z\ra\na\r\nb', 4, 'Z\ra\r\nB', 'Z\rB'],
    ['a\r\na\nb\rc', 0, 'remote\na\r\na\nb\rc', 'remote\na\nb\rc'],
  ]) {
    let disk = initial;
    const open = buffersWithIO(async (method, params) => {
      if (method === 'read') return disk;
      disk = params.text;
    });
    const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, () => {});
    await opened.buffer.read();
    let state = EditorState.create({ doc: opened.buffer.text });
    if (neutralEdit) {
      const remove = state.update({ changes: { from: 0, to: 1 } });
      opened.edit(remove);
      const restore = remove.state.update({ changes: { from: 0, insert: 'x' } });
      opened.edit(restore);
      state = restore.state;
    }
    opened.edit(state.update({ changes: { from, to: from + 2 } }));
    disk = external;
    await opened.buffer.read();
    await opened.close();
    assert.equal(disk, expected);
  }
});

for (const failed of [false, true]) test(`a deleted duplicate conflicts with the same disk line ${failed ? 'after a failed write' : 'before autosave'}`, async () => {
  let disk = 'a\r\na\nb\r\n', fail = failed;
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    if (fail) throw new Error('offline');
    disk = params.text;
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  let opened = open(file, () => {});
  await opened.buffer.read();
  const state = EditorState.create({ doc: opened.buffer.text });
  opened.edit(state.update({ changes: { from: 0, to: 2 } }));
  if (failed) await opened.close();
  disk = 'A\r\na\nb\r\n';
  fail = false;
  if (failed) opened = open(file, () => {});
  await opened.buffer.read();
  await opened.close();
  assert.equal(opened.buffer.text, '<<<<<<< 编辑器\n=======\nA\n>>>>>>> 磁盘\na\nb\n');
  assert.ok(disk.endsWith('a\nb\r\n'));
});

test('a multiline paste preserves the UTF-8 BOM and merges each changed line separately', async () => {
  for (const [insert, external, expected] of [
    ['X\nY', 'B\r\nC', 'X\r\nY\r\nC'],
    ['X\nY\nZ', 'B\r\nC', 'X\r\nY\nZ\r\nC'],
    ['X', 'B\r\nC', 'X\r\nC'],
    ['X\nY\nZ', 'B\r\nD', 'X\r\nY\nZ\r\nD'],
    ['X', 'B\r\nD', 'X\r\nD'],
    ['X\nY\nZ', 'B\r\nD\nE', 'X\r\nY\nZ\r\nD\nE'],
    ['X\nY', 'D\nC', 'X\r\n<<<<<<< 编辑器\nY\n=======\nD\n>>>>>>> 磁盘\nC'],
  ]) {
    let bytes = Buffer.from('\uFEFFA\r\nB\nC');
    const handlers = new Map();
    const dispose = activate({
      host: { dataDirectory: __dirname },
      ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
      async connect() { return { disconnect() {}, subprocess: { async exec() { return { code: 1 }; } }, fs: {
        async readFile() { return bytes; }, async writeFile(_path, data) { bytes = Buffer.from(data); },
      } }; },
    });
    try {
      const open = buffersWithIO((name, data) => handlers.get(name)(data));
      const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, () => {});
      await opened.buffer.read();
      assert.equal(opened.buffer.text, 'A\nB\nC');
      const state = EditorState.create({ doc: opened.buffer.text });
      opened.edit(state.update({ changes: { from: 0, to: 3, insert } }));
      bytes = Buffer.from(`\uFEFFA\r\n${external}`);
      await opened.close();
      assert.deepEqual(bytes, Buffer.from(`\uFEFF${expected}`));
    } finally { await dispose(); }
  }
});

test('an active file leaves room in the cache for fifty idle files', async () => {
  const open = buffersWithIO(async (_name, file) => file.path);
  const attach = (i) => open({ type: 'file', machine: { id: 'local' }, path: `/${i}` }, () => {});
  for (let i = 0; i < 50; i++) await attach(i).close();
  const active = attach(49);
  await attach(50).close();
  const oldest = attach(0);
  assert.equal(oldest.buffer.text, '/0');
  await oldest.close();
  await active.close();
});

test('disk changes retain the physical identity of each repeated line', async () => {
  const first = 'a\r\na\nb\rc';
  for (const [edits, diskEdit, expected] of [
    [[{ from: 0, to: 2 }], 'a\r\nb\rc', 'b\rc'],
    [[{ from: 2, to: 4 }], 'a\nb\rc', 'b\rc'],
    [[{ from: 0, to: 2 }, { from: 0, to: 1, insert: 'B' }], 'a\r\nD\nb\rc', '<<<<<<< 编辑器\nB\n=======\nD\n>>>>>>> 磁盘\nb\rc'],
    [[{ from: 0, to: 2 }, { from: 0, to: 1 }, { from: 0, insert: 'a' }], 'a\r\nA\nb\rc', 'A\nb\rc'],
    [[{ from: 0, to: 2 }, { from: 4, to: 5, insert: 'X' }], 'a\r\na\nb\rC', 'a\nb\r<<<<<<< 编辑器\r\nX\r\n=======\r\nC\r\n>>>>>>> 磁盘'],
  ]) {
    let disk = first;
    const open = buffersWithIO(async (method, params) => {
      if (method === 'read') return disk;
      disk = params.text;
    });
    const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, () => {});
    await opened.buffer.read();
    let state = EditorState.create({ doc: opened.buffer.text });
    for (const changes of edits) {
      const tr = state.update({ changes });
      opened.edit(tr);
      state = tr.state;
    }
    disk = diskEdit;
    await opened.buffer.read();
    await opened.close();
    assert.equal(disk, expected);
  }
});

for (const [scenario, original, saved, external, undone] of [
  ['the surviving duplicate', 'a\r\nx\na\rb', 'a\r\na\rb', 'a\r\nb', 'a\r\nx\nb'],
  ['an empty line between CR and LF', 'a\rx\r\n\nb', 'a\r\r\nb', 'a\r\r\nB', 'a\rx\r\n\nB'],
]) test(`undo restores the bytes of ${scenario} after a clean reread`, async () => {
  let disk = original;
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {});
  await first.buffer.read();
  let state = EditorState.create({ doc: first.buffer.text, extensions: [history(), first.history] });
  const editor = { get state() { return state; }, dispatch(tr) { state = tr.state; first.edit(tr); } };
  editor.dispatch(state.update({ changes: { from: 2, to: 4 } }));
  await open(file, () => {}).close();
  assert.equal(disk, saved);
  disk = external;
  await first.buffer.read();
  state = state.update({ changes: first.takeChanges(), annotations: Transaction.addToHistory.of(false) }).state;
  assert.ok(undo(editor));
  await first.close();
  assert.equal(disk, undone);
});

test('an unsaved separator-only undo survives successive disk changes', async () => {
  let disk = 'a\r\na\nb\rc';
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    disk = params.text;
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {});
  await first.buffer.read();
  let state = EditorState.create({ doc: first.buffer.text, extensions: [history(), first.history] });
  const editor = { get state() { return state; }, dispatch(tr) { state = tr.state; first.edit(tr); } };
  editor.dispatch(state.update({ changes: { from: 0, to: 2 }, userEvent: 'input.type.compose.start' }));
  editor.dispatch(state.update({ changes: { from: 0, insert: 'a\n' }, userEvent: 'input.type.compose' }));
  await open(file, () => {}).close();
  assert.equal(disk, 'a\na\nb\rc');
  assert.ok(undo(editor));
  disk = disk.replace('b', 'B');
  await first.buffer.read();
  disk = disk.replace('c', 'C');
  await first.buffer.read();
  await first.close();
  assert.equal(disk, 'a\r\na\nB\rC');
});

for (const [scenario, original, from, committed, external, expected] of [
  ['committed with mixed endings', 'a\r\na\nb\rc', 2, true, 'a\r\nb\rX', 'a\r\nb\rX'],
  ['committed with identical endings', 'a\na\nb\nc', 0, true, 'a\nb\nX', 'a\nb\nX'],
  ['committed before the neighboring row changes', 'x\ra\r\na\nb', 2, true, 'x\raX\nb', 'x\raX\nb'],
  ['uncommitted before the neighboring row changes', 'x\ra\r\na\nb', 2, false, 'x\ra\r\naX\nb', 'x\raX\nb'],
  ['uncommitted while disk deletes the other copy', 'a\r\na\nb\rc', 0, false, 'a\r\nb\rc', 'b\rc'],
]) test(`a retry preserves both edits when a deletion is ${scenario}`, async () => {
  let disk = original, lost = true;
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    if (committed || !lost) disk = params.text;
    if (lost) throw new Error('lost acknowledgement');
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {});
  await first.buffer.read();
  const state = EditorState.create({ doc: first.buffer.text });
  first.edit(state.update({ changes: { from, to: from + 2 } }));
  await first.close();
  disk = external;
  lost = false;
  const reopened = open(file, () => {});
  await reopened.buffer.read();
  await reopened.close();
  assert.equal(disk, expected);
});

test('a reread agreeing with the latest edit needs no write after an earlier failure', async () => {
  let disk = 'A';
  const writes = [];
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return disk;
    writes.push(params.text);
    throw new Error('write failed');
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/note' };
  const first = open(file, () => {});
  await first.buffer.read();
  edit(first, 'X');
  await first.close();
  const next = open(file, () => {});
  edit(next, 'B');
  disk = 'B';
  await next.close();
  assert.deepEqual(writes, ['X']);
  assert.equal(next.buffer.text, 'B');
  assert.equal(next.buffer.dirty, false);
});

test('a failed close keeps the edits until a later open can save them', async () => {
  const disk = new Map();
  let readable = true, writable = false;
  const open = buffersWithIO(async (method, { path, text }) => {
    if (method === 'read') {
      if (!readable) throw new Error('offline');
      return disk.get(path) ?? 'first\nmiddle\nlast';
    }
    assert.equal(method, 'write');
    if (!writable) throw new Error('read-only');
    disk.set(path, text);
  });
  const file = { type: 'file', machine: { id: 'local', name: 'local' }, path: '/note' };
  const loaded = Promise.withResolvers();
  const first = open(file, loaded.resolve);
  await loaded.promise;
  edit(first, 'first\nmiddle\nunsaved');
  await first.close();
  assert.ok(first.buffer.dirty);

  const other = { ...file, path: '/open-in-another-tab' };
  const oldTab = open(other, () => {});
  const leaving = oldTab.close();
  const newTab = open(other, () => {});
  await leaving;
  for (let i = 0; i < 55; i++) await open({ ...file, path: `/recent-${i}` }, () => {}).close();
  const concurrent = open(other, () => {});
  assert.equal(concurrent.buffer, newTab.buffer);
  await Promise.all([newTab.close(), concurrent.close()]);

  writable = true;
  readable = false;
  disk.set(file.path, 'external\nmiddle\nlast');
  const offline = open(file, () => {});
  await offline.close();
  assert.equal(offline.buffer.readError, 'offline');
  assert.equal(disk.get(file.path), 'external\nmiddle\nlast');

  readable = true;
  const reopened = open(file, () => {});
  assert.equal(reopened.buffer.text, 'first\nmiddle\nunsaved');
  await reopened.buffer.read();
  assert.equal(disk.get(file.path), 'external\nmiddle\nunsaved');
  assert.equal(reopened.buffer.dirty, false);
  await reopened.close();
});

for (const [trigger, failed] of [['autosave', false], ['close', false], ['autosave', true], ['close', true]]) test(`${trigger} merges unseen disk changes${failed ? ' after a failed refresh' : ''}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let disk = 'first\nlast', offline = false;
  const open = buffersWithIO(async (method, params) => {
    if (offline) throw new Error('offline');
    if (method === 'read') return disk;
    disk = params.text;
  });
  const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, () => {});
  await opened.buffer.read();
  if (failed) {
    offline = true;
    await opened.buffer.read();
    assert.equal(opened.buffer.readError, 'offline');
  }
  const state = EditorState.create({ doc: opened.buffer.text });
  opened.edit(state.update({ changes: { from: 0, to: 5, insert: 'LOCAL' } }));
  disk = 'first\nDISK';
  offline = false;
  if (trigger === 'close') await opened.close();
  else {
    t.mock.timers.tick(500);
    await new Promise(setImmediate);
  }
  assert.equal(disk, 'LOCAL\nDISK');
  assert.equal(opened.buffer.dirty, false);
  if (trigger === 'autosave') await opened.close();
});

test('a read merges CRLF edits and a queued save waits for the latest keystroke', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingRead = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const writes = [];
  let delayRead = false;
  const open = buffersWithIO(async (method, params) => {
    if (method === 'read') return delayRead ? pendingRead.promise : 'a\r\nb\r\nc\r\n';
    writes.push(params.text);
    saved.resolve();
  });
  const loaded = Promise.withResolvers();
  const opened = open({ type: 'file', machine: { id: 'local' }, path: '/note' }, loaded.resolve);
  const { buffer, close } = opened;
  await loaded.promise;
  edit(opened, 'X\nb\nc\n');
  edit(opened, 'a\nb\nc\n');
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.deepEqual(writes, []);
  assert.equal(buffer.dirty, false);

  delayRead = true;
  const read = buffer.read();
  edit(opened, 'A\nb\nc\n');
  t.mock.timers.tick(550);
  edit(opened, 'AA\nb\nc\n');
  pendingRead.resolve('a\r\nb\r\nC\r\n');
  await read;
  assert.equal(buffer.text, 'AA\nb\nC\n');
  t.mock.timers.tick(499);
  await new Promise(setImmediate);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  await saved.promise;
  assert.deepEqual(writes, ['AA\r\nb\r\nC\r\n']);
  await close();
});

for (const trigger of ['autosave', 'close']) test(`${trigger} recreates a removed dirty file only after confirming its absence`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = { type: 'file', machine: { id: 'local' }, path: '/work/note' };
  const handlers = new Map(), writes = [];
  let disk = '\uFEFFA\r\nB', readable = true;
  const dispose = activate({
    host: { config: {}, dataDirectory: __dirname },
    ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
    async connect() { return { disconnect() {}, subprocess: { async exec() { return { code: 1 }; } }, fs: {
      async readFile() { if (disk === null || !readable) throw new Error('cannot read'); return Buffer.from(disk); },
      async stat() { return disk === null ? null : { isDirectory: false }; },
      async writeFile(_path, bytes) { disk = Buffer.from(bytes).toString(); writes.push(disk); },
    } }; },
  });
  try {
    const open = buffersWithIO((name, data) => handlers.get(name)(data));
    let view = open(file, () => {});
    await view.buffer.read();
    edit(view, 'X\nB');
    readable = false;
    t.mock.timers.tick(500);
    await new Promise(setImmediate);
    assert.equal(view.buffer.readError, 'cannot read');
    assert.deepEqual(writes, []);
    edit(view, 'X\nY');
    disk = null;
    if (trigger === 'autosave') { t.mock.timers.tick(500); await new Promise(setImmediate); }
    else await view.close();
    assert.deepEqual(writes, ['\uFEFFX\r\nY']);
    assert.equal(view.buffer.dirty, false);
    assert.equal(view.buffer.readError, '');
    if (trigger === 'close') view = open(file, () => {});
    disk = null;
    await view.buffer.read();
    assert.equal(view.buffer.readError, 'cannot read');
    await view.close();
    assert.equal(disk, null);
  } finally { await dispose(); }
});

for (const initial of ['before', null]) test(`a watch installed after reading a ${initial === null ? 'missing' : 'present'} file picks up intervening edits`, async () => {
  const ready = Promise.withResolvers();
  let disk = initial, reads = 0, watches = 0;
  const open = fileBuffers({ ui: {
    subscribe() { return () => {}; },
    async request(method, params) {
      if (method === 'watch' && params.active) { watches++; await ready.promise; }
      if (method === 'read') { reads++; return disk ?? { missing: 'not found' }; }
    },
  } });
  const file = { type: 'file', machine: { id: 'local' }, path: '/work/note' };
  const loaded = Promise.withResolvers(), updated = Promise.withResolvers();
  const view = open(file, () => {
    if (view.buffer.text === 'before' || view.buffer.readError === 'not found') loaded.resolve();
    if (view.buffer.text === 'during registration') updated.resolve();
  });
  await loaded.promise;
  assert.equal(reads, 1);
  disk = 'during registration';
  ready.resolve();
  await updated.promise;
  assert.equal(reads, 2);
  assert.equal(watches, 1);
  await view.close();
});

test('two editors and a diff share one file watch and read once per change', async () => {
  const handlers = new Map(), listeners = new Set(), requests = [];
  let disk = 'first', reads = 0, watches = 0, stops = 0, changed;
  const ui = {
    handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    subscribe(_name, fn) { listeners.add(fn); return () => listeners.delete(fn); },
    publish(_name, data) { for (const fn of listeners) fn(data); },
    request(name, data) { const result = handlers.get(name)(data); requests.push(result); return result; },
  };
  const dispose = activate({ host: { config: {}, dataDirectory: __dirname }, ui,
    async connect() { return { disconnect() {}, subprocess: { async exec() { return { code: 1 }; } }, fs: {
      async stat() { return { isDirectory: true }; },
      async watch(path, _options, callback) {
        assert.ok(path === '/' || path === '/work');
        watches++;
        if (path === '/work') changed = callback;
        return () => { stops++; };
      },
      async readFile() { reads++; return Buffer.from(disk); },
    } }; },
  });
  const file = { type: 'file', machine: { id: 'local' }, path: '/work/note' };
  const open = fileBuffers({ ui });
  const first = open(file, () => {}), second = open(file, () => {});
  let diffs = 0;
  const diff = watch({ ui }, file.machine, [file.path], () => { diffs++; });
  let peerChanges = 0;
  const peer = watch({ ui }, file.machine, ['/work/other'], () => { peerChanges++; });
  try {
    await second.buffer.read();
    await Promise.all(requests);
    await new Promise(setImmediate);
    const before = reads;
    assert.equal(diffs, 1);
    changed({ created: ['/work/other'], modified: [], removed: [] });
    await new Promise(setImmediate);
    assert.equal(peerChanges, 2);
    assert.equal(reads, before);
    disk = 'second';
    changed({ created: [file.path], modified: [], removed: [file.path] });
    await new Promise(setImmediate);
    assert.equal(watches, 2);
    assert.equal(reads, before + 1);
    assert.equal(diffs, 2);
    assert.equal(first.buffer.text, disk);
    await first.close();
    disk = 'third';
    changed({ created: [], modified: [file.path], removed: [] });
    await new Promise(setImmediate);
    assert.equal(second.buffer.text, disk);
    assert.equal(reads, before + 2);
    await second.close();
    assert.equal(stops, 0);
    changed({ created: [], modified: [file.path], removed: [] });
    await new Promise(setImmediate);
    assert.equal(diffs, 4);
    assert.equal(reads, before + 2);
  } finally {
    peer.close();
    diff.close();
    await Promise.all(requests);
    await dispose();
  }
  assert.equal(stops, 2);
});

for (const blocked of ['/homes', '/homes/me/project']) test(`external edits arrive when ${blocked} rejects a directory watch`, async () => {
  const handlers = new Map(), subscriptions = new Map(), listeners = new Set();
  let disk = 'initial';
  const ui = {
    handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    request(name, params) { return handlers.get(name)(params); },
    subscribe(_name, fn) { listeners.add(fn); return () => listeners.delete(fn); },
    publish(_name, event) { for (const fn of listeners) fn(event); },
  };
  const file = { type: 'file', machine: { id: 'local' }, path: '/homes/me/project/note' };
  const dispose = activate({ host: { config: {}, dataDirectory: __dirname }, ui,
    async connect() { return { disconnect() {}, subprocess: { async exec() { return { code: 1 }; } }, fs: {
      async readFile() { return Buffer.from(disk); },
      async stat(path) { return { isDirectory: path !== file.path }; },
      async watch(path, _options, callback) {
        if (path === blocked) throw new Error('Permission denied');
        subscriptions.set(path, callback);
        return () => subscriptions.delete(path);
      },
    } }; },
  });
  const view = fileBuffers({ ui })(file, () => {});
  try {
    await view.buffer.read();
    await new Promise(setImmediate);
    assert.equal(view.buffer.text, 'initial');
    const source = blocked === '/homes' ? '/homes/me/project' : file.path;
    for (const text of ['replacement', 'next edit']) {
      disk = text;
      assert.equal(typeof subscriptions.get(source), 'function', source);
      subscriptions.get(source)({ created: [], modified: [file.path], removed: [] });
      await new Promise(setImmediate);
      assert.equal(view.buffer.text, disk);
    }
  } finally { await view.close(); await dispose(); }
  assert.equal(subscriptions.size, 0);
});

test('a comparison observes a newly watched path while its other watch is unavailable', async () => {
  const ready = Promise.withResolvers();
  const requests = [];
  let leftMissing = true, disk = 'before', snapshot;
  const ui = {
    subscribe() { return () => {}; },
    async request(_name, { path, active }) {
      if (!active) return;
      requests.push(path);
      if (path === '/left' && leftMissing) throw new Error('missing');
      if (path === '/right') await ready.promise;
    },
  };
  const watched = watch({ ui }, { id: 'local' }, ['/left', '/right'], () => { snapshot = disk; });
  try {
    disk = 'written before the right watch connected';
    ready.resolve();
    await new Promise(setImmediate);
    assert.equal(snapshot, disk);
    leftMissing = false;
    disk = 'left restored';
    watched.retry();
    await new Promise(setImmediate);
    assert.equal(snapshot, disk);
    assert.deepEqual(requests, ['/left', '/right', '/left']);
  } finally { watched.close(); }
});

test('a change reaches only watchers of the same path on the same machine', async () => {
  const commands = new Map(), subscriptions = new Set(), watchers = new Map();
  const dispose = activate({
    host: { config: {}, dataDirectory: __dirname },
    ui: {
      handle(method, handler) { commands.set(method, handler); return () => commands.delete(method); },
      publish(topic, data) { if (topic === 'changed') for (const act of subscriptions) act(data); },
    },
    async connect(machine) { return {
      subprocess: { async exec() { return { code: 1 }; } },
      fs: { async watch(_path, _options, changed) { watchers.set(machine.host, changed); return () => watchers.delete(machine.host); } },
      disconnect() {},
    }; },
  });
  const requests = [];
  const ui = {
    request(method, params) {
      const result = commands.get(method)(params);
      requests.push(result);
      return result;
    },
    subscribe(topic, act) {
      assert.equal(topic, 'changed');
      subscriptions.add(act);
      return () => subscriptions.delete(act);
    },
  };
  const notified = [];
  const watched = ['one', 'two'].map(host => watch({ ui }, { id: 'remote', name: host, host }, ['/note'], () => notified.push(host)));
  try {
    await Promise.all(requests);
    await new Promise(setImmediate);
    assert.deepEqual(notified.slice().sort(), ['one', 'two']);
    notified.length = 0;
    const event = { created: [], modified: ['/note'], removed: [] };
    watchers.get('one')(event);
    await new Promise(setImmediate);
    assert.deepEqual(notified, ['one']);
    watchers.get('two')(event);
    await new Promise(setImmediate);
    assert.deepEqual(notified, ['one', 'two']);
  } finally {
    for (const subscription of watched) subscription.close();
    await Promise.all(requests);
    await dispose();
  }
});
