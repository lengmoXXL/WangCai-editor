const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { activate } = require('../../main.cjs');

let LanguageServices;
before(async () => {
  const { outputFiles } = buildSync({ entryPoints: [require.resolve('../../ui/lsp.ts')], bundle: true, format: 'esm', write: false });
  ({ LanguageServices } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));
});

const advanceClock = async (t, ms) => {
  t.mock.timers.tick(ms);
  await new Promise(setImmediate);
};

test('symbol requests wait for a pending open and finish as soon as it reports no server', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reply = Promise.withResolvers();
  const file = { machine: { id: 'local' }, path: '/work/config.json', language: 'json' };
  const services = new LanguageServices({ ui: { subscribe() { return () => {}; }, request() { return reply.promise; } } }, () => [file]);
  try {
    const opening = services.open(file);
    let result;
    const symbols = services.symbols(file).then(found => { result = found; });
    await advanceClock(t, 6000);
    assert.equal(result, undefined);
    reply.resolve(null);
    await opening;
    await new Promise(setImmediate);
    assert.deepEqual(result, []);
    await symbols;
    assert.deepEqual(await services.symbols(file), []);
  } finally { services.dispose(); }
});

for (const phase of ['initialization', 'request', 'retry delay']) test(`pending queries finish on exit during ${phase}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = Promise.withResolvers(), handlers = new Map(), requests = [];
  const file = { machine: { id: 'local' }, path: '/work/file.c', language: 'c' };
  const info = { session: 'project', generation: 1, root: '/work', server: 'clangd' };
  const services = new LanguageServices({ ui: {
    subscribe(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    async request(name, data) {
      if (name === 'lsp-open') return opening.promise;
      if (name !== 'lsp-write') return;
      const message = JSON.parse(Buffer.from(data.data, 'base64').toString().split('\r\n\r\n')[1]);
      if (message.id === undefined) return;
      requests.push(message.method);
      if (phase === 'initialization' || (phase === 'request' && message.method !== 'initialize')) return;
      const result = message.method === 'initialize' ? { capabilities: { documentSymbolProvider: true, definitionProvider: true } } : [];
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      queueMicrotask(() => handlers.get('lsp-data')({ ...info, data: Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`).toString('base64') }));
    },
  } }, () => [file]);
  try {
    const starting = services.open(file);
    const answers = [];
    const queries = [services.symbols(file), services.locations(file, { line: 0, character: 0 }, 'definition')]
      .map(query => query.then(answer => answers.push(answer)));
    t.mock.timers.tick(6000);
    opening.resolve(info);
    await starting;
    await new Promise(setImmediate);
    const expected = phase === 'initialization' ? ['initialize'] : ['initialize', 'textDocument/definition', 'textDocument/documentSymbol'];
    assert.deepEqual(requests.toSorted(), expected);
    assert.deepEqual(answers, []);
    handlers.get('lsp-exit')({ ...info, code: 1 });
    await Promise.all(queries);
    assert.deepEqual(answers, [[], []]);
    await advanceClock(t, 200);
    assert.deepEqual(requests.toSorted(), expected);
  } finally { services.dispose(); }
});

test('disabled and unsupported languages skip the machine connection', async t => {
  const handlers = new Map();
  const connect = t.mock.fn();
  const dispose = activate({
    host: { config: { lsp: { python: false } }, dataDirectory: __dirname },
    ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
    connect,
  });
  try {
    const open = handlers.get('lsp-open');
    for (const [language, path] of [['python', '/work/main.py'], ['css', '/work/site.css']]) {
      assert.equal(await open({ machine: { id: 'local' }, path, language }), null);
    }
    assert.equal(connect.mock.callCount(), 0);
  } finally { await dispose(); }
});

