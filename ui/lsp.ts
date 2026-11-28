import { LSPClient, LSPPlugin, Workspace, hoverTooltips, serverDiagnostics, type Transport, type WorkspaceFile } from '@codemirror/lsp-client';
import { tooltips, type EditorView } from '@codemirror/view';
import { Facet, type Extension } from '@codemirror/state';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { fileKey, machineKey, type FileClick, type LspData, type LspExit, type LspLog, type LspProcess, type LspSession, type OpenOptions } from '../shared';
import { changesBetween } from './merge';
import { languageOf } from './mode';

export const serviceFor = (file: FileClick): OpenOptions | undefined => {
  const language = languageOf(file.path);
  return language ? { machine: file.machine, path: file.path, language } : undefined;
};

const features = {
  documentSymbol: { method: 'textDocument/documentSymbol', capability: 'documentSymbolProvider' },
  definition: { method: 'textDocument/definition', capability: 'definitionProvider' },
  implementation: { method: 'textDocument/implementation', capability: 'implementationProvider' },
  typeDefinition: { method: 'textDocument/typeDefinition', capability: 'typeDefinitionProvider' },
  references: { method: 'textDocument/references', capability: 'referencesProvider' },
} as const;
export type LocationFeature = Exclude<keyof typeof features, 'documentSymbol'>;

export type Target = { path: string; line: number; column: number };

const uriOf = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

