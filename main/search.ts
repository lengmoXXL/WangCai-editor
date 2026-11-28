import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs } from 'node:util';
import { TextDecoder } from '@kayahr/text-encoding';
import type { Machine, MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import type { SearchHit } from '../shared';
import { locate, withCommandOutput, type machineAccess } from './machines';

type SearchDirectory = { machine: Machine; path: string; args?: string[] };
type RgEvent = { type: string; data: {
  path?: { text?: string }; lines?: { text?: string }; line_number: number; submatches: { start: number }[];
} };

// An option's argument can itself look like a switch or the end of options.
const rgOptions = Object.fromEntries((
  'regexp:e file:f pre pre-glob dfa-size-limit encoding:E engine max-count:m regex-size-limit threads:j glob:g iglob ignore-file ' +
  'max-depth:d max-filesize type:t type-not:T type-add type-clear after-context:A before-context:B color colors context:C ' +
  'context-separator field-context-separator field-match-separator hostname-bin hyperlink-format max-columns:M path-separator replace:r sort sortr generate'
).split(' ').map(option => {
  const [name, short] = option.split(':');
  return [name, short ? { type: 'string', short } : { type: 'string' }];
}));

function outputOptions(args: string[], mode: 'files' | 'json' | 'text') {
  const { tokens } = parseArgs({ args, strict: false, tokens: true, options: {
    ...rgOptions, count: { type: 'boolean', short: 'c' }, 'files-with-matches': { type: 'boolean', short: 'l' },
  } });
  let end = args.length;
  let encoding: string | undefined;
  let configured = true;
  for (const token of tokens) {
    if (token.kind === 'option-terminator') { end = token.index; break; }
    if (token.kind !== 'option') continue;
    if (token.value === undefined && Object.hasOwn(rgOptions, token.name)) end = token.index;
    switch (token.name) {
      case 'files': case 'files-with-matches': case 'files-without-match': mode = 'files'; break;
      case 'json': mode = 'json'; break;
      case 'no-json': if (mode === 'json') mode = 'text'; break;
      case 'count': case 'count-matches': case 'type-list': mode = 'text'; break;
      case 'encoding': encoding = token.value; break;
      case 'no-encoding': encoding = 'auto'; break;
      case 'no-config': configured = false; break;
    }
  }
  return { mode, end, encoding: encoding ?? (configured ? undefined : 'auto') };
}

async function* records(chunks: AsyncIterable<Buffer>, delimiter: string) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  for await (const chunk of chunks) {
    const text = tail + decoder.write(chunk);
    let from = 0;
    for (let end = text.indexOf(delimiter); end >= 0; end = text.indexOf(delimiter, from)) {
      yield { text: text.slice(from, end), terminated: true };
      from = end + delimiter.length;
    }
    tail = text.slice(from);
  }
  tail += decoder.end();
  if (tail) yield { text: tail, terminated: false };
}

