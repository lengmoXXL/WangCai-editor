import { posix } from 'node:path';
import { workspaceAlias, type MachineConnection, type FileChanges } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { fileKey, type FileClick, type ImageBytes } from '../shared';
import type { machineAccess } from './machines';

// SDK writes rename a staging file over the destination. Reads and watches follow the same link chain.
async function fileDestination(connection: MachineConnection, path: string, links?: Set<string>) {
  if (!posix.isAbsolute(path)) throw new Error('文件路径必须是绝对路径');
  for (let depth = 0; ; depth++) {
    const parts = path.split('/').filter(Boolean);
    let prefix = '';
    const entries = parts.map(part => prefix += '/' + part);
    const link = await connection.subprocess.exec('/bin/sh', ['-c', `for name do
  [ -L "$name" ] || continue
  printf '%s\\0' "$name"
  readlink -n "$name" || exit 2
  exit 0
done
exit 1`, 'sh', ...entries], { cwd: '/' });
    if (link.code === 1) return path;
    if (link.code !== 0) throw new Error(Buffer.from(link.stderr).toString().trim() || '无法读取符号链接');
    if (depth === 40) throw new Error('符号链接层数过多');
    const [name, target] = Buffer.from(link.stdout).toString().split('\0');
    links?.add(posix.normalize(name));
    const destination = posix.isAbsolute(target) ? target : `${posix.dirname(name)}/${target}`;
    path = destination + prefix.slice(name.length);
  }
}

type Listen = (path: string, changed: (event: FileChanges) => void) => Promise<(replaced?: boolean) => void>;

async function watchFile(connection: MachineConnection, path: string, listen: Listen, changed: () => void) {
  const subscriptions = new Map<string, (replaced?: boolean) => void>();
  let names = new Set<string>();
  let active = true;
  let queued = Promise.resolve();
  const onChange = ({ created, modified, removed }: FileChanges) => {
    const touched = [...created, ...modified, ...removed].filter(entry => names.has(entry) || entry === '/');
    if (!touched.length) return;
    for (const [watched, detach] of subscriptions) {
      if (!touched.some(entry => watched === entry || watched.startsWith(entry === '/' ? '/' : entry + '/'))) continue;
      subscriptions.delete(watched);
      detach(true);
    }
    queued = queued.then(scan).catch(() => undefined).then(() => { if (active) changed(); });
  };
  const scan = async () => {
    if (!active) return;
    const links = new Set<string>();
    const target = posix.normalize(await fileDestination(connection, path, links));
    links.add(target);
    const next = new Set<string>(), wanted = new Set<string>();
    let added = false;
    const observe = async (entry: string) => {
      wanted.add(entry);
      if (!active || subscriptions.has(entry)) return;
      const stop = await listen(entry, onChange);
      if (active) { subscriptions.set(entry, stop); added = true; }
      else stop();
    };
    for (const name of links) {
      let child = name, parent = posix.dirname(name);
      while (parent !== '/' && !(await connection.fs.stat(parent))?.isDirectory) {
        child = parent;
        parent = posix.dirname(parent);
      }
      for (let entry = child; entry !== '/'; entry = posix.dirname(entry)) {
        next.add(entry);
        if (!names.has(entry)) added = true;
        names.add(entry);
        try { await observe(posix.dirname(entry)); }
        catch {
          // A searchable directory can deny watches while a known child is still readable.
          if (entry !== child) continue;
          try { await observe(child); }
          catch (error) { if (name === target) throw error; }
        }
      }
    }
    names = next;
    for (const [entry, stop] of subscriptions) if (!wanted.has(entry)) {
      subscriptions.delete(entry);
      stop();
    }
    // Resolve again after arming a new name to catch a link changed during registration.
    if (added) await scan();
  };
  const close = () => {
    active = false;
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  };
  try { await (queued = scan()); }
  catch (error) { close(); throw error; }
  return close;
}

