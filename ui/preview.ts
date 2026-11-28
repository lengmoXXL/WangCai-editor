import { forceParsing, syntaxTree } from '@codemirror/language';
import { Compartment, EditorSelection, Facet, RangeSet, StateField, type EditorState, type Range, type Text } from '@codemirror/state';
import { NodeWeakMap, type SyntaxNode } from '@lezer/common';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutterLineClass, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from '@codemirror/commands';
import { common, createLowlight } from 'lowlight';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import { directoryOf, type FileClick, type ImageBytes } from '../shared';

// Markdown image paths refer to the machine hosting the file.
type PreviewImageSource = (url: string) => Promise<string>;
const previewImageSource = Facet.define<PreviewImageSource>();
// Short documents fill the pane even when an image grows. A theme change forces CodeMirror to measure individual lines.
const imageLayout = new Compartment();
const imageTheme = EditorView.theme({});
class RuleWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-md-rule';
    return el;
  }
  eq() { return true; }
}

class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly url: string, readonly source: PreviewImageSource) { super(); }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';
    const picture = (src: string) => {
      const img = document.createElement('img');
      img.alt = this.alt;
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        if (img.isConnected) view.dispatch({ effects: imageLayout.reconfigure(imageLayout.get(view.state) === imageTheme ? [] : imageTheme) });
      });
      img.src = src;
      return img;
    };
    if (/^https?:\/\//i.test(this.url)) {
      wrap.appendChild(picture(this.url));
      return wrap;
    }
    wrap.classList.add('cm-md-image-local');
    const label = document.createElement('span');
    label.className = 'cm-md-image-label';
    label.textContent = '图片';
    const name = document.createElement('span');
    name.className = 'cm-md-image-name';
    name.textContent = this.alt || this.url;
    wrap.append(label, name);
    this.source(this.url)
      .then((src) => {
        if (!wrap.isConnected) return;
        wrap.replaceChildren(picture(src));
        wrap.classList.remove('cm-md-image-local');
      })
      .catch(() => {
        if (!wrap.isConnected) return;
        wrap.classList.add('cm-md-image-missing');
        wrap.title = '无法加载图片';
      });
    return wrap;
  }
  eq(other: ImageWidget) { return other.alt === this.alt && other.url === this.url; }
  ignoreEvent() { return false; }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-task';
    box.checked = this.checked;
    // The press must not take the caret.
    box.addEventListener('mousedown', (event) => event.preventDefault());
    const tick = () => {
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at, to: at + 3, insert: this.checked ? '[ ]' : '[x]' } });
    };
    box.addEventListener('click', tick);
    // The editor's own keys would eat Space before the box sees it, so the box answers Space itself.
    box.addEventListener('keydown', (event) => {
      if (event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      tick();
    });
    return box;
  }
  eq(other: TaskWidget) { return other.checked === this.checked; }
  ignoreEvent() { return false; }
}

type Seg = { text: string; cls?: string };

const inlineMark = (node: SyntaxNode): { cls: string; from: number; to: number; start: number; end: number } | null => {
  const cls = node.name === 'StrongEmphasis' ? 'cm-md-bold' : node.name === 'Emphasis' ? 'cm-md-italic'
    : node.name === 'Strikethrough' ? 'cm-md-strike' : node.name === 'InlineCode' ? 'cm-md-code' : undefined;
  if (cls) {
    const open = node.firstChild, close = node.lastChild;
    return open && close && open !== close ? { cls, from: open.to, to: close.from, start: open.from, end: close.to } : null;
  }
  if (node.name === 'Link') {
    const marks = node.getChildren('LinkMark');
    return marks.length >= 2 ? { cls: 'cm-md-link', from: marks[0].to, to: marks[1].from, start: node.from, end: node.to } : null;
  }
  return null;
};

// Use the same Lezer inline ranges for table cells and normal text.
const cellSegs = (cell: SyntaxNode, doc: Text): Seg[] => {
  const segs: Seg[] = [];
  let last = cell.from;
  const plain = (to: number) => { if (to > last) segs.push({ text: doc.sliceString(last, to) }); };
  cell.cursor().iterate((n) => {
    const m = inlineMark(n.node);
    if (!m) return;
    plain(m.start);
    segs.push({ text: doc.sliceString(m.from, m.to), cls: m.cls });
    last = m.end;
    return false;
  });
  plain(cell.to);
  return segs.map((s) => ({ ...s, text: s.text.replace(/\\\|/g, '|') }));
};