test('restarting Python rechecks its configured executables after uninstall', async () => {
  const handlers = new Map(), available = new Set(['pyright-langserver', 'pylsp']);
  const launched = [];
  const dispose = activate({
    host: { dataDirectory: __dirname, config: {} },
    ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
    async connect() { return {
      disconnect() {}, onState(fn) { fn({ status: 'connected' }); return () => {}; },
      fs: { async stat(path) { return path === '/work/.git' ? { isDirectory: true } : null; } },
      subprocess: {
        async exec(_program, args) {
          const name = args.at(-1);
          return available.has(name) ? { code: 0, stdout: Buffer.from(`/bin\0/bin/${name}\n`) } : { code: 1 };
        },
        async spawn(program) { launched.push(program); return { id: String(launched.length) }; },
        async attach() { return { onData() {}, onExit() { return () => {}; } }; }, async close() {},
      },
    }; },
  });
  try {
    const file = { machine: { id: 'local' }, path: '/work/file.py', language: 'python' };
    const first = await handlers.get('lsp-open')(file);
    await handlers.get('lsp-close')(first);
    available.delete('pyright-langserver');
    assert.equal((await handlers.get('lsp-open')(file)).server, 'pylsp');
    assert.deepEqual(launched, ['/bin/pyright-langserver', '/bin/pylsp']);
  } finally { await dispose(); }
});

test('relative and absolute spellings of one project command share a server', async () => {
  const handlers = new Map();
  let spawned = 0;
  const dispose = activate({
    host: { dataDirectory: __dirname, config: { lsp: {
      c: { command: ['./bin/clangd', '--background-index'] }, cpp: { command: ['/project/bin/clangd', '--background-index'] },
    } } },
    ui: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } },
    async connect() { return {
      disconnect() {}, onState(fn) { fn({ status: 'connected' }); return () => {}; },
      fs: { async stat(path) { return path === '/project/.git' ? { isDirectory: true } : null; } },
      subprocess: {
        async exec(_program, args) { return { code: 0, stdout: Buffer.from(`/bin\0${args.at(-1)}\n`) }; },
        async spawn() { return { id: String(++spawned) }; },
        async attach() { return { onData() {}, onExit() { return () => {}; } }; }, async close() {},
      },
    }; },
  });
  try {
    const open = handlers.get('lsp-open');
    const [c, cpp] = await Promise.all(['c', 'cpp'].map(language =>
      open({ machine: { id: 'local' }, path: `/project/src/main.${language}`, language })));
    assert.equal(c.generation, cpp.generation);
    assert.equal(spawned, 1);
  } finally { await dispose(); }
});

test('a server whose stream is unavailable is closed before a replacement starts', async () => {
  let connected = true, nextId = 0, references = 0;
  const processes = new Set(), states = new Set(), handlers = new Map();
  let lost;
  const connection = {
    fs: { async stat() { return { isDirectory: true }; } },
    onState(listener) {
      states.add(listener);
      listener({ status: connected ? 'connected' : 'disconnected' });
      return () => states.delete(listener);
    },
    subprocess: {
      async exec() { return { code: 0, stdout: Buffer.from('/bin\0/bin/clangd\n') }; },
      async spawn() { const id = ++nextId; processes.add(id); return { id }; },
      async attach(id) {
        if (id === 1) { connected = false; throw new Error('connection lost'); }
        const exits = new Set();
        lost = () => { for (const listener of [...exits]) listener(undefined); };
        return { id, onData() {}, onExit(listener) { exits.add(listener); return () => exits.delete(listener); } };
      },
      async close(id) { processes.delete(id); },
    },
    disconnect() { references--; },
  };
  const dispose = activate({
    host: { config: {}, dataDirectory: __dirname },
    ui: { handle(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); }, publish() {} },
    async connect() { references++; return connection; },
  });
  const open = handlers.get('lsp-open');
  const file = { machine: { id: 'local' }, path: '/project/test.c', language: 'c' };
  try {
    await assert.rejects(open(file), /connection lost/);
    const replacement = open(file);
    await new Promise(setImmediate);
    assert.deepEqual([...processes], [1]);
    connected = true;
    for (const listener of states) listener({ status: 'connected' });
    await replacement;
    assert.deepEqual([...processes], [2]);
    connected = false;
    lost();
    const reconnected = open(file);
    await new Promise(setImmediate);
    assert.deepEqual([...processes], [2]);
    connected = true;
    for (const listener of states) listener({ status: 'connected' });
    await reconnected;
    assert.deepEqual([...processes], [3]);
  } finally {
    await dispose();
  }
  assert.equal(processes.size, 0);
  assert.equal(references, 0);
});