export type LspPosition = { line: number; character: number };
type Range = { start: LspPosition; end: LspPosition };
type State = 'connecting' | 'open' | 'closed';
export type ServiceStatus = { server: string; root?: string; state: State | 'missing'; error?: string; log?: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const unbase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

const frame = (message: string) => {
  const body = encoder.encode(message);
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  return bytes;
};

// A server's output arrives in arbitrary chunks: a frame is the header, a blank line, and a JSON body the header measures
// in bytes, so a chunk boundary in any of them has to wait for the rest.
class Frames {
  private buffered = new Uint8Array(0);

  push(bytes: Uint8Array) {
    const joined = new Uint8Array(this.buffered.length + bytes.length);
    joined.set(this.buffered);
    joined.set(bytes, this.buffered.length);
    const messages: string[] = [];
    let offset = 0;
    for (;;) {
      let end = -1;
      for (let index = offset; index + 3 < joined.length && end < 0; index++) {
        if (joined[index] === 13 && joined[index + 1] === 10 && joined[index + 2] === 13 && joined[index + 3] === 10) end = index;
      }
      if (end < 0) break;
      const length = Number(/content-length:\s*(\d+)/i.exec(decoder.decode(joined.subarray(offset, end)))?.[1]);
      const start = end + 4;
      // A server writing to stdout behind the protocol would otherwise stall every frame behind it.
      if (!Number.isFinite(length)) { offset = start; continue; }
      if (joined.length - start < length) break;
      messages.push(decoder.decode(joined.subarray(start, start + length)));
      offset = start + length;
    }
    this.buffered = joined.slice(offset);
    return messages;
  }
}

const bufferText = Facet.define<() => string>();
const diagnostics = serverDiagnostics();
type EditorFile = WorkspaceFile & { views: Set<EditorView>; diagnostics?: () => boolean };

// The server opens one document per URI even when several workspace tabs display that file.
class EditorWorkspace extends Workspace {
  files: EditorFile[] = [];
  private version = 0;
  private reporting?: EditorView;

  private showDiagnostics(view: EditorView, publish: () => boolean) {
    this.reporting = view;
    try { return publish(); } finally { this.reporting = undefined; }
  }

  publishDiagnostics(uri: string, publish: () => boolean) {
    const file = this.files.find(file => file.uri === uri);
    if (!file) return false;
    let handled = false;
    for (const view of file.views) if (this.showDiagnostics(view, publish)) handled = true;
    if (handled) file.diagnostics = publish;
    return handled;
  }

  private alignView(view: EditorView, file: EditorFile) {
    const plugin = LSPPlugin.get(view);
    if (!plugin) return;
    if (view.state.doc.eq(file.doc)) plugin.clear();
    else if (!plugin.syncedDoc.eq(file.doc)) {
      // A peer holding the same text knows which occurrence of a repeated line was edited.
      let changes;
      for (const other of file.views) {
        const peer = LSPPlugin.get(other);
        if (peer?.syncedDoc.eq(file.doc) && other.state.doc.eq(view.state.doc)) {
          changes = peer.unsyncedChanges;
          break;
        }
      }
      plugin.syncedDoc = file.doc;
      plugin.unsyncedChanges = changes ?? changesBetween(file.doc.toString(), view.state.doc.toString());
    }
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.files.find(file => file.uri === uri);
    if (existing) {
      existing.views.add(view);
      // The view's LSP plugin finishes constructing after openFile returns.
      queueMicrotask(() => {
        if (!existing.views.has(view)) return;
        this.alignView(view, existing);
        if (existing.diagnostics) this.showDiagnostics(view, existing.diagnostics);
      });
      return;
    }
    const views = new Set([view]);
    const file = { uri, languageId, version: this.version++, doc: view.state.doc, views,
      getView: (preferred = this.reporting) => {
        if (preferred && views.has(preferred)) return preferred;
        const open = [...views];
        return open.find(view => view.hasFocus) ?? open.find(view => view.dom.checkVisibility()) ?? open[0] ?? null;
      },
    };
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.files.find(file => file.uri === uri);
    if (!file || !file.views.delete(view) || file.views.size) return;
    this.files.splice(this.files.indexOf(file), 1);
    this.client.didClose(uri);
  }

  syncFiles() {
    const updates = [];
    for (const file of this.files) {
      const view = file.getView()!;
      const text = view.state.facet(bufferText)[0]();
      const prevDoc = file.doc;
      const previous = prevDoc.toString();
      const plugin = LSPPlugin.get(view);
      if (text !== previous) {
        const changes = plugin && plugin.syncedDoc.eq(prevDoc) && view.state.doc.toString() === text
          ? plugin.unsyncedChanges : changesBetween(previous, text);
        file.doc = changes.apply(prevDoc);
        file.version = this.version++;
        file.diagnostics = undefined;
        updates.push({ file, prevDoc, changes });
      }
      for (const editor of file.views) this.alignView(editor, file);
    }
    return updates;
  }
}

class Session {
  readonly client: LSPClient;
  state: State = 'connecting';
  error?: string;
  log?: string;
  upSince?: number;
  retired = false;
  message?: { text: string; shown: boolean };
  private handlers = new Set<(message: string) => void>();
  private frames = new Frames();

  constructor(private context: UiContext, readonly info: LspSession, private changed: () => void, private logged: (text: string) => void) {
    const transport: Transport = {
      send: (message) => this.send(message),
      subscribe: (handler) => { this.handlers.add(handler); },
      unsubscribe: (handler) => { this.handlers.delete(handler); },
    };
    this.client = new LSPClient({
      workspace: client => new EditorWorkspace(client),
      rootUri: uriOf(info.root),
      timeout: 10_000,
      // A hover answers with whatever the server sends, which can be wider than the page it hovers over: the window-wide
      // space tooltips default to would let it cover the panels beside this one, so the tooltip lives inside the editor and
      // keeps to its page, where the sheet caps its size and the editor clips what is left.
      extensions: [diagnostics, hoverTooltips(), tooltips({
        position: 'absolute',
        tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect(),
      })],
      // What a server says about itself is the page's notice, which leaves by itself, rather than the client's dialog,
      // which stays up until it is closed.
      notificationHandlers: {
        'textDocument/publishDiagnostics': (client, params) => (client.workspace as EditorWorkspace).publishDiagnostics(params.uri,
          () => diagnostics.notificationHandlers!['textDocument/publishDiagnostics'](client, params)),
        'window/showMessage': (_client, params) => { this.said(String(params?.message ?? '')); return true; },
        'window/logMessage': (_client, params) => { this.logged(String(params?.message ?? '')); return true; },
      },
    }).connect(transport);
    // The handshake is only what the client says about itself: a server that never answers it is still one this window can
    // write to, so what it says is kept for the tooltip and the session stays up.
    void this.client.initializing.then(() => this.up(), (problem: Error) => {
      if (this.closed) return;
      this.error = problem.message;
      this.changed();
    });
  }

  private said(text: string) {
    if (!text) return;
    this.message = { text, shown: false };
    this.changed();
  }

  private up() {
    if (this.state !== 'connecting') return;
    this.state = 'open';
    this.upSince = Date.now();
    this.changed();
  }

  private send(message: string) {
    // The client can send queued messages after the session closes.
    if (this.state === 'closed') return;
    // A refused write can be a transport outage. Only a node-reported exit closes the session.
    const { session, generation } = this.info;
    void this.context.ui.request('lsp-write', { session, generation, data: base64(frame(message)) }).then(
      // A successful write confirms the transport even if initialization is still pending.
      () => { if (this.state === 'closed') return; if (this.error !== undefined) { this.error = undefined; this.changed(); } this.up(); },
      (problem: Error) => { if (this.state === 'closed') return; this.error = problem.message; this.changed(); },
    );
  }

  receive(data: string) {
    for (const message of this.frames.push(unbase64(data))) for (const handler of this.handlers) handler(message);
  }

  stop(reason: string) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.error = reason;
    this.handlers.clear();
    this.client.disconnect();
    this.changed();
  }

  exit(code?: number) { this.stop(code === undefined ? '语言服务已断开' : `语言服务已退出 (${code})`); }

  get closed() { return this.state === 'closed'; }

  get unexpected() { return this.closed && !this.retired; }

  supports(feature: keyof typeof features) {
    return Boolean((this.client.serverCapabilities as Record<string, unknown> | null)?.[features[feature].capability]);
  }

  request<T>(feature: keyof typeof features, params: unknown) {
    if (this.closed) return Promise.resolve(undefined);
    this.client.sync();
    return this.client.request(features[feature].method, params) as Promise<T>;
  }
}