// CodeMirror hides the native selection inside a widget. A table drag selects cells and copies them as TSV.
let tablePick: { table: HTMLTableElement; clear: () => void } | undefined;

function selectCells(table: HTMLTableElement, first: HTMLTableCellElement) {
  tablePick?.clear();
  const events = new AbortController();
  const capture = { capture: true, signal: events.signal };
  const clear = () => {
    events.abort();
    for (const cell of table.querySelectorAll('.cm-md-table-picked')) cell.classList.remove('cm-md-table-picked');
    tablePick = undefined;
  };
  tablePick = { table, clear };

  const firstRow = (first.parentElement as HTMLTableRowElement).rowIndex;
  let rows: HTMLTableCellElement[][] = [];
  const selectTo = (cell: HTMLTableCellElement) => {
    const lastRow = (cell.parentElement as HTMLTableRowElement).rowIndex;
    const left = Math.min(first.cellIndex, cell.cellIndex), right = Math.max(first.cellIndex, cell.cellIndex);
    rows = [];
    for (const row of table.rows) {
      const inside = row.rowIndex >= Math.min(firstRow, lastRow) && row.rowIndex <= Math.max(firstRow, lastRow);
      const selected: HTMLTableCellElement[] = [];
      for (const member of row.cells) {
        const picked = inside && member.cellIndex >= left && member.cellIndex <= right;
        member.classList.toggle('cm-md-table-picked', picked);
        if (picked) selected.push(member);
      }
      if (inside) rows.push(selected);
    }
  };
  selectTo(first);
  const move = (event: MouseEvent) => {
    const over = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td, th') : null;
    if (over && table.contains(over)) selectTo(over);
  };
  window.addEventListener('mousemove', move, { signal: events.signal });
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true, signal: events.signal });
  document.addEventListener('copy', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData?.setData('text/plain', rows.map(row => row.map(cell => cell.textContent).join('\t')).join('\n'));
  }, capture);
  document.addEventListener('mousedown', (event) => {
    if (!table.contains(event.target as Node)) clear();
  }, capture);
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') return;
    if (!['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) clear();
  }, capture);
}

// Keep the source line boxes so vertical Vim motions can traverse a rendered table.
class TableWidget extends WidgetType {
  constructor(readonly rows: { header: boolean; cells: Seg[][] }[], readonly aligns: string[], readonly first: number) { super(); }
  toDOM() {
    const align = (d: string) => {
      const left = d.startsWith(':'), right = d.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    };
    const cell = (tag: 'th' | 'td', segs: Seg[], i: number) => {
      const el = document.createElement(tag);
      const a = align(this.aligns[i] || '');
      if (a) el.style.textAlign = a;
      for (const s of segs) {
        if (!s.cls) { el.appendChild(document.createTextNode(s.text)); continue; }
        const mark = document.createElement(s.cls === 'cm-md-code' ? 'code' : s.cls === 'cm-md-bold' ? 'strong' : s.cls === 'cm-md-italic' ? 'em' : 'span');
        mark.className = s.cls;
        mark.textContent = s.text;
        el.appendChild(mark);
      }
      return el;
    };
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    for (const row of this.rows) {
      const tr = document.createElement('tr');
      row.cells.forEach((segs, i) => tr.appendChild(cell(row.header ? 'th' : 'td', segs, i)));
      (row.header ? thead : tbody).appendChild(tr);
    }
    table.append(thead, tbody);
    table.addEventListener('mousedown', (event) => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>('td, th') : null;
      if (!cell || event.button !== 0) return;
      // Moving the editor caret into the table would replace the grid with source.
      event.preventDefault();
      event.stopPropagation();
      selectCells(table, cell);
    });
    return table;
  }
  destroy(dom: HTMLElement) { if (tablePick?.table === dom) tablePick.clear(); }
  eq(other: TableWidget) { return other.first === this.first && other.aligns.join() === this.aligns.join() && JSON.stringify(other.rows) === JSON.stringify(this.rows); }
}

