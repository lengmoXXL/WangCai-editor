import { cpp as cppLang } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html as htmlLang } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown as markdownLang, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';

// A language a file can be read as: what the text is highlighted with, and the id a language server is told it is in.
type Language = { id: string; mode: () => Extension };

// A language several extensions are read as, written once and shared by the table below.
const ts: Language = { id: 'typescript', mode: () => javascript({ typescript: true }) };
const js: Language = { id: 'javascript', mode: javascript };
const sh: Language = { id: 'shell', mode: () => StreamLanguage.define(shell) };
const md: Language = { id: 'markdown', mode: () => markdownLang({ base: markdownLanguage }) };
const html: Language = { id: 'html', mode: htmlLang };
const yaml: Language = { id: 'yaml', mode: yamlLang };
const c: Language = { id: 'c', mode: cppLang };
const cpp: Language = { id: 'cpp', mode: cppLang };

// What a file is read as, by the extension it carries or by its whole name when it has none.
const modes: Record<string, Language> = {
  ts, mts: ts, cts: ts,
  js, mjs: js, cjs: js,
  tsx: { id: 'typescriptreact', mode: () => javascript({ typescript: true, jsx: true }) },
  jsx: { id: 'javascriptreact', mode: () => javascript({ jsx: true }) },
  json: { id: 'json', mode: json }, md, markdown: md,
  html, htm: html, css: { id: 'css', mode: css },
  py: { id: 'python', mode: python }, rs: { id: 'rust', mode: rust }, java: { id: 'java', mode: java },
  c, h: c, cc: cpp, cpp, cxx: cpp, hpp: cpp, hh: cpp,
  go: { id: 'go', mode: go }, yaml, yml: yaml,
  sh, bash: sh, zsh: sh,
  '.bashrc': sh, '.zshrc': sh, '.profile': sh,
};

// The entry a path is read by: its whole name first, since a dotfile has no extension to speak of, and then its
// lower-cased extension.
const entryFor = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return modes[name] ?? modes[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
};

// The highlighting of a file, and the language id a server is told it is in: a file this plugin does not read as a
// language is shown as plain text and gets neither.
export const modeFor = (path: string): Extension => entryFor(path)?.mode() ?? [];
export const languageOf = (path: string) => entryFor(path)?.id;