type TreeSymbol = { name: string; kind: number; selectionRange: Range; children?: TreeSymbol[] };
type FlatSymbol = { name: string; kind: number; containerName?: string; location: { range: Range } };
type ServerSymbol = TreeSymbol | FlatSymbol;
export type FileSymbol = { name: string; line: number; column: number; children?: FileSymbol[] };

// Module, namespace, class, enum, interface, object, struct.
const containers = new Set([2, 3, 5, 10, 11, 19, 23]);
// Containers plus method, property, field, constructor, function, constant, enum member.
const listed = new Set([...containers, 6, 7, 8, 9, 12, 14, 22]);
// Skip synthetic names such as <unknown>, [computed] and anonymous callbacks.
const unnamed = (name: string) => name.startsWith('<') || name.startsWith('[') || name.includes(' callback');
const isTree = (item: ServerSymbol): item is TreeSymbol => 'selectionRange' in item;

function outline(items: ServerSymbol[]): FileSymbol[] {
  const atOrBefore = (a: LspPosition, b: LspPosition) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const covers = (outer: FlatSymbol, inner: FlatSymbol) => {
    const outerSpan = outer.location.range;
    const innerSpan = inner.location.range;
    return atOrBefore(outerSpan.start, innerSpan.start) && atOrBefore(innerSpan.end, outerSpan.end);
  };
  // Flat answers carry no hierarchy; container names and covering ranges give a best-effort grouping.
  const byName = new Map<string, FlatSymbol[]>();
  for (const item of items) {
    if (isTree(item)) continue;
    byName.set(item.name, [...(byName.get(item.name) ?? []), item]);
  }
  const held = new Map<FlatSymbol, FlatSymbol[]>();
  const roots: ServerSymbol[] = [];
  for (const item of items) {
    if (isTree(item)) { roots.push(item); continue; }
    const possibleHolders = (item.containerName === undefined ? [] : byName.get(item.containerName) ?? [])
      .filter((candidate) => candidate !== item && covers(candidate, item));
    const holder: FlatSymbol | undefined = possibleHolders.length === 0
      ? undefined
      : possibleHolders.reduce((innermost, candidate) => (covers(innermost, candidate) ? candidate : innermost));
    if (holder === undefined) roots.push(item);
    else held.set(holder, [...(held.get(holder) ?? []), item]);
  }
  const branch = (entries: ServerSymbol[]): FileSymbol[] => entries.flatMap((item) => {
    if (unnamed(item.name) || !listed.has(item.kind)) return [];
    const range = isTree(item) ? item.selectionRange : item.location.range;
    const children = containers.has(item.kind) ? branch(isTree(item) ? item.children ?? [] : held.get(item) ?? []) : [];
    return [{ name: item.name, line: range.start.line + 1, column: range.start.character + 1, ...(children.length === 0 ? {} : { children }) }];
  });
  return branch(roots);
}