async function searchHits(connection: MachineConnection, cwd: string, chunks: AsyncIterable<Buffer>, encoding?: string) {
  const hits: SearchHit[] = [];
  let file: { path: string; lines?: string[]; rows: number[] } | undefined;
  let decoder: TextDecoder | undefined;
  const transcodedColumn = async (raw: string, text: string, prefix: string, atEof: boolean) => {
    if (encoding === undefined) {
      // The machine's rg config supplies the decoder when the picker has no override.
      encoding = 'auto';
      try {
        const config = await connection.subprocess.exec('/bin/sh', ['-c', 'if [ -n "$RIPGREP_CONFIG_PATH" ]; then cat < "$RIPGREP_CONFIG_PATH"; fi'], { cwd });
        if (config.code === 0) {
          const args = Buffer.from(config.stdout).toString('utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
          encoding = outputOptions(args, 'json').encoding ?? 'auto';
        }
      } catch {
        // The matched snapshot remains available if the machine disconnects after the search.
      }
    }
    if (encoding === 'auto' || encoding === 'none') return;
    try { decoder ??= new TextDecoder(encoding, { ignoreBOM: true }); } catch { return; }
    const bytes = Buffer.from(raw);
    let consumed = 0, matchByte = 0, decoded = '';
    while (consumed < bytes.length && decoded.length < prefix.length) {
      const next = decoder.decode(bytes.subarray(consumed, consumed + 1), { stream: true });
      consumed++;
      decoded += next;
      if (next && decoded.length <= prefix.length) matchByte = consumed;
    }
    // A second read may see an edit. Use its coordinates only if it reproduces the matched snapshot.
    decoded += decoder.decode(bytes.subarray(consumed), { stream: true });
    const pending = decoder.decode();
    // At EOF rg can leave an incomplete final character in its decoder.
    if (decoded + pending !== text && !(atEof && decoded === text)) return;
    while (matchByte > 0 && (bytes[matchByte] & 0xc0) === 0x80) matchByte--;
    return bytes.toString('utf8', 0, matchByte).length;
  };

  for await (const { text: record } of records(chunks, '\n')) {
    // Informational commands such as --help can print plain text.
    let event: RgEvent | null;
    try { event = JSON.parse(record); } catch { continue; }
    const data = event?.type === 'match' ? event.data : undefined;
    if (!data?.path?.text || typeof data.lines?.text !== 'string' || !data.line_number || !Array.isArray(data.submatches)) continue;
    const path = posix.resolve(cwd, data.path.text);
    if (file?.path !== path) {
      file = { path, rows: [] };
      try {
        const raw = Buffer.from(await connection.fs.readFile(path)).toString('utf8');
        file.lines = raw.split(/\r\n?|\n/);
        // rg numbers LF lines. Only a lone CR makes the editor count differently.
        if (/\r(?!\n)/.test(raw)) {
          let row = 1;
          file.rows.push(row);
          for (const [ending] of raw.matchAll(/\r\n?|\n/g)) {
            row++;
            if (ending !== '\r') file.rows.push(row);
          }
        }
      } catch {
        // If the file disappeared, rg's snapshot still supplies its own text and line numbers.
      }
    }
    let line = data.line_number;
    let sourceLine = file.rows[line - 1] ?? line;
    let from = 0, match = 0;
    const matches = data.submatches.length ? data.submatches : [{ start: 0 }];
    for (const [, text, ending] of data.lines.text.matchAll(/([^\r\n]*)(\r\n?|\n|$)/g)) {
      const end = from + Buffer.byteLength(text) + ending.length;
      const found = matches[match];
      while (match < matches.length && (matches[match].start < end || !ending)) match++;
      if (found && (found.start < end || !ending)) {
        const prefix = Buffer.from(text).toString('utf8', 0, found.start - from);
        const hit = { path, line, column: prefix.length + 1, text: text.trim() };
        const raw = file.lines?.[sourceLine - 1];
        if (raw !== undefined) {
          const source = sourceLine === 1 ? raw.replace(/^\uFEFF/, '') : raw;
          const offset = text === source || text === raw ? prefix.length
            : await transcodedColumn(raw, text, prefix, sourceLine === file.lines?.length);
          if (offset !== undefined) {
            hit.line = sourceLine;
            hit.column = 1 + Math.max(0, offset - (text === source ? 0 : raw.length - source.length));
            hit.text = source.trim();
          }
        }
        hits.push(hit);
        if (hits.length === 500) return hits;
      }
      line++; sourceLine++;
      from = end;
    }
  }
  return hits;
}

export function registerSearch(context: MainContext, { withConnection }: ReturnType<typeof machineAccess>) {
  const rg = async <T>(connection: MachineConnection, cwd: string, args: string[], read: (chunks: AsyncIterable<Buffer>) => Promise<T>) => {
    const located = await locate(connection, [['rg']], cwd);
    if (!located) throw new Error('未找到 rg 命令，无法搜索');
    return withCommandOutput(connection, located.program, args, { cwd, env: { PATH: located.envPath } }, ({ code, stderr }, chunks) => {
      // rg returns 1 for an empty result in both listing and content searches.
      if (code !== 0 && code !== 1) throw new Error(Buffer.from(stderr).toString('utf8').trim() || '搜索失败');
      return read(chunks);
    });
  };
  return [
    context.ui.handle('find-files', ({ machine, path, args = [] }: SearchDirectory) =>
      withConnection(machine, async connection => {
        const { mode, end } = outputOptions(args, 'files');
        return rg(connection, path, ['--files', '--null', ...args.slice(0, end),
          '--color=never', '--path-separator=', ...args.slice(end)], async chunks => {
          // Counts and matching source lines can also end with NUL when --null-data is set.
          if (mode !== 'files') return [];
          const files: string[] = [];
          for await (const { text, terminated } of records(chunks, '\0')) {
            if (!terminated) return [];
            if (text && files.length < 20000) files.push(posix.resolve(path, text));
          }
          return files;
        });
      })),
    context.ui.handle('grep', ({ machine, path, query, args = [] }: SearchDirectory & { query: string }) =>
      withConnection(machine, async connection => {
        // Keep coordinates after -N, without consuming a path or supplying a missing option value.
        const { mode, end, encoding } = outputOptions(args, 'json');
        return rg(connection, path, ['--json', '--smart-case', '--max-count', '10', '--max-filesize', '2M', '-e', query,
          ...args.slice(0, end), '--line-number', '--path-separator=', ...args.slice(end)], async chunks =>
          mode === 'json' ? searchHits(connection, path, chunks, encoding) : []);
      })),
  ];
}
