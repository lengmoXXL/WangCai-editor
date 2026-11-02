import { LSPClient, hoverTooltips, serverDiagnostics, type Transport } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { machineKey, type FileClick, type LspData, type LspExit, type LspLog, type LspSession, type OpenOptions } from './shared';

// The location features this plugin asks for itself, each with the request it sends and the capability a server answers it
// under: an answer may name a file the window has not opened, which the client's own jumps would have to read in first.
const features = {
  definition: { method: 'textDocument/definition', capability: 'definitionProvider' },
  implementation: { method: 'textDocument/implementation', capability: 'implementationProvider' },
  typeDefinition: { method: 'textDocument/typeDefinition', capability: 'typeDefinitionProvider' },
  references: { method: 'textDocument/references', capability: 'referencesProvider' },
} as const;
export type LocationFeature = keyof typeof features;

// Where an answer points: a place in a file that may be one the window has not opened.
export type Target = { path: string; line: number; column: number };

// A path as the URI a server speaks in, and back: every segment is spelled the way a URI spells it.
const uriOf = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

type Range = { start: { line: number; character: number } };
type State = 'connecting' | 'open' | 'closed';
// What the dot shows about the service behind a file: which server it is, where its root is, and how it is doing.
export type ServiceStatus = { server: string; root?: string; state: State | 'missing'; error?: string; log?: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const unbase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

// The bytes of one message, in the framing a language server reads: a header carrying the byte count, a blank line, and
// the JSON body.
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

// One language server over the plugin channel: the transport the client speaks through, and what this window knows about
// the server besides.
class Session {
  readonly client: LSPClient;
  state: State = 'connecting';
  error?: string;
  upSince?: number;
  retired = false;
  private handlers = new Set<(message: string) => void>();
  private frames = new Frames();

  constructor(private context: UiContext, readonly info: LspSession, private changed: () => void) {
    const transport: Transport = {
      send: (message) => this.send(message),
      subscribe: (handler) => { this.handlers.add(handler); },
      unsubscribe: (handler) => { this.handlers.delete(handler); },
    };
    this.client = new LSPClient({
      rootUri: uriOf(info.root),
      timeout: 10_000,
      extensions: [serverDiagnostics(), hoverTooltips()],
    }).connect(transport);
    // The handshake is only what the client says about itself: a server that never answers it is still one this window can
    // write to, so what it says is kept for the tooltip and the session stays up.
    void this.client.initializing.then(() => this.up(), (problem: Error) => { this.error = problem.message; });
  }

  private up() {
    // A server that already came up — or stopped — is not brought up again by a late answer.
    if (this.state !== 'connecting') return;
    this.state = 'open';
    this.upSince = Date.now();
    this.changed();
  }

  private send(message: string) {
    // What a closed server is told is dropped rather than failed on: the client may still send after a stop, and a late
    // message is not an error.
    if (this.state === 'closed') return;
    // A write the node would not take is the server's end as far as this window can tell, so it is reported here rather
    // than left for the client to notice.
    void this.context.ui.request('lsp-write', { session: this.info.session, data: base64(frame(message)) }).then(
      // A server that took a write is up, whether or not it has answered the handshake: a body that never speaks is still a
      // server this window keeps.
      () => this.up(),
      (problem: Error) => this.stop(problem.message),
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

  get closed() { return this.state === 'closed'; }

  // A stop the window asked for is not a failure: only a server that stopped by itself is started again.
  get unexpected() { return this.closed && !this.retired; }

  // Whether this server answers a feature, which the menu is built from.
  supports(feature: LocationFeature) {
    return Boolean((this.client.serverCapabilities as Record<string, unknown> | null)?.[features[feature].capability]);
  }

  // The server is asked about the text this window shows, so what it has not been told yet goes first.
  request<T>(method: string, params: unknown) {
    this.client.sync();
    return this.client.request(method, params) as Promise<T>;
  }
}

// A symbol as either form a server answers a document's symbols in: a file's own tree, whose nested entries are what they
// are declared in, or a flat list that carries each one's range in a location.
type ServerSymbol = { name: string; kind?: number; range?: Range; selectionRange?: Range; location?: { range: Range }; children?: ServerSymbol[] };
// What the picker lists for a file: a declaration, under the name of whatever declares it.
export type FileSymbol = { name: string; container?: string; line: number; column: number };

// The symbol kinds whose children are declarations of their own: a type of any language holds its members, and a file
// holds what it declares. Anything else — a function, a statement, a JSX child — holds statements and locals.
const containers = new Set([2, 3, 5, 10, 11, 19, 23]);
// What a file declares: everything a container is, and the kinds that only ever declare a single thing — a function, a
// variable or constant, an object.
const declarations = new Set([...containers, 12, 13, 14]);
// What a type declares, which a file's declaration list shows as well: its methods, properties, fields, constructor and enum
// members.
const members = new Set([6, 7, 8, 9, 22]);
// A server describes what it cannot name with a placeholder — `<unknown>`, `<function>`, `[computed]`, `a.map() callback` —
// and nothing a reader can look up has such a name.
const unnamed = (name: string) => name.startsWith('<') || name.startsWith('[') || name.includes(' callback');

// A file's symbols, the way an editor's outline reads it: what the file declares, and the members of the types it declares,
// walking into an entry only where `containers` says its children are declarations too.
function outline(items: ServerSymbol[]): FileSymbol[] {
  const symbols: FileSymbol[] = [];
  const walk = (entries: ServerSymbol[], container?: string) => {
    for (const item of entries) {
      if (unnamed(item.name)) continue;
      const kind = item.kind ?? 0;
      if (!declarations.has(kind) && (container === undefined || !members.has(kind))) continue;
      const range = item.selectionRange ?? item.location?.range ?? item.range;
      symbols.push({ name: item.name, container, line: (range?.start.line ?? 0) + 1, column: (range?.start.character ?? 0) + 1 });
      if (item.children && containers.has(kind)) walk(item.children, [...(container ? [container] : []), item.name].join(' · '));
    }
  };
  walk(items);
  return symbols;
}

// A question is asked again while its answer is not one the caller can use, for as many rounds as the caller will wait: a
// server that has not read the document yet answers nothing, which reads the same as an empty file or a name with no
// definition.
const reask = async <T>(ask: () => Promise<T>, done: (answer: T) => boolean, rounds: number) => {
  let answer = await ask();
  for (let round = 0; round < rounds && !done(answer); round++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    answer = await ask();
  }
  return answer;
};

// How long a server that stopped by itself waits before each try at starting it again: a machine that reconnected needs
// its server back, while one that keeps dying must not be restarted forever.
const reviveWaits = [1000, 3000, 7000];
// How long a server has to stay up for the tries it has taken to count for nothing: one that comes up and dies again
// inside this window is still the server that keeps dying.
const healthyFor = 30_000;

// The language servers this window drives, one client per server. A client is never disposed — the package has no way to —
// so a server that is restarted leaves its client behind and starts another one.
export class LanguageServices {
  private bySession = new Map<string, Session>();
  // The session each file the window shows speaks to.
  private byFile = new Map<string, string>();
  private off: (() => void)[];
  private listeners = new Set<() => void>();
  // What a server last wrote to its error stream, which is all a user sees of why it stopped.
  private logs = new Map<string, string>();
  // Why a file has no server: what was said when one could not be started, and the language the dot then names.
  private missing = new Map<string, { error: string; language: string }>();
  // What it takes to start a session again: the options to open it with, and the tries that stand since the server it
  // belongs to last stayed up. How long a server has been up is the session's own, next to the server it describes.
  private revivals = new Map<string, { options: OpenOptions; tries: number }>();
  private reviving = new Set<string>();

  constructor(private context: UiContext) {
    this.off = [
      context.ui.subscribe<LspData>('lsp-data', ({ session, data }) => this.bySession.get(session)?.receive(data)),
      context.ui.subscribe<LspExit>('lsp-exit', ({ session, code }) => {
        this.bySession.get(session)?.stop(code === undefined ? '语言服务已断开' : `语言服务已退出 (${code})`);
      }),
      context.ui.subscribe<LspLog>('lsp-log', ({ session, text }) => { if (text) this.logs.set(session, text.split('\n').pop()!); }),
    ];
  }

  // The status dot follows a server from the moment it opens until it stops, so each change in between reaches it.
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // What the dot hears when anything about a session moves.
  private notify() {
    for (const listener of this.listeners) listener();
  }

  private changed() {
    this.notify();
    // A server that stopped by itself is started again, which no session can ask for on its own.
    for (const [session, running] of [...this.bySession]) if (running.unexpected) void this.revive(session, running);
  }

  private keyOf(file: Pick<FileClick, 'machine' | 'path'>) { return `${machineKey(file.machine)}|${file.path}`; }

  // The extension that ties this file's editor to its server: the hover and the diagnostics of this plugin come from it.
  extension(options: OpenOptions): Extension {
    const found = this.session(options);
    return found ? found.client.plugin(uriOf(options.path), options.language) : [];
  }

  // Starts or reuses the server for a file, so the editor highlights and hovers from the same server. `wanted` is false
  // when a revival asks for a session a view may have left meanwhile.
  async open(options: OpenOptions, wanted = true) {
    const key = this.keyOf(options);
    const info = await this.context.ui.request<LspSession | null>('lsp-open', options)
      .catch((problem: Error) => {
        // Only a file whose server never came up is read from this: a revival that fails still has the closed session the
        // dot speaks for.
        if (wanted) this.missing.set(key, { error: problem.message, language: options.language });
        return null;
      });
    if (!info) {
      // Nothing runs behind this file. A file whose server could not be started was just remembered, which is what lets the
      // dot show it; a language with no server of its own keeps its dot away.
      this.notify();
      return;
    }
    if (!wanted && !this.revivals.has(info.session)) {
      // The views that asked for this server left while it was on its way, so the one just started is closed rather than
      // kept for nobody.
      await this.context.ui.request('lsp-close', { session: info.session }).catch(() => undefined);
      return;
    }
    this.missing.delete(key);
    // The record is put in place before the session is built: a server whose first write fails is reported from `changed()`,
    // which finds the tries this record holds and starts it again.
    const known = this.revivals.get(info.session);
    if (known) known.options = options;
    else this.revivals.set(info.session, { options, tries: 0 });
    const existing = this.bySession.get(info.session);
    if (!existing || existing.closed) {
      // A new session starts without the old errors, so what the last server wrote goes with it.
      this.logs.delete(info.session);
      this.bySession.set(info.session, new Session(this.context, info, () => this.changed()));
    }
    this.byFile.set(key, info.session);
    this.changed();
  }

  // The session a file is recorded against, closed ones included: the dot reads why a stopped one stopped.
  private sessionOf(key: string) {
    const named = this.byFile.get(key);
    return named ? this.bySession.get(named) : undefined;
  }

  // The session a file speaks to. A session that was replaced by a new server answers with the new one, so a file that
  // stayed open keeps jumping.
  session(options: OpenOptions) {
    const found = this.sessionOf(this.keyOf(options));
    return found && !found.closed ? found : undefined;
  }

  // The session a file speaks to, waiting for the view that opens it: the picker asks about a file whose server the page is
  // starting, and a request sent before that opening lands on a server nobody has told to start.
  private async waitForSession(options: OpenOptions) {
    const ready = this.session(options);
    if (ready) return ready;
    return new Promise<Session | undefined>((resolve) => {
      // Five seconds of nothing is taken as the answer of a file no server ever came up for.
      const stop = this.subscribe(() => {
        const found = this.session(options);
        if (!found) return;
        clearTimeout(timer);
        stop();
        resolve(found);
      });
      const timer = setTimeout(() => { stop(); resolve(this.session(options)); }, 5000);
    });
  }

  // The symbols a file's server lists for it, as `outline` reads them: a file no server serves lists none.
  async symbols(options: OpenOptions): Promise<FileSymbol[]> {
    const found = await this.waitForSession(options);
    if (!found) return [];
    const ask = () => found.request<ServerSymbol[] | null>('textDocument/documentSymbol', { textDocument: { uri: uriOf(options.path) } }).catch(() => undefined);
    // An empty list is the only answer still saying the document is not read yet, and a session that stopped answers nothing
    // more.
    const answer = await reask(ask, (symbols) => found.closed || (Array.isArray(symbols) && symbols.length > 0), 10);
    return Array.isArray(answer) ? outline(answer) : [];
  }

  // Where a file's server puts the thing named at a position of that file: a definition, an implementation, a type
  // definition, or every reference.
  async locations(options: OpenOptions, line: number, character: number, feature: LocationFeature): Promise<Target[]> {
    const found = await this.waitForSession(options);
    if (!found) return [];
    const extra = feature === 'references' ? { context: { includeDeclaration: true } } : {};
    const ask = async () => {
      const result = await found.request<unknown>(features[feature].method, {
        textDocument: { uri: uriOf(options.path) }, position: { line, character }, ...extra,
      }).catch(() => undefined);
      const listed = Array.isArray(result) ? result : result ? [result] : [];
      return listed.map((item: { uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range }) => {
        const range = item.targetSelectionRange ?? item.range ?? { start: { line: 0, character: 0 } };
        return { path: pathOf(item.targetUri ?? item.uri ?? uriOf(options.path)), line: range.start.line + 1, column: range.start.character + 1 };
      });
    };
    // A jump only names this file while the server has not read the program yet: it answers with the import a name came in
    // through, and a short round of asking again is worth the wait. What a file declares of its own keeps answering so, and a
    // list of references is not judged at all.
    return reask(ask, (targets) => found.closed || feature === 'references' || targets.some((target) => target.path !== options.path), 3);
  }

  // What a session is doing, as the dot reads it.
  private describe(recorded: Session): ServiceStatus {
    return { server: recorded.info.server, root: recorded.info.root, state: recorded.state, error: recorded.error, log: this.logs.get(recorded.info.session) };
  }

  // What the status dot shows for one file: the service behind it — the server its session runs, or the reason none does.
  status(options: OpenOptions): ServiceStatus | undefined {
    const key = this.keyOf(options);
    const recorded = this.sessionOf(key);
    if (recorded && !recorded.closed) return this.describe(recorded);
    const missing = this.missing.get(key);
    // The binary's own name is not known here — it was never found — so the dot names the language instead.
    if (missing) return { server: missing.language, state: 'missing', error: missing.error };
    // A session that stopped shows why; a file no server is opened for shows nothing at all.
    return recorded && this.describe(recorded);
  }

  // Starts the server behind this file: a running session is dropped first, while a file with no server behind it — one
  // that never came up, or one whose tries are spent — is simply started.
  async restart(options: OpenOptions) {
    const found = this.session(options);
    if (found) await this.letGo(found, '语言服务已重启');
    await this.open(options);
  }

  // Starts the server behind a session again: the one that went away is let go like any other, and a new one takes its
  // place.
  private async revive(session: string, gone: Session) {
    const revival = this.revivals.get(session);
    if (!revival || this.reviving.has(session)) return;
    this.reviving.add(session);
    try {
      // A server that stayed up long enough was not the one that kept dying, so the tries it cost are given back.
      if (gone.upSince !== undefined && Date.now() - gone.upSince >= healthyFor) revival.tries = 0;
      await this.letGo(gone);
      for (const wait of reviveWaits.slice(revival.tries)) {
        revival.tries++;
        await new Promise((resolve) => setTimeout(resolve, wait));
        // The view may have gone while this waited, and a server nobody needs is not started.
        if (!this.revivals.has(session)) return;
        await this.open(revival.options, false);
        const revived = this.bySession.get(session);
        if (revived && !revived.closed) return;
      }
    } finally {
      this.reviving.delete(session);
    }
  }

  // The window lets a server go: it is retired, so its stop is not taken for a failure, and then closed on the node. A
  // session that stopped by itself keeps the reason it stopped for, so only a running one is told why it is going.
  private async letGo(found: Session, reason?: string) {
    found.retired = true;
    if (reason) found.stop(reason);
    await this.context.ui.request('lsp-close', { session: found.info.session }).catch(() => undefined);
  }

  async closeUnused(openFiles: FileClick[]) {
    for (const [session, running] of [...this.bySession]) {
      // What keeps a server alive is a file opened on it, which each file says for itself: a file of a nested root belongs to
      // the server of that root, not to the one whose directory happens to hold it too.
      if (openFiles.some((file) => this.byFile.get(this.keyOf(file)) === session)) continue;
      for (const [key, named] of [...this.byFile]) if (named === session) this.byFile.delete(key);
      this.bySession.delete(session);
      this.logs.delete(session);
      this.revivals.delete(session);
      await this.letGo(running, '语言服务已关闭');
    }
    this.notify();
  }

  dispose() {
    for (const dispose of this.off) dispose();
  }
}