// Some servers answer before indexing the newly opened document.
const reask = async <T>(ask: () => Promise<T>, done: (answer: T) => boolean, rounds: number) => {
  let answer = await ask();
  for (let round = 0; round < rounds && !done(answer); round++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    answer = await ask();
  }
  return answer;
};

// Back off after unexpected exits on a disconnected or failing machine.
const reviveWaits = [1000, 3000, 7000];
// A stable session restores its restart budget.
const healthyFor = 30_000;
type ServerGroup = { machine: string; client?: Session; tries: number; timer?: ReturnType<typeof setTimeout> };
export type DisplayedFile = OpenOptions & { reading: boolean };

// Create a new client on restart. The LSP package has no client reset operation.
export class LanguageServices {
  // A failed file can still need a retry after the last user of a replacement process leaves.
  private servers = new Map<string, ServerGroup>();
  private byFile = new Map<string, { session: Session; options: OpenOptions }>();
  private opening = new Map<string, { machine: string; group?: ServerGroup }>();
  private unclaimed = new Map<number, { session: string; machine: string }>();
  private disposed = false;
  private off: (() => void)[];
  private listeners = new Set<() => void>();
  private openingLogs = new Map<number, string>();
  private missing = new Map<string, { error: string; language: string }>();

  constructor(private context: UiContext, private shownFiles: () => DisplayedFile[]) {
    this.off = [
      context.ui.subscribe<LspData>('lsp-data', event => this.client(event)?.receive(event.data)),
      context.ui.subscribe<LspExit>('lsp-exit', event => this.client(event)?.exit(event.code)),
      context.ui.subscribe<LspLog>('lsp-log', event => this.rememberLog(event, event.text)),
    ];
  }

