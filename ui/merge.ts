import { diff } from '@codemirror/merge';
import { ChangeSet, MapMode, Text, type ChangeSpec } from '@codemirror/state';
import { diffIndices, merge } from 'node-diff3';

const diffOptions = { scanLimit: 256, timeout: 40 };

export function changesBetween(current: string, next: string) {
  return ChangeSet.of(diff(current, next, diffOptions).map(({ fromA, toA, fromB, toB }) => ({
    from: fromA, to: toA, insert: next.slice(fromB, toB),
  })), current.length);
}

export function diskChanges(before: string, after: string, known?: ChangeSet) {
  // NUL is rejected by the file reader. CRLF occupies one editor column and remains distinct from CR and LF.
  const a = before.replace(/\r\n/g, '\0'), b = after.replace(/\r\n/g, '\0');
  const contents = after.replace(/\r\n?/g, '\n');
  const edits: ChangeSpec[] = [];
  if (known && known.length === a.length && known.newLength === b.length) {
    let matches = true;
    known.iterGaps((from, next, length) => {
      if (a.slice(from, from + length) !== b.slice(next, next + length)) matches = false;
    });
    if (matches) {
      known.iterChangedRanges((from, to, start, end) => {
        if (a.slice(from, to) !== b.slice(start, end)) edits.push({ from, to, insert: contents.slice(start, end) });
      }, true);
      return ChangeSet.of(edits, a.length);
    }
  }
  // Keep entire matching physical lines before comparing characters inside the changed region.
  const rows = (raw: string) => raw.match(/[^\r\n\0]*[\r\n\0]|[^\r\n\0]+$/g) ?? [];
  const left = rows(a), right = rows(b);
  let first = 0, lastA = left.length, lastB = right.length;
  while (first < lastA && first < lastB && left[first] === right[first]) first++;
  while (lastA > first && lastB > first && left[lastA - 1] === right[lastB - 1]) {
    lastA--;
    lastB--;
  }
  const original = Text.of(before.split(/\r\n?|\n/)), next = Text.of(after.split(/\r\n?|\n/));
  for (const block of diffIndices(left.slice(first, lastA), right.slice(first, lastB))) {
    const rowA = first + block.buffer1[0], rowB = first + block.buffer2[0];
    const startA = rowA < original.lines ? original.line(rowA + 1).from : original.length;
    const startB = rowB < next.lines ? next.line(rowB + 1).from : next.length;
    for (const change of diff(block.buffer1Content.join(''), block.buffer2Content.join(''), diffOptions)) {
      edits.push({ from: startA + change.fromA, to: startA + change.toA, insert: contents.slice(startB + change.fromB, startB + change.toB) });
    }
  }
  return ChangeSet.of(edits, a.length);
}

type Row = { text: string; end: string };
type LineEdit = { from: number; to: number; rows: Row[]; side: 0 | 1 };

// diff3 compares tokens by identity. Equal physical lines must share a row.
function physicalRow(known: Map<string, Row>, text: string, end: string) {
  const bytes = text + end;
  let row = known.get(bytes);
  if (!row) { row = { text, end }; known.set(bytes, row); }
  return row;
}

function documentLines(raw: string, known: Map<string, Row>) {
  const text = raw.split(/\r\n?|\n/);
  const ends = raw.match(/\r\n?|\n/g) ?? [];
  const rows = text.map((text, i) => physicalRow(known, text, ends[i] ?? ''));
  return { doc: Text.of(text), rows };
}

type Lines = ReturnType<typeof documentLines>;

function lineEdits(original: Lines, next: Lines, changes: ChangeSet, side: 0 | 1) {
  const ranges: { from: number; to: number; nextFrom: number; nextTo: number; prefix: boolean }[] = [];
  changes.iterChangedRanges((from, to, fromB, toB) => {
    const first = original.doc.lineAt(from), nextFirst = next.doc.lineAt(fromB);
    const last = original.doc.lineAt(to), nextLast = next.doc.lineAt(toB);
    // A whole-line deletion leaves the next row outside the edit, even when it has identical text.
    const boundary = to === last.from && toB === nextLast.from ? 1 : 0;
    const end = last.number - boundary, nextEnd = nextLast.number - boundary;
    const previous = ranges[ranges.length - 1];
    if (previous && (first.number - 1 < previous.to || nextFirst.number - 1 < previous.nextTo)) {
      previous.to = end;
      previous.nextTo = nextEnd;
    } else ranges.push({ from: first.number - 1, to: end, nextFrom: nextFirst.number - 1, nextTo: nextEnd, prefix: from > first.from });
  }, true);

  const result: LineEdit[] = [];
  for (let { from, to, nextFrom, nextTo, prefix } of ranges) {
    // If the first row was fully erased, its surviving suffix and delimiter identify the correct duplicate.
    if (!prefix) {
      while (from < to && nextFrom < nextTo && original.rows[to - 1] === next.rows[nextTo - 1]) { to--; nextTo--; }
    }
    while (from < to && nextFrom < nextTo && original.rows[from].text === next.rows[nextFrom].text) {
      if (original.rows[from].end !== next.rows[nextFrom].end) result.push({ from, to: from + 1, rows: [next.rows[nextFrom]], side });
      from++; nextFrom++;
    }
    while (from < to && nextFrom < nextTo && original.rows[to - 1].text === next.rows[nextTo - 1].text) {
      to--; nextTo--;
      if (original.rows[to].end !== next.rows[nextTo].end) result.push({ from: to, to: to + 1, rows: [next.rows[nextTo]], side });
    }
    if (to - from === nextTo - nextFrom) {
      // A multiline replacement can still merge independently on each corresponding row.
      for (let i = from; i < to; i++) {
        const row = next.rows[nextFrom + i - from];
        if (row !== original.rows[i]) result.push({ from: i, to: i + 1, rows: [row], side });
      }
    } else result.push({ from, to, rows: next.rows.slice(nextFrom, nextTo), side });
  }
  return result;
}

