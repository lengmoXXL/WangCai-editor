import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';

const ts = () => javascript({ typescript: true });
const js = javascript;
const sh = () => StreamLanguage.define(shell);

// What a file is read as, by the extension it carries or by its whole name when it has none: everything else is shown as
// plain text.
const modes: Record<string, () => Extension> = {
  ts, mts: ts, cts: ts,
  js, mjs: js, cjs: js,
  tsx: () => javascript({ typescript: true, jsx: true }), jsx: () => javascript({ jsx: true }),
  json, md: markdown, markdown, html, htm: html, css, py: python, rs: rust,
  c: cpp, h: cpp, cc: cpp, cpp, cxx: cpp, hpp: cpp, hh: cpp,
  go, yaml, yml: yaml,
  sh, bash: sh, zsh: sh,
  '.bashrc': sh, '.zshrc': sh, '.profile': sh,
};

export function modeFor(path: string): Extension {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const mode = modes[name] ?? modes[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
  return mode ? mode() : [];
}