test('a process already dead at attach uses the three restart attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = new Map(), listeners = new Map();
  let spawns = 0;
  const ui = {
    handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    publish(name, data) { listeners.get(name)?.(data); },
    async request(name, data) { return handlers.get(name)(data); },
  };
  const dispose = activate({ host: { config: {}, dataDirectory: __dirname }, ui,
    async connect() { return {
      disconnect() {}, fs: { async stat() { return null; } }, subprocess: {
        async exec() { return { code: 0, stdout: Buffer.from('/bin\0/bin/clangd\n') }; },
        async spawn() { return { id: String(++spawns) }; },
        async attach() { return {
          onData(fn) { fn({ stream: 'stderr', data: Buffer.from(`startup error ${spawns}\n`) }); },
          onExit(fn) { fn(1); return () => {}; },
        }; },
      },
    }; },
  });
  const file = { machine: { id: 'local' }, path: '/work/test.c', language: 'c' };
  const services = new LanguageServices({ ui }, () => [file]);
  try {
    await services.open(file);
    assert.equal(services.status(file).state, 'closed');
    assert.equal(services.status(file).log, 'startup error 1');
    await new Promise(setImmediate);
    for (const delay of [1000, 3000, 7000]) await advanceClock(t, delay);
    assert.equal(spawns, 4);
    assert.equal(services.status(file).log, 'startup error 4');
    t.mock.timers.runAll();
    await new Promise(setImmediate);
    assert.equal(spawns, 4);
    assert.match(services.status(file).error, /已退出 \(1\)/);
  } finally { services.dispose(); await dispose(); }
});

for (const order of ['before', 'after']) test(`the old exit delivered ${order} the replacement's open reply leaves it serving both files`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlers = new Map(), listeners = new Map(), live = new Map(), writes = [];
  const started = Promise.withResolvers(), reply = Promise.withResolvers();
  const first = { machine: { id: 'local' }, path: '/work/a.c', language: 'c' };
  const second = { ...first, path: '/work/b.c' };
  let serial = 0, oldExit;
  const ui = {
    handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    publish(name, data) {
      if (name === 'lsp-exit') oldExit = data;
      else listeners.get(name)?.(data);
    },
    async request(name, data) {
      const result = await handlers.get(name)(data);
      if (name === 'lsp-open' && data.path === second.path) { started.resolve(); await reply.promise; }
      return result;
    },
  };
  const dispose = activate({ host: { config: {}, dataDirectory: __dirname }, ui,
    async connect() { return {
      disconnect() {}, onState(fn) { fn({ status: 'connected' }); return () => {}; },
      fs: { async stat() { return { isDirectory: true }; } },
      subprocess: {
        async exec() { return { code: 0, stdout: Buffer.from('/bin\0/bin/clangd\n') }; },
        async spawn() { return { id: ++serial }; },
        async close(id) { live.delete(id); },
        async attach(id) { return {
          onData() {}, onExit(fn) { live.set(id, fn); return () => {}; }, async write() { writes.push(id); },
        }; },
      },
    }; },
  });
  const services = new LanguageServices({ ui }, () => [first, second]);
  try {
    await services.open(first);
    const old = services.session(first).info;
    live.get(1)(1);
    live.delete(1);
    const opening = services.open(second);
    await started.promise;
    if (order === 'before') listeners.get('lsp-exit')(oldExit);
    reply.resolve();
    await opening;
    if (order === 'after') listeners.get('lsp-exit')(oldExit);
    listeners.get('lsp-log')({ ...old, text: 'retired server' });
    await ui.request('lsp-close', old);
    await assert.rejects(ui.request('lsp-write', { ...old, data: '' }), /已关闭/);
    await advanceClock(t, 1000);
    assert.deepEqual([...live.keys()], [2]);
    assert.deepEqual(writes, [1, 2]);
    assert.equal(services.session(first), services.session(second));
    assert.equal(services.status(second).state, 'open');
    assert.equal(services.status(second).log, undefined);
  } finally { services.dispose(); await dispose(); }
});

