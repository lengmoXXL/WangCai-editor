const { execFileSync, spawnSync } = require('node:child_process');
const { statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { wangcaiApp } = require('@lengmoxxl/wangcai-testkit');
const { editorPlugin, lists, lspDot, shownPanel, showWritten } = require('./editor-ui.cjs');

const openTs = async (home, page, source, text) => {
  const main = join(home, 'main.ts');
  writeFileSync(join(home, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  await showWritten(page, main, source, text);
  await lspDot(shownPanel(page), 'open').waitFor({ timeout: 60000 });
  return main;
};

const openRust = (home, page) => showWritten(page, join(home, 'main.rs'), 'fn main() {}\n', 'fn main');

const languageServers = (home) => {
  const processes = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  const pids = processes.split('\n').filter(line => line.includes('bin/typescript-language-server --stdio'))
    .map(line => line.trimStart().split(/\s+/, 1)[0]);
  if (!pids.length) return [];
  const cwd = spawnSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-t', home], { encoding: 'utf8' });
  if (cwd.error) throw cwd.error;
  if (cwd.status !== 0 && (cwd.status !== 1 || cwd.stderr)) throw new Error(cwd.stderr || `lsof exited with ${cwd.signal || cwd.status}`);
  return cwd.stdout.trim().split(/\s+/).filter(Boolean);
};

const nodeServer = (env, ...args) => execFileSync(join(wangcaiApp(), 'wangcaicli/dist/debug/wangcai'), ['server', ...args], { env, encoding: 'utf8' });

// A server that dies leaves a handshake nobody answers, which the client reports as a request that timed out: that is the
// failure these cases are about, and it is not a page's own error.
const unexpected = (errors) => errors.filter((text) => !text.includes('Request timed out'));

const serverFor = (language, command) => ({ ...lists, tabs: lists.tabs.map((tab) => (tab === editorPlugin ? { id: tab, config: { lsp: { [language]: { command } } } } : tab)) });

const starts = (home) => statSync(join(home, 'lsp-starts')).size;

const treeNames = {
  space: 'Space',
  shape: 'Shape',
  sides: 'sides',
  field: 'field',
  area: 'area',
  day: 'Day',
  red: 'Red',
  point: 'Point',
  size: 'size',
  inner: 'Inner',
  spec: 'spec',
  read: 'read',
  helper: 'helper',
  local: 'Local',
  answer: 'answer',
  value: 'value',
  module: 'mod',
  run: 'run',
};

const between = (line, character, endLine, endCharacter) => ({ start: { line, character }, end: { line: endLine, character: endCharacter } });

// Distinct from the declaration's start so the test catches jumps to range instead of selectionRange.
const areaNameAt = { line: 4, character: 12 };

const treeSymbols = [
  {
    name: treeNames.space, kind: 3, range: between(0, 0, 25, 0), selectionRange: between(0, 10, 0, 15),
    children: [
      {
        name: treeNames.shape, kind: 5, range: between(1, 2, 5, 2), selectionRange: between(1, 8, 1, 13),
        children: [
          { name: treeNames.sides, kind: 7, range: between(2, 4, 2, 20), selectionRange: between(2, 4, 2, 9) },
          { name: treeNames.field, kind: 7, range: between(2, 24, 2, 40), selectionRange: between(2, 24, 2, 29) },
          { name: treeNames.area, kind: 6, range: between(areaNameAt.line - 1, 4, areaNameAt.line, 40), selectionRange: between(areaNameAt.line, areaNameAt.character, areaNameAt.line, areaNameAt.character + treeNames.area.length) },
        ],
      },
      {
        name: treeNames.day, kind: 10, range: between(6, 2, 8, 2), selectionRange: between(6, 7, 6, 10),
        children: [
          { name: treeNames.red, kind: 22, range: between(7, 4, 7, 7), selectionRange: between(7, 4, 7, 7) },
        ],
      },
      {
        name: treeNames.point, kind: 5, range: between(9, 2, 11, 2), selectionRange: between(9, 8, 9, 13),
        children: [
          { name: treeNames.size, kind: 7, range: between(10, 4, 10, 15), selectionRange: between(10, 4, 10, 8) },
        ],
      },
      { name: treeNames.inner, kind: 5, range: between(12, 2, 12, 20), selectionRange: between(12, 8, 12, 13) },
      {
        name: treeNames.spec, kind: 11, range: between(17, 2, 19, 2), selectionRange: between(17, 12, 17, 16),
        children: [
          { name: treeNames.read, kind: 6, range: between(18, 4, 18, 24), selectionRange: between(18, 4, 18, 8) },
        ],
      },
      {
        name: treeNames.helper, kind: 12, range: between(20, 2, 23, 2), selectionRange: between(20, 11, 20, 17),
        children: [
          { name: treeNames.local, kind: 5, range: between(21, 4, 21, 20), selectionRange: between(21, 10, 21, 15) },
        ],
      },
      {
        name: treeNames.answer, kind: 14, range: between(24, 2, 24, 40), selectionRange: between(24, 8, 24, 14),
        children: [
          { name: treeNames.value, kind: 6, range: between(24, 20, 24, 32), selectionRange: between(24, 20, 24, 25) },
        ],
      },
    ],
  },
  {
    name: treeNames.module, kind: 2, range: between(26, 0, 30, 0), selectionRange: between(26, 7, 26, 10),
    children: [
      { name: treeNames.run, kind: 12, range: between(27, 2, 27, 30), selectionRange: between(27, 11, 27, 14) },
    ],
  },
];

const flatNames = { inner: 'Inner', area: 'Area', alone: 'Alone', stand: 'stand' };

// The constructor shares its class's name, so name lookup alone cannot identify its parent.
const flatSymbols = [
  { name: flatNames.inner, kind: 5, location: { range: between(1, 0, 6, 0) } },
  { name: flatNames.inner, kind: 9, containerName: flatNames.inner, location: { range: between(2, 2, 2, 20) } },
  { name: flatNames.area, kind: 6, containerName: flatNames.inner, location: { range: between(3, 2, 5, 2) } },
  { name: flatNames.alone, kind: 5, location: { range: between(8, 0, 12, 0) } },
  { name: flatNames.stand, kind: 6, containerName: flatNames.alone, location: { range: between(9, 2, 11, 2) } },
];

// Synthetic text for cursor assertions: the stub supplies symbols without parsing this document.
const placedText = (entries) => {
  const everyEntry = (list) => list.flatMap((entry) => [entry, ...everyEntry(entry.children ?? [])]);
  const places = everyEntry(entries).map((entry) => {
    const declarationRange = entry.location?.range ?? entry.range;
    return {
      start: (entry.selectionRange ?? declarationRange).start,
      text: entry.kind === 9 ? 'constructor' : entry.name,
      end: declarationRange.end,
    };
  });
  const lines = Math.max(...places.map((place) => place.end.line)) + 1;
  const characters = Math.max(...places.map((place) => place.end.character)) + 1;
  const grid = Array.from({ length: lines }, () => Array.from({ length: characters }, () => '.'));
  places.forEach(({ start, text }) => {
    [...text].forEach((glyph, offset) => { grid[start.line][start.character + offset] = glyph; });
  });
  return `${grid.map((row) => row.join('')).join('\n')}\n`;
};

const treeBody = placedText(treeSymbols);
const flatBody = placedText(flatSymbols);

const symbolsServer = (symbols) => serverFor('typescript', ['node', join(__dirname, 'symbols-server.cjs'), JSON.stringify(symbols)]);
const treeServer = symbolsServer(treeSymbols);
const flatServer = symbolsServer(flatSymbols);

const serverSaid = 'Indexing done';
const messageServer = serverFor('typescript', ['node', join(__dirname, 'message-server.cjs'), serverSaid]);

module.exports = { openTs, openRust, nodeServer, languageServers, unexpected, serverFor, starts, treeNames, areaNameAt, flatNames, treeBody, flatBody, treeServer, flatServer, serverSaid, messageServer };