class FrontmatterWidget extends WidgetType {
  readonly first = 1;
  constructor(readonly text: string) { super(); }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-md-frontmatter';
    for (const raw of this.text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const row = document.createElement('div');
      row.className = 'cm-md-frontmatter-row';
      const pair = /^([^:#][^:]*):\s*(.*)$/.exec(line);
      if (pair) {
        const key = document.createElement('span');
        key.className = 'cm-md-frontmatter-key';
        key.textContent = pair[1].trim();
        const value = document.createElement('span');
        value.className = 'cm-md-frontmatter-value';
        const rest = pair[2].trim();
        if (rest.startsWith('[') && rest.endsWith(']')) {
          for (const item of rest.slice(1, -1).split(',')) {
            const chip = item.trim();
            if (!chip) continue;
            const el = document.createElement('span');
            el.className = 'cm-md-frontmatter-item';
            el.textContent = chip;
            value.appendChild(el);
          }
        } else {
          value.textContent = rest;
        }
        row.append(key, value);
      } else {
        row.textContent = line;
      }
      box.appendChild(row);
    }
    return box;
  }
  eq(other: FrontmatterWidget) { return other.text === this.text; }
}

const lowlight = createLowlight(common);
type Hast = { type: string; value?: string; properties?: { className?: string[] }; children?: Hast[] };
const spanCache = new NodeWeakMap<{ cls: string; from: number; to: number }[]>();
// A selection change redraws the preview without changing its parsed code blocks.
function codeSpans(block: SyntaxNode, language: string, doc: Text, parts: SyntaxNode[]) {
  if (!parts.length || !language || !lowlight.registered(language)) return [];
  const hit = spanCache.get(block);
  if (hit) return hit;
  const spans: { cls: string; from: number; to: number }[] = [];
  // Quotes and lists can split a single fenced program into disjoint source ranges.
  let part = 0, at = parts[0].from;
  const walk = (node: Hast, cls?: string) => {
    if (node.type === 'text') {
      let left = (node.value ?? '').length;
      while (left && part < parts.length) {
        const len = Math.min(left, parts[part].to - at);
        if (cls && len) spans.push({ cls, from: at - block.from, to: at + len - block.from });
        left -= len;
        at += len;
        if (at === parts[part].to) at = parts[++part]?.from ?? at;
      }
    } else for (const child of node.children ?? []) walk(child, node.properties?.className?.join(' ') ?? cls);
  };
  walk(lowlight.highlight(language, parts.map(p => doc.sliceString(p.from, p.to)).join('')) as Hast);
  spanCache.set(block, spans);
  return spans;
}


class CodeLangWidget extends WidgetType {
  constructor(readonly language: string) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-md-code-lang';
    el.textContent = this.language;
    return el;
  }
  eq(other: CodeLangWidget) { return other.language === this.language; }
}

const headingSize = /^ATXHeading([1-6])$/;

const activeLines = (state: EditorState): Set<number> => {
  const doc = state.doc;
  const active = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let l = doc.lineAt(range.from).number; l <= doc.lineAt(range.to).number; l += 1) active.add(l);
  }
  return active;
};
const rangeRevealed = (active: Set<number>, doc: Text, from: number, to: number): boolean => {
  for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l += 1) if (active.has(l)) return true;
  return false;
};