export function registerFiles(context: MainContext, { withConnection }: ReturnType<typeof machineAccess>, signal: AbortSignal) {
  const handlers = [
    context.ui.handle('read', ({ machine, path }: { machine: FileClick['machine']; path: string }) =>
      withConnection(machine, async (connection) => {
        const bytes = await connection.fs.readFile(path).catch(async (error: Error) => {
          if (await connection.fs.stat(path) === null) return { missing: error.message };
          throw error;
        });
        if ('missing' in bytes) return bytes;
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new Error('暂不支持二进制或非 UTF-8 文件'); }
        if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('暂不支持二进制文件');
        return text;
      })),
    context.ui.handle('resolve', ({ machine, path, workspaceId, base }: { machine: FileClick['machine']; path?: string; workspaceId?: string; base?: string }) =>
      withConnection(machine, async (connection) => {
        const target = path === undefined ? await context.request<string>(workspaceAlias, 'cwd', { workspaceId }) : posix.resolve(base!, path);
        const stat = await connection.fs.stat(target);
        if (!stat) throw new Error(`路径不存在: ${target}`);
        return { type: stat.isDirectory ? 'directory' : 'file', machine, path: target };
      })),
  ];

  // Local image bytes cross the JSON channel as base64.
  const imageTypes = new Map(Object.entries({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
  }));
  const imageCeiling = 10 * 1024 * 1024;
  handlers.push(context.ui.handle('read-image', ({ machine, path }: { machine: FileClick['machine']; path: string }): Promise<ImageBytes> =>
    withConnection(machine, async (connection) => {
      const mime = imageTypes.get(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
      if (!mime) throw new Error('暂不支持该图片格式');
      const bytes = await connection.fs.readFile(path);
      if (bytes.byteLength > imageCeiling) throw new Error('图片过大，无法预览');
      return { mime, data: Buffer.from(bytes).toString('base64') };
    })));
  handlers.push(context.ui.handle('write', ({ machine, path, text }: { machine: FileClick['machine']; path: string; text: string }) =>
    withConnection(machine, async connection => connection.fs.writeFile(await fileDestination(connection, path), Buffer.from(text, 'utf8')))));

  type Subscription = { listeners: Set<(event: FileChanges) => void>; ready: Promise<() => void> };
  const subscriptions = new Map<string, Subscription>();
  const listen = async (machine: FileClick['machine'], path: string, listener: (event: FileChanges) => void) => {
    const key = fileKey({ machine, path });
    let watch = subscriptions.get(key);
    if (!watch) {
      const listeners = new Set<(event: FileChanges) => void>();
      const ready = withConnection(machine, async (connection, keep) => {
        const stop = await connection.fs.watch(path, {}, event => { for (const notify of listeners) notify(event); });
        const release = keep();
        return () => { stop(); release(); };
      });
      watch = { listeners, ready };
      subscriptions.set(key, watch);
    }
    watch.listeners.add(listener);
    let stop: () => void;
    try { stop = await watch.ready; }
    catch (error) {
      if (subscriptions.get(key) === watch) subscriptions.delete(key);
      throw error;
    }
    return (replaced = false) => {
      watch.listeners.delete(listener);
      if (subscriptions.get(key) !== watch || (!replaced && watch.listeners.size)) return;
      subscriptions.delete(key);
      stop();
    };
  };

  type WatchedPath = { holders: Set<string>; started?: Promise<void>; close?: () => void };
  const watchers = new Map<string, WatchedPath>();
  handlers.push(context.ui.handle('watch', async ({ holder, machine, path, active }: { holder: string; machine: FileClick['machine']; path: string; active: boolean }) => {
    const key = fileKey({ machine, path });
    const existing = watchers.get(key);
    if (!active) {
      if (existing?.holders.delete(holder) && !existing.holders.size) {
        watchers.delete(key);
        existing.close?.();
      }
      return;
    }
    const watched: WatchedPath = existing ?? { holders: new Set() };
    watched.holders.add(holder);
    if (watched.started) return watched.started;
    watchers.set(key, watched);
    watched.started = withConnection(machine, async (connection, keep) => {
      const close = await watchFile(connection, path, (entry, notify) => listen(machine, entry, notify), () => context.ui.publish('changed', key));
      if (signal.aborted || watchers.get(key) !== watched) { close(); return; }
      const release = keep();
      watched.close = () => { close(); release(); };
    }).catch((error: unknown) => {
      watched.started = undefined;
      throw error;
    });
    return watched.started;
  }));

  return () => {
    for (const remove of handlers) remove();
    for (const watcher of watchers.values()) watcher.close?.();
    watchers.clear();
  };
}
