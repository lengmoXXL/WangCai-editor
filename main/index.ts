import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import type { Cursor, DiffRequest, History } from '../shared';
import { machineAccess } from './machines';
import { registerLanguageServers } from './lsp';
import { registerFiles } from './files';
import { readDiff } from './git';
import { registerSearch } from './search';

// The renderer handles file-specific keys because it owns the current selection.
export const keys = {
  '<leader>e': { global: true, insert: true, desc: '打开编辑器视图', event: 'core:show-view', data: { plugin: 'editor' } },
  '<leader>gp': { insert: true, desc: ['goto', '在 preview 里打开当前文件'], event: 'editor:preview' },
  '<leader>gf': { insert: true, desc: ['goto', '在 files 里选中当前文件'], event: 'editor:reveal' },
};

export const config = {
  font: {
    family: { type: 'string', default: 'Menlo, monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
  // Font sizes are keyed by language ID.
  fontSizes: { type: 'object' },
  // A language can replace its command or markers, or disable its server with false.
  lsp: { type: 'object' },
};

export function activate(context: MainContext) {
  const lifetime = new AbortController();
  const machines = machineAccess(context, lifetime.signal);
  const { withConnection } = machines;
  const stopFiles = registerFiles(context, machines, lifetime.signal);
  const stopServers = registerLanguageServers(context, machines);

  const handlers = [
    ...registerSearch(context, machines),
    context.ui.handle('diff', (request: DiffRequest) =>
      withConnection(request.machine, connection => readDiff(connection, request))),
  ];

  const historyPath = join(context.host.dataDirectory, 'history.json');
  handlers.push(
    context.ui.handle('history', () => existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {}),
    context.ui.handle('save-history', (history: Record<string, History>) => {
      writeFileSync(`${historyPath}.tmp`, JSON.stringify(history, null, 2));
      renameSync(`${historyPath}.tmp`, historyPath);
    }),
  );

  // Only the visible tab can answer a cursor query.
  let cursorAsk = 0;
  const cursorWaiters = new Map<number, (cursor: Cursor | undefined) => void>();
  handlers.push(
    context.ui.handle('cursor-reply', ({ nonce, cursor }: { nonce: number; cursor?: Cursor }) => {
      cursorWaiters.get(nonce)?.(cursor);
    }),
    context.ui.handle('cursor', () => new Promise<Cursor | undefined>((resolve) => {
      const nonce = ++cursorAsk;
      const timer = setTimeout(() => { cursorWaiters.delete(nonce); resolve(undefined); }, 500);
      cursorWaiters.set(nonce, (cursor) => { clearTimeout(timer); cursorWaiters.delete(nonce); resolve(cursor); });
      context.ui.publish('cursor-query', { nonce });
    })),
  );
  return async () => {
    for (const remove of handlers) remove();
    lifetime.abort();
    stopFiles();
    await stopServers();
    machines.disconnect();
  };
}
