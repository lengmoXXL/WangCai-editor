const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { editorPlugin, lists, lspDot, shownPanel, showWritten } = require('./editor-ui.cjs');

// The compiler options a server is asked about, strict enough to report a type error: every TypeScript project here is
// written with them.
const tsconfig = '{"compilerOptions":{"strict":true}}\n';

// A TypeScript project shown with its server up: the compiler options are written out and `main.ts` holds `source`, a
// case being free to write files of its own around it; `text` is what that case knows the page says. The path of that file
// is handed back, since a case that writes to it or jumps to it would otherwise spell it again.
const openTs = async (home, page, source, text) => {
  const main = join(home, 'main.ts');
  writeFileSync(join(home, 'tsconfig.json'), tsconfig);
  await showWritten(page, main, source, text);
  await lspDot(shownPanel(page), 'open').waitFor({ timeout: 60000 });
  return main;
};

// A rust project of one file, written and shown.
const openRust = async (home, page) => {
  const main = join(home, 'main.rs');
  await showWritten(page, main, 'fn main() {}\n', 'fn main');
};

// The processes whose command line holds this text: ps is read once and cut here, so every probe cuts the same way.
const pids = (text) => execFileSync('sh', ['-c', 'ps -Ao pid,command'], { encoding: 'utf8' })
  .split('\n').filter((line) => line.includes(text))
  .map((line) => line.trim().split(' ')[0]);

// The language servers running in this test's fixture: another test's window starts its own, with its own home.
const languageServers = (home) => pids('bin/typescript-language-server --stdio')
  .filter((pid) => execFileSync('sh', ['-c', `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null || true`], { encoding: 'utf8' }).includes(`n${home}`));

// A server that dies leaves a handshake nobody answers, which the client reports as a request that timed out: that is the
// failure these cases are about, and it is not a page's own error.
const unexpected = (errors) => errors.filter((text) => !text.includes('Request timed out'));

// A window whose server for one language is the command given: the rest of its plugin list is the one every case runs.
const serverFor = (language, command) => ({ ...lists, tabs: lists.tabs.map((tab) => (tab === editorPlugin ? { id: tab, config: { lsp: { [language]: { command } } } } : tab)) });

// A server that counts its own starts in a file of its own, and `lives` says which start is the one that stays past the
// window that gives a server its tries back: every other start dies at once.
const countingServer = (name, lives) => {
  const file = join(tmpdir(), `wangcai-${name}-${process.pid}-${Date.now()}`);
  return { file, server: serverFor('rust', ['/bin/sh', '-c', `n=$(($(cat '${file}' 2>/dev/null || echo 0)+1)); echo $n > '${file}'; [ ${lives} ] && sleep 40; exit 1`]) };
};

// How many times the server of a case has started, as its own command counts them in that file.
const starts = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

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

module.exports = { openTs, openRust, pids, languageServers, unexpected, serverFor, countingServer, starts, treeNames, areaNameAt, flatNames, treeBody, flatBody, treeServer, flatServer };