function render(state: EditorState, from: number, to: number): DecorationSet {
  const doc = state.doc;
  const loadImage = state.facet(previewImageSource)[0];
  const active = activeLines(state);
  const revealed = (from: number, to: number) => rangeRevealed(active, doc, from, to);

  const ranges: Range<Decoration>[] = [];
  const mark = (from: number, to: number, cls: string) => {
    if (from < to) ranges.push({ from, to, value: Decoration.mark({ class: cls }) });
  };
  // A ViewPlugin may replace inline text, but CodeMirror owns the line breaks for viewport layout.
  const replace = (from: number, to: number, widget?: WidgetType) => {
    while (from < to) {
      const end = Math.min(doc.lineAt(from).to, to);
      if (from < end) {
        ranges.push({ from, to: end, value: Decoration.replace({ widget }) });
        widget = undefined;
      }
      from = end + 1;
    }
  };
  // Markup is dimmed where it shows and taken away where it does not: the line being edited keeps it, the rest reads clean.
  const syntax = (from: number, to: number, widget?: WidgetType) => {
    if (from >= to) return;
    mark(from, to, 'cm-md-syntax');
    if (!revealed(from, to)) replace(from, to, widget);
  };
  const line = (pos: number, cls: string) => ranges.push({ from: pos, to: pos, value: Decoration.line({ class: cls }) });

  // A note may open with YAML frontmatter: a leading --- closed by a --- of its own. The parser reads that as a rule and
  // a heading, so it is taken over here — the caret inside reads it as source, outside the lines collapse and a
  // properties block draws. A leading rule followed by prose is not frontmatter, so the first body line must name a key.
  let fmLast = 0;
  if (doc.lines >= 2 && doc.line(1).text.trim() === '---') {
    for (let l = 2; l <= doc.lines; l++) {
      const t = doc.line(l).text.trim();
      if (t === '---') { fmLast = l; break; }
    }
    if (fmLast > 2) {
      const first = doc.line(2).text.trim();
      if (!first.includes(':')) fmLast = 0;
    }
  }
  const fmTo = fmLast ? doc.line(fmLast).to : -1;
  if (fmLast && from <= fmTo && !revealed(0, fmTo)) {
    for (let l = 1; l <= fmLast; l++) {
      const ln = doc.line(l);
      if (l === fmLast) ranges.push({ from: ln.from, to: ln.to, value: Decoration.mark({ class: 'cm-md-frontmatter-src' }) });
      else ranges.push({ from: ln.from, to: ln.from, value: Decoration.line({ class: 'cm-md-frontmatter-hidden' }) });
    }
    const body = fmLast > 2 ? doc.sliceString(doc.line(2).from, doc.line(fmLast - 1).to) : '';
    ranges.push({ from: fmTo, to: fmTo, value: Decoration.widget({ widget: new FrontmatterWidget(body), side: 1 }) });
  }
  syntaxTree(state).iterate({ from, to,
    enter(node) {
      const { name, from, to } = node;
      if (fmTo >= 0 && name !== 'Document' && to <= fmTo) return false;
      const heading = headingSize.exec(name);
      if (heading) {
        const hashes = node.node.getChild('HeaderMark');
        let start = hashes ? hashes.to : from;
        if (doc.sliceString(start, start + 1) === ' ') start += 1;
        syntax(from, start);
        mark(start, to, `cm-md-h${heading[1]}`);
        return;
      }
      if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        const first = doc.lineAt(from);
        const last = doc.lineAt(to);
        mark(first.from, first.to, name === 'SetextHeading1' ? 'cm-md-h1' : 'cm-md-h2');
        if (last.number > first.number) syntax(last.from, last.to);
        return false;
      }
      const inline = inlineMark(node.node);
      if (inline) {
        mark(inline.from, inline.to, inline.cls);
        if (name === 'Link') { syntax(inline.start, inline.from); syntax(inline.to, inline.end); return false; }
        return;
      }
      if (name === 'Image') {
        const url = node.node.getChild('URL');
        if (url && !revealed(from, to)) {
          const [open, close] = node.node.getChildren('LinkMark');
          const alt = doc.sliceString(open.to, close.from);
          const raw = doc.sliceString(url.from, url.to);
          const destination = (raw.startsWith('<') ? raw.slice(1, -1) : raw).replace(/\\([!-/:-@\[-`{-~])/g, '$1');
          replace(from, to, new ImageWidget(alt, destination, loadImage));
        }
        return false;
      }
      if (name === 'TaskMarker') {
        const checked = /\[[xX]\]/.test(doc.sliceString(from, to));
        syntax(from, to, new TaskWidget(checked));
        return false;
      }
      if (name === 'Blockquote') {
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        for (let l = first; l <= last; l += 1) line(doc.line(l).from, 'cm-md-quote');
        return;
      }
      // A code block reads as raw source while the caret or a selection rests anywhere in it. Outside, a named fence keeps
      // its language as the box's top row, ruled off from the code; an unnamed fence hides both fence rows, and an indented
      // block boxes every line. The highlight is marked on top of the box's opaque background.
      if (name === 'FencedCode' || name === 'CodeBlock') {
        if (revealed(from, to)) return false;
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        const closing = name === 'FencedCode' ? node.node.lastChild : null;
        const closed = closing?.name === 'CodeMark' && closing.from !== node.node.firstChild?.from;
        const info = name === 'FencedCode' ? node.node.getChild('CodeInfo') : null;
        const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : '';
        const parts = node.node.getChildren('CodeText');
        const boxFrom = name === 'FencedCode' ? first + 1 : first;
        const boxTo = closed ? last - 1 : last;
        for (let l = first; l <= last; l += 1) {
          const ln = doc.line(l);
          if ((closed && l === last) || (name === 'FencedCode' && l === first && !language)) { syntax(ln.from, ln.to); continue; }
          let cls = 'cm-md-codeblock';
          if (l === first) cls += ' cm-md-codeblock-top' + (name === 'FencedCode' ? ' cm-md-codeblock-lang' : '');
          else if (l === boxFrom) cls += language ? ' cm-md-codeblock-start' : ' cm-md-codeblock-top';
          if (l === boxTo) cls += ' cm-md-codeblock-bottom';
          line(ln.from, cls);
          if (name === 'FencedCode' && l === first) syntax(ln.from, ln.to, new CodeLangWidget(language));
        }
        for (const span of codeSpans(node.node, language, doc, parts)) mark(from + span.from, from + span.to, span.cls);
        return false;
      }
      if (name === 'Table') {
        // Caret or selection anywhere in the table reads it as full source; outside, the source collapses and the grid draws.
        if (revealed(from, to)) return false;
        const firstLine = doc.lineAt(from).number;
        const lastLine = doc.lineAt(to).number;
        for (let l = firstLine; l <= lastLine; l++) {
          const ln = doc.line(l);
          if (l === lastLine) {
            ranges.push({ from: ln.from, to: ln.to, value: Decoration.mark({ class: 'cm-md-table-src' }) });
            ranges.push({ from: ln.from, to: ln.from, value: Decoration.line({ class: 'cm-md-table-line' }) });
          }
          else ranges.push({ from: ln.from, to: ln.from, value: Decoration.line({ class: 'cm-md-table-hidden' }) });
        }
        const rows: { header: boolean; cells: Seg[][] }[] = [];
        for (const row of [...node.node.getChildren('TableHeader'), ...node.node.getChildren('TableRow')]) {
          rows.push({ header: row.name === 'TableHeader', cells: row.getChildren('TableCell').map((c) => cellSegs(c, doc)) });
        }
        const delim = node.node.getChildren('TableDelimiter').find((c) => doc.lineAt(c.from).number === firstLine + 1);
        const aligns = delim ? doc.sliceString(delim.from, delim.to).split('|').map((s) => s.trim()).filter((s) => s !== '') : [];
        const last = doc.line(lastLine).to;
        ranges.push({ from: last, to: last, value: Decoration.widget({ widget: new TableWidget(rows, aligns, firstLine), side: 1 }) });
        return false;
      }
      if (name === 'HorizontalRule') {
        if (!revealed(from, to)) replace(from, to, new RuleWidget());
        return false;
      }
      if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark' || name === 'QuoteMark') {
        syntax(from, to);
        return;
      }
      if (name === 'ListMark') {
        // A task item's bullet gives way to its checkbox; any other list keeps its mark, drawn in the accent.
        if (/^\s*\[[ xX]\]/.test(doc.sliceString(to, to + 4))) syntax(from, to);
        else mark(from, to, 'cm-md-bullet');
        return;
      }
    },
  });
  return Decoration.set(ranges, true);
}

// Render past the viewport edge so a small scroll can reuse the current decorations.
const previewMargin = 1000;
const previewRange = (view: EditorView) => {
  const { from, to } = view.viewport;
  return { from: Math.max(0, from - previewMargin), to: Math.min(view.state.doc.length, to + previewMargin) };
};
const previewDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private moveVertically: EditorView['moveVertically'];
  constructor(private view: EditorView) {
    this.decorations = this.build(view);
    this.moveVertically = view.moveVertically;
    // Collapsed source rows have no height. Correct the geometric step here so Vim can still apply counts and operators.
    view.moveVertically = (start, forward, distance) => {
      const moved = this.moveVertically.call(view, start, forward, distance);
      if (distance !== undefined) return moved;
      const doc = view.state.doc;
      const source = doc.lineAt(start.head);
      const next = Math.max(1, Math.min(doc.lines, source.number + (forward ? 1 : -1)));
      const landed = doc.lineAt(moved.head).number;
      if (landed === next || (landed === source.number && moved.head !== start.head)) return moved;
      let collapsed = false;
      this.decorations.between(0, doc.length, (_from, to, value) => {
        const widget = value.spec.widget;
        if ((widget instanceof TableWidget || widget instanceof FrontmatterWidget)
            && widget.first <= Math.max(source.number, next) && doc.lineAt(to).number >= Math.min(source.number, next)) collapsed = true;
      });
      if (!collapsed) return moved;
      const row = doc.line(next);
      return EditorSelection.cursor(Math.min(row.to, row.from + start.head - source.from), start.assoc, undefined, moved.goalColumn);
    };
  }
  destroy() { this.view.moveVertically = this.moveVertically; }
  update(u: ViewUpdate) {
    const { to } = previewRange(u.view);
    const before = syntaxTree(u.startState);
    if (u.viewportChanged || u.docChanged || u.selectionSet || (before !== syntaxTree(u.state) && before.length < to)) {
      this.decorations = this.build(u.view);
    }
  }
  private build(view: EditorView) {
    const { from, to } = previewRange(view);
    return render(view.state, from, to);
  }
}, { decorations: plugin => plugin.decorations });

// The grid rides the table's last source line, whose number would otherwise float above the grid as a stray row;
// a gutter marker hides that number, leaving only the numbers either side of the grid.
class TableGutterMarker extends GutterMarker {
  elementClass = 'cm-md-table-gutter';
}
const tableGutterMarker = new TableGutterMarker();
const tableGutterMarks = (state: EditorState): RangeSet<GutterMarker> => {
  const doc = state.doc;
  const active = activeLines(state);
  const marks: Range<GutterMarker>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      if (rangeRevealed(active, doc, node.from, node.to)) return;
      const at = doc.lineAt(node.to).from;
      marks.push({ from: at, to: at, value: tableGutterMarker });
    },
  });
  return RangeSet.of(marks, true);
};
const tableGutter = StateField.define<RangeSet<GutterMarker>>({
  create: tableGutterMarks,
  update: (value, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? tableGutterMarks(tr.state) : value),
  provide: (field) => gutterLineClass.from(field),
});

// The idle parser only runs while it has focus, budget and no pending input, so a page can sit unrendered until a
// click wakes it. Drive the parse here instead: whenever the viewport is not covered, parse forward a bounded slice
// each frame until it is, so the visible lines render on their own, viewport first, without needing a click.
const markdownPreviewParse = ViewPlugin.fromClass(class {
  private frame = 0;
  private dead = false;
  constructor(private view: EditorView) { this.schedule(); }
  update() { this.schedule(); }
  private schedule() {
    const { view } = this;
    if (this.dead || this.frame || syntaxTree(view.state).length >= view.viewport.to) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dead) return;
      forceParsing(view, view.viewport.to, 50);
      this.schedule();
    });
  }
  destroy() { this.dead = true; if (this.frame) cancelAnimationFrame(this.frame); }
});

const markdownPreviewKeys = keymap.of([
  { key: 'ArrowDown', run: cursorLineDown, shift: selectLineDown },
  { key: 'ArrowUp', run: cursorLineUp, shift: selectLineUp },
]);

export function markdownPreview(context: UiContext, file: FileClick) {
  const images = new Map<string, Promise<string>>();
  const base = directoryOf(file);
  const loadImage = async (url: string) => {
    const name = decodeURIComponent(url.split(/[?#]/)[0]);
    const parts: string[] = [];
    for (const part of (name.startsWith('/') ? name : `${base}/${name}`).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    const path = `/${parts.join('/')}`;
    let pending = images.get(path);
    if (!pending) {
      pending = context.ui.request<ImageBytes>('read-image', { machine: file.machine, path })
        .then(({ mime, data }) => `data:${mime};base64,${data}`);
      images.set(path, pending);
      pending.catch(() => images.delete(path));
    }
    return pending;
  };
  return [previewDecorations, markdownPreviewKeys, markdownPreviewParse, tableGutter, EditorView.lineWrapping,
    previewImageSource.of(loadImage), imageLayout.of([])];
}