// Resolve only intersecting line edits. Each selected row carries its own source delimiter through conflicts.
export function mergeLines(before: string, ours: string, theirs: string, localEdits: ChangeSet, diskEdits: ChangeSet) {
  const known = new Map<string, Row>();
  const original = documentLines(before, known), local = documentLines(ours, known), disk = documentLines(theirs, known);
  const fallback = disk.rows[0].end || local.rows[0].end || '\n';
  const rowEdits = () => lineEdits(original, local, localEdits, 0).concat(lineEdits(original, disk, diskEdits, 1));
  let edits = rowEdits(), inherited = false;
  // A retained newline can move to another row in a paste. Merge its physical format at its mapped character.
  for (const edit of edits) {
    if (edit.to !== edit.from + 1 || edit.rows.length !== 1) continue;
    const base = original.rows[edit.from], ending = edit.rows[0].end;
    if (!base.end || !ending || base.end === ending) continue;
    const peer = edit.side === 0 ? disk : local;
    const changes = edit.side === 0 ? diskEdits : localEdits;
    const pos = changes.mapPos(original.doc.line(edit.from + 1).to, 1, MapMode.TrackAfter);
    if (pos === null) continue;
    const at = peer.doc.lineAt(pos).number - 1;
    if (peer.rows[at].end !== base.end) continue;
    original.rows[edit.from] = physicalRow(known, base.text, ending);
    peer.rows[at] = physicalRow(known, peer.rows[at].text, ending);
    inherited = true;
  }
  if (inherited) edits = rowEdits();
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  const chunks: Row[][] = [];
  let cursor = 0;
  for (let i = 0; i < edits.length;) {
    const first = i, start = edits[i].from;
    let end = edits[i++].to;
    while (i < edits.length && (edits[i].from < end || (end === start && edits[i].from === start && edits[i].to === start))) {
      end = Math.max(end, edits[i++].to);
    }
    chunks.push(original.rows.slice(cursor, start));
    if (i === first + 1) chunks.push(edits[first].rows);
    else {
      const base = original.rows.slice(start, end);
      const sides = [base, base];
      for (let j = i - 1; j >= first; j--) {
        const { from, to, rows, side } = edits[j];
        sides[side] = sides[side].slice(0, from - start).concat(rows, sides[side].slice(to - start));
      }
      const [a, b] = sides;
      if (a === base) chunks.push(b);
      else if (b === base) chunks.push(a);
      else if (a.length === b.length && a.every((r, n) => r.text === b[n].text)) {
        chunks.push(a.map((row, n) => ({ text: row.text, end: b[n].end === base[n]?.end ? row.end : b[n].end })));
      } else if (a.length === 1 && b.length === 1 && base.length === 1 && (a[0].text === base[0].text || b[0].text === base[0].text)) {
        chunks.push([{ text: a[0].text === base[0].text ? b[0].text : a[0].text, end: b[0].end === base[0].end ? a[0].end : b[0].end }]);
      } else {
        const markerEnd = base[0]?.end || a[0]?.end || b[0]?.end || fallback;
        const merged = merge(a, base, b, { label: { a: '编辑器', b: '磁盘' } });
        chunks.push(merged.result.map(row => typeof row === 'string' ? { text: row, end: markerEnd } : row));
      }
    }
    cursor = end;
  }
  chunks.push(original.rows.slice(cursor));
  const rows = chunks.flat();
  const endings = rows.slice(0, -1).map(row => row.end || fallback);
  return { text: rows.map(row => row.text).join('\n'), endings: endings.length ? endings : [fallback] };
}

// A lost reply can be followed by another disk edit. Check whether it left the bytes written by us in place.
export function preservesWrite(before: string, written: string, current: string, changes: ChangeSet, sinceWrite: ChangeSet) {
  const known = new Map<string, Row>();
  const base = documentLines(before, known), saved = documentLines(written, known);
  const undo = lineEdits(saved, base, changes.invert(base.doc), 0);
  const later = lineEdits(saved, documentLines(current, known), sinceWrite, 1);
  return undo.every(edit => {
    let { from, to } = edit;
    // In a run of identical rows, either end can be reported as the insertion point of the omitted copy.
    const copies = new Set(saved.rows.slice(from, to).concat(edit.rows).map(row => row.text));
    while (from && copies.has(saved.rows[from - 1].text)) from--;
    while (to < saved.rows.length && copies.has(saved.rows[to].text)) to++;
    if (edit.from === edit.to) {
      // A later edit may change a surviving row or bring back the exact bytes that were deleted.
      return later.every(change => {
        if (change.to < from || change.from > to) return true;
        const old = saved.rows.slice(change.from, change.to);
        if (change.rows.length > old.length) return false;
        return edit.rows.every(deleted => change.rows.filter(row => row === deleted).length <= old.filter(row => row === deleted).length);
      });
    }
    return later.every(change => change.from === change.to
      ? change.to < from || change.from > to : change.to <= from || change.from >= to);
  });
}
