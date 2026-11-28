import { invertedEffects } from '@codemirror/commands';
import { ChangeSet, MapMode, StateEffect, StateField, Text, Transaction, type ChangeDesc, type ChangeSpec } from '@codemirror/state';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { fileKey, type FileClick } from '../shared';
import { diskChanges, mergeLines, preservesWrite } from './merge';

export const boundedCache = <V>(ceiling: number) => {
  const entries = new Map<string, V>();
  return {
    get: (key: string) => entries.get(key),
    take: (key: string) => {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
    set: (key: string, value: V) => {
      entries.delete(key);
      entries.set(key, value);
      const oldest = entries.keys().next().value;
      if (entries.size > ceiling && oldest !== undefined) entries.delete(oldest);
    },
  };
};

export const watch = (context: UiContext, machine: FileClick['machine'], paths: string[], refresh: () => void) => {
  const holder = crypto.randomUUID();
  const keys = new Set(paths.map(path => fileKey({ machine, path })));
  const setActive = (path: string, active: boolean) =>
    context.ui.request('watch', { holder, machine, path, active }).then(() => true, () => false);
  const off = context.ui.subscribe<string>('changed', (changed) => { if (keys.has(changed)) refresh(); });
  const registrations = new Map<string, Promise<boolean>>();
  const register = (path: string) => {
    const attempt = setActive(path, true);
    registrations.set(path, attempt);
    void attempt.then(active => {
      if (!active || registrations.get(path) !== attempt) return;
      // The initial snapshot can predate this watch, even if it reported a missing file.
      registrations.delete(path);
      refresh();
    });
  };
  for (const path of paths) register(path);
  return {
    retry() {
      for (const [path, attempt] of registrations) void attempt.then(active => {
        if (!active && registrations.get(path) === attempt) register(path);
      });
    },
    close() {
      registrations.clear();
      off();
      for (const path of paths) void setActive(path, false);
    },
  };
};

const saveDelay = 500;
type Listener = (notice?: string) => void;
type Reader = { notify: Listener; endings: string[]; pending?: ChangeSet };
const delimiters = ['\n', '\r\n', '\r'];
const restoreEndings = StateEffect.define<{ undo: ChangeSet; before?: ChangeDesc }>();

// Vim can group two deletions across a peer edit. Keep the intervening changes in line coordinates.
const peerLines = StateField.define<ChangeDesc | undefined>({
  create: () => undefined,
  update(previous, tr) {
    if (!tr.docChanged) return previous;
    const changes: ChangeSpec[] = [];
    tr.changes.iterChanges((from, to, _fromB, _toB, insert) => {
      const start = tr.startState.doc.lineAt(from).number - 1, end = tr.startState.doc.lineAt(to).number - 1;
      if (start !== end || insert.lines > 1) changes.push({ from: start, to: end, insert: ' '.repeat(insert.lines - 1) });
    });
    if (!changes.length) return previous;
    if (tr.annotation(Transaction.addToHistory) !== false) return undefined;
    const rows = ChangeSet.of(changes, tr.startState.doc.lines - 1).desc;
    return previous ? previous.composeDesc(rows) : rows;
  },
});

function lineEndings(raw: string, fallback: string) {
  if (!raw.includes('\r')) return [raw.includes('\n') ? '\n' : fallback];
  const ends = raw.match(/\r\n?|\n/g)!;
  return ends.every(end => end === ends[0]) ? [ends[0]] : ends;
}

// Keep line endings attached to their original positions, including identical lines with different delimiters.
function mapEndings(endings: string[], doc: Text, changes: ChangeSet, inserted: string[] = []) {
  if (endings.length === 1 && !inserted.length) return endings;
  const result: string[] = [];
  let row = 0, added = 0;
  changes.iterChanges((from, to, _fromB, _toB, insert) => {
    const start = doc.lineAt(from).number - 1, end = doc.lineAt(to).number - 1;
    while (row < start) result.push(endings[row++] ?? endings[0]);
    for (let i = 0; i < insert.lines - 1; i++) {
      result.push(inserted[added++] ?? endings[Math.min(start + i, end)] ?? endings[endings.length - 1]);
    }
    row = end;
  });
  while (row < doc.lines - 1) result.push(endings[row++] ?? endings[0]);
  return result.length && !result.every(end => end === result[0]) ? result : [result[0] ?? endings[0]];
}

function withEndings(text: string, endings: string[]) {
  if (endings.length === 1) return endings[0] === '\n' ? text : text.replace(/\n/g, endings[0]);
  let row = 0, previous = -2;
  return text.replace(/\n/g, (_break, at) => {
    const ending = endings[row++];
    // Adjacent CR and LF would reopen as a single line break. Keep the empty line on disk.
    const paired = at === previous + 1 && endings[row - 2] === '\r' && ending === '\n';
    previous = at;
    return paired ? '\r\n' : ending;
  });
}

type DiskRevision = { raw: string; edits: ChangeSet };

function mergeDiskChanges(base: DiskRevision, local: string, disk: string, external: ChangeSet) {
  const merged = mergeLines(base.raw, local, disk, base.edits, external);
  const raw = withEndings(merged.text, merged.endings);
  return { ...merged, raw, edits: diskChanges(disk, raw, base.edits.map(external)), incoming: diskChanges(local, raw, external.map(base.edits, true)) };
}

class FileBuffer {
  text?: string;
  readError = '';
  private raw?: string;
  private bom = '';
  private disk?: DiskRevision;
  private endings = ['\n'];
  private unconfirmed?: DiskRevision & { written: ChangeSet };
  private timer?: ReturnType<typeof setTimeout>;
  private io = Promise.resolve();
  private queued?: 'always' | 'dirty';
  private readers = new Set<Reader>();
  private subscription?: ReturnType<typeof watch>;

  constructor(private context: UiContext, private file: FileClick, private idle: (file: FileBuffer) => void) {}

  get dirty() { return this.unconfirmed !== undefined || this.raw !== this.disk?.raw; }

  attach(listener: Listener) {
    const reader: Reader = { notify: listener, endings: this.endings };
    this.readers.add(reader);
    if (this.readers.size === 1) {
      this.subscription = watch(this.context, this.file.machine, [this.file.path], () => void this.read());
    }
    void this.read();
    return {
      buffer: this,
      history: [peerLines, invertedEffects.of(tr => {
        // One digit per line break lets CodeMirror compose grouped edits without losing a separator.
        const inverse: ChangeSpec[] = [];
        const endings = reader.pending ? reader.endings : this.endings;
        tr.changes.iterChanges((from, to, fromB, _toB, insert) => {
          const start = tr.startState.doc.lineAt(from).number - 1, end = tr.startState.doc.lineAt(to).number - 1;
          if (start === end && insert.lines === 1) return;
          let codes = '';
          for (let row = start; row < end; row++) codes += delimiters.indexOf(endings[row] ?? endings[0]);
          const at = tr.newDoc.lineAt(fromB).number - 1;
          inverse.push({ from: at, to: at + insert.lines - 1, insert: codes });
        });
        return inverse.length ? [restoreEndings.of({ undo: ChangeSet.of(inverse, tr.newDoc.lines - 1), before: tr.startState.field(peerLines) })] : [];
      })],
      takeChanges: () => {
        const changes = reader.pending;
        reader.pending = undefined;
        reader.endings = this.endings;
        return changes;
      },
      edit: (tr: Transaction) => {
        let inverse: ChangeSet | undefined;
        let intervening: ChangeDesc | undefined;
        for (const effect of tr.effects) {
          if (!effect.is(restoreEndings)) continue;
          const { undo, before } = effect.value;
          const mapped = intervening ? undo.map(intervening) : undo;
          inverse = inverse ? inverse.compose(mapped) : mapped;
          const prior: ChangeDesc | undefined = intervening?.mapDesc(undo, true);
          intervening = before && prior ? before.composeDesc(prior) : before ?? prior;
        }
        // Peer edits can move an undo's insertions, but preserve the order of their contents.
        const restored: string[] = [];
        inverse?.iterChanges((_from, _to, _fromB, _toB, codes) => {
          for (const code of codes.toString()) restored.push(delimiters[Number(code)]);
        });
        reader.endings = mapEndings(reader.pending ? reader.endings : this.endings, tr.startState.doc, tr.changes, restored);
        // Compose the actual transactions. Identical characters can be inserted at distinct positions.
        let changes = tr.changes;
        let doc = tr.newDoc;
        if (reader.pending) {
          changes = tr.changes.map(reader.pending);
          reader.pending = reader.pending.map(tr.changes, true);
          const before = Text.of(this.text!.split('\n'));
          doc = changes.apply(before);
          this.endings = mapEndings(this.endings, before, changes, restored);
        } else this.endings = reader.endings;
        this.text = doc.toString();
        this.raw = withEndings(this.text, this.endings);
        for (const base of [this.disk, this.unconfirmed]) {
          if (base) base.edits = this.raw === base.raw ? ChangeSet.empty(doc.length) : base.edits.compose(changes);
        }
        this.sendChanges(changes, reader);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), saveDelay);
        this.changed();
      },
      close: () => {
        this.readers.delete(reader);
        if (!this.readers.size) { this.subscription?.close(); this.subscription = undefined; }
        const saved = this.flush();
        return saved.then(() => {
          if (!this.readers.size && !this.dirty && this.io === saved) this.idle(this);
        });
      },
    };
  }

  private changed(notice?: string) {
    for (const reader of this.readers) reader.notify(notice);
  }

  private sendChanges(changes: ChangeSet, source?: Reader) {
    for (const reader of this.readers) {
      if (reader !== source) reader.pending = reader.pending ? reader.pending.compose(changes) : changes;
    }
  }

  private async write(missing = false) {
    const raw = this.raw;
    if (this.timer !== undefined || raw === undefined || (!missing && raw === this.disk?.raw)) return;
    const saving = this.unconfirmed = { raw, edits: ChangeSet.empty(this.text!.length), written: this.disk!.edits };
    let notice = '';
    try {
      const { machine, path } = this.file;
      await this.context.ui.request('write', { machine, path, text: this.bom + raw });
      this.disk = saving;
      this.unconfirmed = undefined;
      this.readError = '';
      this.subscription?.retry();
    } catch (error) {
      // The node may have written the bytes before its acknowledgement was lost.
      notice = (error as Error).message;
    }
    this.changed(notice);
  }

  // Compare the latest edit to the disk after earlier I/O has settled, including a write still in flight on tab close.
  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.read('dirty');
  }

  read(when: 'always' | 'dirty' = 'always') {
    if (this.queued) {
      if (when === 'always') this.queued = when;
      return this.io;
    }
    this.queued = when;
    this.io = this.io.then(() => {
      const needed = this.queued === 'always' || this.dirty;
      this.queued = undefined;
      if (needed) return this.readDisk();
    });
    return this.io;
  }

  private async readDisk() {
    let content: string;
    try {
      const raw = await this.context.ui.request<string | { missing: string }>('read', this.file);
      if (typeof raw !== 'string') {
        this.readError = raw.missing;
        this.changed();
        if (this.dirty) await this.write(true);
        return;
      }
      this.bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
      content = raw.slice(this.bom.length);
    } catch (error) {
      this.readError = (error as Error).message;
      this.changed();
      return;
    }
    this.readError = '';
    this.subscription?.retry();
    const before = this.disk;
    const next = content.replace(/\r\n?/g, '\n');
    // A read that includes the unacknowledged write lets us replay just the edits made since it.
    const attempted = this.unconfirmed;
    let base = before, external: ChangeSet | undefined;
    if (before && attempted && content !== before.raw) {
      if (content === attempted.raw) base = attempted;
      else {
        const sinceWrite = diskChanges(attempted.raw, content);
        if (preservesWrite(before.raw, attempted.raw, content, attempted.written, sinceWrite)) {
          base = attempted;
          external = sinceWrite;
        } else {
          external = diskChanges(before.raw, content);
          const merged = mergeLines(before.raw, attempted.raw, content, attempted.written, external);
          if (withEndings(merged.text, merged.endings) === content) {
            base = attempted;
            external = sinceWrite;
          }
        }
      }
    }
    if (base?.raw === content) this.disk = base;
    else {
      const merged = base && this.raw !== undefined && this.raw !== base.raw && this.raw !== content
        ? mergeDiskChanges(base, this.raw, content, external ?? diskChanges(base.raw, content)) : undefined;
      const text = merged?.text ?? next;
      const raw = merged?.raw ?? content;
      const endings = merged?.endings ?? lineEndings(raw, this.endings[0]);
      if (this.raw !== undefined) {
        const incoming = merged?.incoming ?? diskChanges(this.raw, raw);
        if (text !== this.text) this.sendChanges(incoming);
        // An unchanged LF after a bare CR was written as CRLF to retain the empty line.
        if (this.raw.includes('\r\r\n') && raw.includes('\r\r\n')) {
          const oldDoc = Text.of(this.text!.split('\n')), doc = Text.of(text.split('\n'));
          const back = incoming.invertedDesc;
          for (let row = 1; row < endings.length; row++) {
            if (endings[row - 1] !== '\r' || endings[row] !== '\r\n') continue;
            const line = doc.line(row + 1);
            if (line.length) continue;
            const pos = back.mapPos(line.to, 1, MapMode.TrackAfter);
            if (pos !== null && this.endings[oldDoc.lineAt(pos).number - 1] === '\n') endings[row] = '\n';
          }
        }
      }
      this.text = text;
      this.endings = endings;
      this.raw = raw;
      this.disk = { raw: content, edits: merged?.edits ?? ChangeSet.empty(next.length) };
    }
    this.unconfirmed = undefined;
    this.changed(content === before?.raw ? undefined : '');
    await this.write();
  }
}

export type OpenFile = ReturnType<FileBuffer['attach']>;

export function fileBuffers(context: UiContext) {
  const open = new Map<string, FileBuffer>();
  const recent = boundedCache<FileBuffer>(50);
  return (file: FileClick, listener: Listener) => {
    const key = fileKey(file);
    const buffer = open.get(key) ?? recent.take(key) ?? new FileBuffer(context, file, (closed) => {
      open.delete(key);
      recent.set(key, closed);
    });
    open.set(key, buffer);
    return buffer.attach(listener);
  };
}