for (const [uptime, extraTries] of [[29_999, 0], [30_000, 3]]) test(`an exhausted server earns ${extraTries} new attempts after ${uptime} ms of uptime`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const listeners = new Map();
  const file = { machine: { id: 'local' }, path: '/work/file.c', language: 'c' };
  const info = { session: 'project', root: '/work', server: 'clangd' };
  let starts = 0;
  const services = new LanguageServices({ ui: {
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    async request(name) {
      if (name === 'lsp-open') return { ...info, generation: ++starts };
    },
  } }, () => [file]);
  const exit = () => listeners.get('lsp-exit')({ session: info.session, generation: starts, code: 1 });
  const spendTries = async () => {
    for (const delay of [1000, 3000, 7000]) {
      const previous = starts;
      exit();
      await advanceClock(t, delay - 1);
      assert.equal(starts, previous);
      await advanceClock(t, 1);
      assert.equal(starts, previous + 1);
    }
  };
  try {
    await services.open(file);
    await advanceClock(t, 30_000);
    await spendTries();
    await advanceClock(t, uptime);
    if (extraTries) await spendTries();
    exit();
    t.mock.timers.runAll();
    await new Promise(setImmediate);
    assert.equal(starts, 4 + extraTries);
    assert.equal(services.status(file).state, 'closed');
    await services.restart(file);
    assert.equal(starts, 5 + extraTries);
    assert.equal(services.status(file).state, 'open');
  } finally { services.dispose(); }
});

test('reopening a project during backoff gets its own three restart attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opens = [];
  const file = { machine: { id: 'local' }, path: '/work/first.c', language: 'c' };
  const second = { ...file, path: '/work/second.c' };
  let shown = [file];
  const services = new LanguageServices({ ui: {
    subscribe() { return () => {}; },
    async request(name, params) {
      if (name !== 'lsp-open') return;
      opens.push(params.path);
      return { session: 'project', generation: opens.length, root: '/work', server: 'clangd', exit: { code: 1 } };
    },
  } }, () => shown);
  try {
    await services.open(file);
    await advanceClock(t, 0);
    await advanceClock(t, 1000);
    await advanceClock(t, 3000);
    shown = [];
    await services.closeUnused();
    shown = [second];
    await services.open(second);
    await advanceClock(t, 0);
    for (const delay of [1000, 3000, 3000, 4000]) await advanceClock(t, delay);
    assert.deepEqual(opens, [...Array(3).fill(file.path), ...Array(4).fill('/work/second.c')]);
  } finally { services.dispose(); }
});