  private get demand() {
    const files = new Set<string>(), reading = new Set<string>();
    if (!this.disposed) for (const file of this.shownFiles()) {
      files.add(fileKey(file));
      if (file.reading) reading.add(machineKey(file.machine));
    }
    return { files, reading };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private client({ session, generation }: LspProcess) {
    const running = this.servers.get(session)?.client;
    return running && running.info.generation === generation ? running : undefined;
  }

  private rememberLog(process: LspProcess, text: string) {
    if (!text) return;
    const last = text.split('\n').pop()!;
    const running = this.client(process);
    if (running && !running.closed && !running.retired) {
      running.log = last;
      this.notify();
    } else if (this.opening.size) this.openingLogs.set(process.generation, last);
  }

  private changed() {
    this.notify();
    for (const [session, group] of this.servers) {
      if (group.client?.unexpected) this.revive(session, group, group.client);
    }
  }

  extension(options: OpenOptions, readText: () => string): Extension {
    const found = this.session(options);
    return found ? [bufferText.of(readText), found.client.plugin(uriOf(options.path), options.language)] : [];
  }

  async open(options: OpenOptions, revival?: ServerGroup, automatic = false) {
    const key = fileKey(options);
    if (!this.demand.files.has(key)) return;
    const opening = { machine: machineKey(options.machine), group: revival };
    this.opening.set(key, opening);
    const needed = () => {
      const prior = this.byFile.get(key);
      return this.opening.get(key) === opening && this.demand.files.has(key)
        && (!revival || (prior && this.servers.get(prior.session.info.session) === revival));
    };
    // Automatic attempts preserve the exit diagnostic. An explicit open reports its launch failure.
    try {
      const info = await this.context.ui.request<LspSession | null>('lsp-open', options)
        .catch((problem: Error) => {
          if (!automatic && needed()) this.missing.set(key, { error: problem.message, language: options.language });
          return null;
        });
      if (!info) {
        const prior = this.byFile.get(key);
        if (automatic && revival && prior && needed()) this.scheduleRetry(prior.session.info.session, revival);
        return;
      }
      if (!needed()) { this.unclaimed.set(info.generation, { session: info.session, machine: opening.machine }); return; }
      this.missing.delete(key);
      let group = this.servers.get(info.session);
      if (!group) {
        group = { machine: opening.machine, tries: 0 };
        this.servers.set(info.session, group);
      }
      let running = group.client;
      if (!running || info.generation > running.info.generation) {
        // The replacement's open reply can arrive before the previous process's exit.
        if (running && !running.closed) {
          running.exit();
          group = this.servers.get(info.session)!;
        }
        running = new Session(this.context, info, () => this.changed(), (text) => this.rememberLog(info, text));
        running.log = this.openingLogs.get(info.generation);
        this.openingLogs.delete(info.generation);
        group.client = running;
      }
      this.byFile.set(key, { session: running, options });
      if (info.exit && info.generation === running.info.generation) running.exit(info.exit.code);
      this.changed();
    } finally {
      if (this.opening.get(key) === opening) {
        this.opening.delete(key);
        if (!this.session(options)) this.notify();
      }
      if (!this.opening.size) this.openingLogs.clear();
      await this.closeUnused();
    }
  }

  // An open view follows the replacement session after a restart.
  session(options: OpenOptions) {
    const found = this.byFile.get(fileKey(options))?.session;
    return found && !found.closed ? found : undefined;
  }

  // Symbol and location requests may arrive while the editor's open is still pending.
  private async query<T>(options: OpenOptions, feature: keyof typeof features, ask: (found: Session) => Promise<T[]>): Promise<T[]> {
    const key = fileKey(options);
    if (!this.session(options) && this.opening.has(key)) await new Promise<void>((resolve) => {
      const stop = this.subscribe(() => {
        if (!this.session(options) && this.opening.has(key)) return;
        stop();
        resolve();
      });
    });
    const found = this.session(options);
    if (!found) return [];
    let stop!: () => void;
    const closed = new Promise<T[]>(resolve => {
      stop = this.subscribe(() => { if (found.closed) resolve([]); });
    });
    try {
      const answer = found.client.initializing.then(() => found.supports(feature) ? ask(found) : [], () => []);
      return await Promise.race([answer, closed]);
    } finally { stop(); }
  }

  symbols(options: OpenOptions): Promise<FileSymbol[]> {
    return this.query(options, 'documentSymbol', async found => {
      const ask = () => found.request<ServerSymbol[] | null>('documentSymbol', { textDocument: { uri: uriOf(options.path) } }).catch(() => undefined);
      // Indexing may still be in progress when the first symbol list is empty.
      const answer = await reask(ask, (symbols) => found.closed || (Array.isArray(symbols) && symbols.length > 0), 10);
      return Array.isArray(answer) ? outline(answer) : [];
    });
  }

  locations(options: OpenOptions, position: LspPosition, feature: LocationFeature): Promise<Target[]> {
    return this.query(options, feature, found => {
      const extra = feature === 'references' ? { context: { includeDeclaration: true } } : {};
      const ask = async () => {
        const result = await found.request<unknown>(feature, {
          textDocument: { uri: uriOf(options.path) }, position, ...extra,
        }).catch(() => undefined);
        const places = Array.isArray(result) ? result : result ? [result] : [];
        return (places as ({ uri: string; range: Range } | { targetUri: string; targetSelectionRange: Range })[]).map((item) => {
          const [uri, range] = 'targetUri' in item ? [item.targetUri, item.targetSelectionRange] : [item.uri, item.range];
          return { path: pathOf(uri), line: range.start.line + 1, column: range.start.character + 1 };
        });
      };
      // An indexing server may initially resolve an import to its declaration in the current file.
      return reask(ask, (targets) => found.closed || feature === 'references' || targets.some(target => target.path !== options.path), 3);
    });
  }

  private describe(recorded: Session): ServiceStatus {
    return { server: recorded.info.server, root: recorded.info.root, state: recorded.state, error: recorded.error, log: recorded.log };
  }

  status(options: OpenOptions): ServiceStatus | undefined {
    const key = fileKey(options);
    const recorded = this.byFile.get(key)?.session;
    if (recorded && !recorded.closed) return this.describe(recorded);
    const missing = this.missing.get(key);
    // A missing executable has no reported server name.
    if (missing) return { server: missing.language, state: 'missing', error: missing.error };
    return recorded && this.describe(recorded);
  }

  takeMessage(options: OpenOptions) {
    const message = this.byFile.get(fileKey(options))?.session.message;
    if (!message || message.shown) return undefined;
    message.shown = true;
    return message;
  }

  async restart(options: OpenOptions) {
    const key = fileKey(options);
    if (!this.demand.files.has(key)) return;
    const found = this.byFile.get(key)?.session;
    if (!found || this.servers.get(found.info.session)?.client !== found) { await this.open(options); return; }
    const session = found.info.session;
    clearTimeout(this.servers.get(session)?.timer);
    const revival = { machine: machineKey(options.machine), client: found, tries: 0 };
    this.servers.set(session, revival);
    await this.letGo(found, '语言服务已重启');
    await this.reopenFiles(session, revival);
  }

  private async reopenFiles(session: string, revival: ServerGroup, automatic = false) {
    if (this.servers.get(session) !== revival) return;
    // A new project marker can move only some of the open files to another server.
    const { files: wanted } = this.demand;
    const files = [...this.byFile].filter(([key, file]) => wanted.has(key) && file.session.info.session === session
      && file.session.closed && (!automatic || this.opening.get(key)?.group !== revival));
    if (automatic && files.length) revival.tries++;
    await Promise.all(files.map(([, file]) => this.open(file.options, revival, automatic)));
  }

  private scheduleRetry(session: string, group: ServerGroup) {
    if (this.servers.get(session) !== group || group.timer !== undefined || group.tries >= reviveWaits.length) return;
    group.timer = setTimeout(() => {
      group.timer = undefined;
      void this.reopenFiles(session, group, true);
    }, reviveWaits[group.tries]);
  }

  private revive(session: string, revival: ServerGroup, gone: Session) {
    gone.retired = true;
    if (gone.upSince !== undefined && Date.now() - gone.upSince >= healthyFor) {
      clearTimeout(revival.timer);
      revival = { machine: revival.machine, client: gone, tries: 0 };
      this.servers.set(session, revival);
    }
    this.scheduleRetry(session, revival);
  }

  // Retire before closing so an intentional stop cannot schedule a restart.
  private async letGo(found: Session, reason: string) {
    if (found.closed) return;
    found.retired = true;
    found.stop(reason);
    const { session, generation } = found.info;
    await this.context.ui.request('lsp-close', { session, generation }).catch(() => undefined);
  }

  async closeUnused() {
    const { files: wanted, reading: pending } = this.demand;
    const openingCount = this.opening.size;
    for (const key of this.opening.keys()) if (!wanted.has(key)) this.opening.delete(key);
    for (const key of this.byFile.keys()) if (!wanted.has(key)) this.byFile.delete(key);
    for (const key of this.missing.keys()) if (!wanted.has(key)) this.missing.delete(key);
    // A displayed file can claim a shared server after both its read and its project lookup finish.
    for (const open of this.opening.values()) pending.add(open.machine);
    const closes: Promise<unknown>[] = [];
    const clients = [...this.byFile.values()].map(file => file.session);
    for (const [session, group] of this.servers) {
      const running = group.client;
      if (running) {
        this.unclaimed.delete(running.info.generation);
        if (clients.includes(running) || pending.has(group.machine)) continue;
        group.client = undefined;
        closes.push(this.letGo(running, '语言服务已关闭'));
      }
      if (!clients.some(client => client.info.session === session)) {
        clearTimeout(group.timer);
        this.servers.delete(session);
      }
    }
    for (const [generation, { session, machine }] of this.unclaimed) {
      if (pending.has(machine)) continue;
      this.unclaimed.delete(generation);
      closes.push(this.context.ui.request('lsp-close', { session, generation }).catch(() => undefined));
    }
    if (closes.length || this.opening.size !== openingCount) this.notify();
    await Promise.all(closes);
  }

  dispose() {
    this.disposed = true;
    void this.closeUnused();
    for (const dispose of this.off) dispose();
  }
}
