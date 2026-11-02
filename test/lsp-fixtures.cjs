const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { lists, lspDot, openOn, shownPanel } = require('./editor-ui.cjs');

// The compiler options a server is asked about, strict enough to report a type error: every TypeScript project here is
// written with them.
const tsconfig = '{"compilerOptions":{"strict":true}}\n';

// A TypeScript project shown with its server up: the compiler options are written out and `main.ts` holds `source`, a
// case being free to write files of its own around it; `text` is what that case knows the page says. The path of that file
// is handed back, since a case that writes to it or jumps to it would otherwise spell it again.
const openTs = async (home, page, source, text) => {
  const main = join(home, 'main.ts');
  writeFileSync(join(home, 'tsconfig.json'), tsconfig);
  writeFileSync(main, source);
  await openOn(page, main, text);
  await lspDot(shownPanel(page), 'open').waitFor({ timeout: 60000 });
  return main;
};

// A rust project of one file, written and shown.
const openRust = async (home, page) => {
  const main = join(home, 'main.rs');
  writeFileSync(main, 'fn main() {}\n');
  await openOn(page, main, 'fn main');
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

// A window whose rust server is the command given: the rest of its plugin list is the one every case runs.
const rustServer = (command) => ({ ...lists, tabs: [{ id: 'editor', config: { lsp: { rust: { command } } } }, 'terminal'] });

// A server that counts its own starts in a file of its own, and `lives` says which start is the one that stays past the
// window that gives a server its tries back: every other start dies at once.
const countingServer = (name, lives) => {
  const file = join(tmpdir(), `wangcai-${name}-${process.pid}-${Date.now()}`);
  return { file, server: rustServer(['/bin/sh', '-c', `n=$(($(cat '${file}' 2>/dev/null || echo 0)+1)); echo $n > '${file}'; [ ${lives} ] && sleep 40; exit 1`]) };
};
// How many times the server of a case has started, as its own command counts them in that file.
const starts = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0);

module.exports = { openTs, openRust, pids, languageServers, unexpected, rustServer, countingServer, starts };