for (const mode of ['automatic', 'manual']) test(`${mode} restart resolves new roots for each file that shared the old server`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map(), closes = [], opens = [];
  const outer = { machine: { id: 'local' }, path: '/work/a.c', language: 'c' };
  const inner = { ...outer, path: '/work/sub/b.c' };
  const unavailable = { ...inner, path: '/work/sub/c.c' };
  const visited = { ...outer, path: '/work/sub/visited.c' };
  let shown = [visited];
  let nested = false;
  let fail = true;
  const services = new LanguageServices({ ui: {
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    async request(name, params) {
      if (name === 'lsp-close') closes.push(params.session);
      if (name === 'lsp-open') {
        opens.push(params.path);
        if (nested && fail && params.path === unavailable.path) throw new Error('nested launch failed');
        const root = nested && params.path.startsWith('/work/sub/') ? '/work/sub' : '/work';
        return { session: root, generation: !nested ? 1 : root === '/work' ? 2 : 3, root, server: 'clangd' };
      }
    },
  } }, () => shown);
  try {
    await services.open(visited);
    shown = [outer, inner, unavailable];
    await services.open(outer);
    await services.open(inner);
    await services.open(unavailable);
    opens.length = 0;
    nested = true;
    if (mode === 'manual') await services.restart(inner);
    else {
      listeners.get('lsp-exit')({ session: '/work', generation: 1, code: 1 });
      await new Promise(setImmediate);
      await advanceClock(t, 1000);
    }
    assert.equal(services.session(outer)?.info.root, '/work');
    assert.equal(services.session(inner)?.info.root, '/work/sub');
    assert.deepEqual(opens.sort(), [outer.path, inner.path, unavailable.path]);
    assert.equal(services.session(unavailable), undefined);
    if (mode === 'manual') {
      assert.equal(services.status(unavailable).error, 'nested launch failed');
      fail = false;
      await services.restart(unavailable);
      assert.deepEqual(closes, ['/work']);
    } else {
      shown = [inner, unavailable];
      await services.closeUnused();
      assert.deepEqual(closes, ['/work']);
      await advanceClock(t, 3000);
      assert.deepEqual(opens.slice(3), [unavailable.path]);
      fail = false;
      await advanceClock(t, 7000);
      assert.deepEqual(opens.slice(3), [unavailable.path, unavailable.path]);
    }
    assert.equal(services.session(unavailable)?.info.root, '/work/sub');
  } finally { services.dispose(); }
});

for (const healthy of [false, true]) test(`a replacement that exits during an outstanding retry gets ${healthy ? 'three fresh' : 'its remaining'} attempts`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const first = { machine: { id: 'local' }, path: '/work/a.c', language: 'c' };
  const second = { ...first, path: '/work/b.c' };
  const info = { session: 'project', root: '/work', server: 'clangd' };
  const pending = Promise.withResolvers(), listeners = new Map(), opens = [];
  let shown = [first];
  const services = new LanguageServices({ ui: {
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    async request(name, file) {
      if (name !== 'lsp-open') return;
      opens.push(file.path);
      if (opens.length === 2) return pending.promise;
      const process = { ...info, generation: opens.length };
      if (opens.length === 4 || (healthy && opens.length === 5)) return { ...process, exit: { code: 1 } };
      return process;
    },
  } }, () => shown);
  const exit = () => listeners.get('lsp-exit')({ session: info.session, generation: opens.length, code: 1 });
  try {
    await services.open(first);
    exit();
    await advanceClock(t, 0);
    await advanceClock(t, 1000);
    shown = [first, second];
    await services.open(second);
    if (healthy) await advanceClock(t, 31000);
    exit();
    shown = [second];
    await services.closeUnused();
    await advanceClock(t, 0);
    if (healthy) {
      await advanceClock(t, 999);
      assert.equal(opens.length, 3);
      await advanceClock(t, 1);
      assert.equal(opens.length, 4);
    }
    await advanceClock(t, 3000);
    await advanceClock(t, 7000);
    assert.deepEqual(opens, [first.path, first.path, ...Array(healthy ? 4 : 3).fill(second.path)]);
    assert.equal(services.session(second)?.info.root, '/work');
    pending.resolve({ ...info, generation: 2 });
    await advanceClock(t, 0);
    assert.equal(services.session(first), undefined);
    assert.equal(services.session(second)?.info.root, '/work');
  } finally { services.dispose(); }
});

test('an old open response cannot reclaim a file after the tab reopens it in a nested project', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = { machine: { id: 'local' }, path: '/work/sub/a.c', language: 'c' };
  const pending = Promise.withResolvers(), closes = [];
  let shown = [file], nested = false;
  const services = new LanguageServices({ ui: {
    subscribe() { return () => {}; },
    async request(name, params) {
      if (name === 'lsp-close') closes.push(params.session);
      if (name === 'lsp-open') return nested ? { session: 'inner', generation: 2, root: '/work/sub', server: 'clangd' } : pending.promise;
    },
  } }, () => shown);
  try {
    const earlier = services.open(file);
    shown = [];
    await services.closeUnused();
    shown = [file];
    nested = true;
    await services.open(file);
    pending.resolve({ session: 'outer', generation: 1, root: '/work', server: 'clangd' });
    await earlier;
    assert.equal(services.session(file)?.info.root, '/work/sub');
    assert.deepEqual(closes, ['outer']);
  } finally { services.dispose(); }
});

test('a live initialization timeout reaches status listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = { machine: { id: 'local' }, path: '/work/test.c', language: 'c' };
  const services = new LanguageServices({ ui: {
    subscribe() { return () => {}; },
    async request(name) { if (name === 'lsp-open') return { session: 'project', generation: 1, root: '/work', server: 'clangd' }; },
  } }, () => [file]);
  try {
    await services.open(file);
    let error;
    services.subscribe(() => { error = services.status(file)?.error; });
    await advanceClock(t, 10001);
    assert.match(error, /timed out/i);
  } finally { services.dispose(); }
});

test('closing the last tab retires a server whose initial open is still pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reply = Promise.withResolvers();
  const calls = [];
  const online = { machine: { id: 'local' }, path: '/online.c', language: 'c' };
  const file = { machine: { id: 'remote' }, path: '/project/a.c', language: 'c' };
  let shown = [online, file];
  const services = new LanguageServices({ ui: {
    subscribe() { return () => {}; },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'lsp-open' && params.path === '/online.c') return { session: 'online', generation: 1, root: '/', server: 'clangd' };
      if (method === 'lsp-open') return reply.promise;
    },
  } }, () => shown);
  await services.open(online);
  calls.length = 0;
  const opening = services.open(file);
  shown = [];
  await services.closeUnused();
  assert.deepEqual(calls, [['lsp-open', file], ['lsp-close', { session: 'online', generation: 1 }]]);
  reply.resolve({ session: 'project', generation: 2, server: 'clangd', root: '/project' });
  await opening;
  assert.deepEqual(calls, [['lsp-open', file], ['lsp-close', { session: 'online', generation: 1 }], ['lsp-close', { session: 'project', generation: 2 }]]);
  assert.equal(services.session(file), undefined);
  services.dispose();
});

test('closing another workspace retains a project while its replacement file is still being read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = { machine: { id: 'local' }, path: '/work/a.c', language: 'c' };
  const next = { ...first, path: '/work/b.c' };
  const other = { ...first, machine: { id: 'remote' } };
  let shown = [first, other];
  const live = new Set(), starts = [];
  const services = new LanguageServices({ ui: {
    subscribe() { return () => {}; },
    async request(name, data) {
      if (name === 'lsp-close') live.delete(data.session);
      if (name !== 'lsp-open') return;
      const session = data.machine.id;
      if (!live.has(session)) { live.add(session); starts.push(session); }
      return { session, generation: starts.indexOf(session) + 1, root: '/work', server: 'clangd' };
    },
  } }, () => shown);
  try {
    await services.open(first);
    await services.open(other);
    shown = [{ ...next, reading: true }, other];
    await services.closeUnused();
    shown = [{ ...next, reading: true }];
    await services.closeUnused();
    assert.deepEqual([...live], ['local']);
    await services.open(next);
    shown = [next];
    await services.closeUnused();
    assert.deepEqual(starts, ['local', 'remote']);
    assert.equal(services.session(next)?.info.root, '/work');
  } finally { services.dispose(); }
});
