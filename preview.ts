import { forceParsing, syntaxTree } from '@codemirror/language';
import { Compartment, Facet, Prec, type EditorState, type Range, type Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';

// The channel a local image's bytes come through: the page cannot reach the machine's disk for an <img> of its own, so
// each view is handed a resolver turning the path a note names into an address the picture can load.
export type PreviewImageSource = (url: string) => Promise<string>;
export const previewImageSource = Facet.define<PreviewImageSource>();
// A picture's bytes arrive after its widget is laid out and change its height. The view only re-reads line heights when
// its configuration changes, so an image lands by reconfiguring this empty compartment: that forces the measure that
// keeps the gutter and the scroll aligned with the picture.
export const imageMeasure = new Compartment();
// A horizontal rule is drawn as a line of its own rather than the dashes that name it.
class RuleWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-md-rule';
    return el;
  }
  eq() { return true; }
  ignoreEvent() { return true; }
}

// An image is shown where its markdown sits: a remote one loads straight from its address, a local one asks the channel
// for its bytes and draws them, a named card standing in until they arrive — or for good when they cannot be had.
class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly url: string, readonly source?: PreviewImageSource) { super(); }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';
    const picture = (src: string) => {
      const img = document.createElement('img');
      img.alt = this.alt;
      img.loading = 'lazy';
      const grown = () => view.dispatch({ effects: imageMeasure.reconfigure(EditorView.theme({ '.cm-md-image': {} })) });
      img.addEventListener('load', grown);
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
    if (this.source) {
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
    }
    return wrap;
  }
  eq(other: ImageWidget) { return other.alt === this.alt && other.url === this.url; }
  ignoreEvent() { return false; }
}

// A task list marker is drawn as a checkbox, and clicking it ticks the task over in the text itself.
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-task';
    box.checked = this.checked;
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at, to: at + 3, insert: this.checked ? '[ ]' : '[x]' } });
    });
    return box;
  }
  eq(other: TaskWidget) { return other.checked === this.checked; }
  ignoreEvent() { return false; }
}

type Seg = { text: string; cls?: string };

// Which preview class an inline node wears, the span of its content, and the span the whole mark consumes: one place
// the page's main loop and a table cell both read, so the vocabulary and the mark boundaries live once.
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

// A table cell's inline marks, read from the syntax tree the page already parses rather than re-parsed by hand: text
// between marks stays plain, and an escaped pipe belongs to the cell instead of cutting it in two.
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

// The drawn grid is a widget: CodeMirror owns neither its selection nor its copy, and it hides the browser's native
// selection inside the content. So a drag picks a rectangle of cells, painted here, and Copy lifts it as tab-separated
// text. One pick at a time, held outside the widget so a redraw of the grid does not lose it.
let picked: { table: HTMLTableElement; from: [number, number]; to: [number, number] } | null = null;

const clearPick = () => {
  if (picked) for (const row of Array.from(picked.table.rows)) for (const cell of Array.from(row.cells)) cell.classList.remove('cm-md-table-picked');
  picked = null;
};

const bounds = (from: [number, number], to: [number, number]): [number, number, number, number] =>
  [Math.min(from[0], to[0]), Math.max(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[1], to[1])];

const paintPick = () => {
  if (!picked) return;
  const [r0, r1, c0, c1] = bounds(picked.from, picked.to);
  Array.from(picked.table.rows).forEach((row, r) => Array.from(row.cells).forEach((cell, c) => {
    cell.classList.toggle('cm-md-table-picked', r >= r0 && r <= r1 && c >= c0 && c <= c1);
  }));
};

const pickText = () => {
  if (!picked) return '';
  const [r0, r1, c0, c1] = bounds(picked.from, picked.to);
  return Array.from(picked.table.rows).slice(r0, r1 + 1)
    .map((row) => Array.from(row.cells).slice(c0, c1 + 1).map((cell) => cell.textContent ?? '').join('\t'))
    .join('\n');
};

document.addEventListener('copy', (event) => {
  if (!picked || !picked.table.isConnected) return;
  event.preventDefault();
  event.stopPropagation();
  event.clipboardData?.setData('text/plain', pickText());
}, true);
document.addEventListener('mousedown', (event) => {
  if (picked && !picked.table.contains(event.target as Node)) clearPick();
}, true);
document.addEventListener('keydown', (event) => {
  // Moving the caret or typing leaves the grid behind; Copy still reaches the pick, modifiers alone do not.
  if (!((event.metaKey || event.ctrlKey) && event.key === 'c') && !['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) clearPick();
}, true);

// A table is drawn as a grid below the lines that name it, which keep their line boxes so vertical motion walks them;
// the header is the TableHeader node and alignment the delimiter row, the way the preview tab draws GFM tables.
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
    const cellOf = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest('td, th') : null;
      return el && table.contains(el) ? (el as HTMLTableCellElement) : null;
    };
    table.addEventListener('mousedown', (event) => {
      const cell = cellOf(event.target);
      if (!cell || event.button !== 0) return;
      // Keep CodeMirror's caret out of the table, so the grid stays drawn while it is picked.
      event.preventDefault();
      event.stopPropagation();
      const at = (c: HTMLTableCellElement): [number, number] => [(c.parentElement as HTMLTableRowElement).rowIndex, c.cellIndex];
      picked = { table, from: at(cell), to: at(cell) };
      paintPick();
      const move = (ev: MouseEvent) => {
        const over = cellOf(ev.target);
        if (over && picked) { picked.to = at(over); paintPick(); }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return table;
  }
  eq(other: TableWidget) { return other.first === this.first && other.aligns.join() === this.aligns.join() && JSON.stringify(other.rows) === JSON.stringify(this.rows); }
  ignoreEvent() { return true; }
}

// The YAML frontmatter of an Obsidian-style note, drawn as a block of properties: each key beside its value, an inline
// list shown as chips. Built as text nodes so nothing in the file can inject markup of its own.
class FrontmatterWidget extends WidgetType {
  constructor(readonly text: string, readonly first: number) { super(); }
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
  eq(other: FrontmatterWidget) { return other.text === this.text && other.first === this.first; }
  ignoreEvent() { return true; }
}

const headingSize = /^ATXHeading([1-6])$/;

// What the view draws: the markdown rendered inline, with the raw syntax of every line the caret or a selection rests on
// left visible, the way a live preview lets the line being edited be edited as text.
function render(state: EditorState, from: number, to: number): DecorationSet {
  const doc = state.doc;
  const loadImage = state.facet(previewImageSource)[0];
  const active = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = doc.lineAt(range.from).number;
    const to = doc.lineAt(range.to).number;
    for (let line = from; line <= to; line += 1) active.add(line);
  }
  const revealed = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let line = a; line <= b; line += 1) if (active.has(line)) return true;
    return false;
  };

  const ranges: Range<Decoration>[] = [];
  const mark = (from: number, to: number, cls: string) => {
    if (from < to) ranges.push({ from, to, value: Decoration.mark({ class: cls }) });
  };
  // Markup is dimmed where it shows and taken away where it does not: the line being edited keeps it, the rest reads clean.
  const syntax = (from: number, to: number, widget?: WidgetType) => {
    if (from >= to) return;
    mark(from, to, 'cm-md-syntax');
    if (!revealed(from, to)) ranges.push({ from, to, value: Decoration.replace({ widget }) });
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
    ranges.push({ from: fmTo, to: fmTo, value: Decoration.widget({ widget: new FrontmatterWidget(body, 1), side: 1 }) });
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
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough' || name === 'InlineCode' || name === 'Link') {
        const m = inlineMark(node.node);
        if (m) {
          mark(m.from, m.to, m.cls);
          if (name === 'Link') { syntax(m.start, m.from); syntax(m.to, m.end); }
        }
        return name === 'Link' ? false : undefined;
      }
      if (name === 'Image') {
        const text = doc.sliceString(from, to);
        const match = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(text);
        if (match && !revealed(from, to)) {
          ranges.push({ from, to, value: Decoration.replace({ widget: new ImageWidget(match[1], match[2], loadImage) }) });
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
      // The community codeBlockField reads FencedCode only, in inline mode: it swaps the two fences for a header (language,
      // Copy, MD) and a footer and keeps the code as editable text lines. An indented CodeBlock has no fences to swap, so it
      // keeps the box this pass draws.
      if (name === 'FencedCode') return false;
      if (name === 'CodeBlock') {
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        for (let l = first; l <= last; l += 1) {
          let cls = 'cm-md-codeblock';
          if (l === first) cls += ' cm-md-codeblock-top';
          if (l === last) cls += ' cm-md-codeblock-bottom';
          line(doc.line(l).from, cls);
        }
        return false;
      }
      if (name === 'Table') {
        // Caret or selection anywhere in the table reads it as full source; outside, the source collapses and the grid draws.
        if (revealed(from, to)) return false;
        const firstLine = doc.lineAt(from).number;
        const lastLine = doc.lineAt(to).number;
        for (let l = firstLine; l <= lastLine; l++) {
          const ln = doc.line(l);
          if (l === lastLine) ranges.push({ from: ln.from, to: ln.to, value: Decoration.mark({ class: 'cm-md-table-src' }) });
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
        if (!revealed(from, to)) ranges.push({ from, to, value: Decoration.replace({ widget: new RuleWidget() }) });
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

// The live preview laid over a markdown buffer: it reads the same syntax tree the highlighting does, so it adds nothing
// to parse, and it is swapped in and out by a compartment without rebuilding the view. Decorations are built only for the
// viewport and a margin around it, so their cost stays flat as the file grows; a parse that merely extends the tree past
// the range already drawn reuses the decorations instead of rebuilding them. The motion assist reads the drawn blocks
// back out of the plugin to find a collapsed block's neighbourhood.
const previewMargin = 1000;
const previewRange = (view: EditorView) => {
  const { from, to } = view.viewport;
  return { from: Math.max(0, from - previewMargin), to: Math.min(view.state.doc.length, to + previewMargin) };
};
export const markdownPreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
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

// The idle parser only runs while it has focus, budget and no pending input, so a page can sit unrendered until a
// click wakes it. Drive the parse here instead: whenever the viewport is not covered, parse forward a bounded slice
// each frame until it is, so the visible lines render on their own, viewport first, without needing a click.
export const markdownPreviewParse = ViewPlugin.fromClass(class {
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

function fenceLines(view: EditorView, line: number): Set<number> {
  const { state } = view;
  const at = state.doc.line(line);
  const fences = new Set<number>();
  syntaxTree(state).iterate({
    from: Math.max(0, at.from - 1),
    to: Math.min(state.doc.length, at.to + 1),
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      fences.add(state.doc.lineAt(node.from).number);
      fences.add(state.doc.lineAt(node.to).number);
    },
  });
  return fences;
}

// Collapsed table and frontmatter lines have no height for the view's vertical motion to land on, and a code block's two
// fences are widget rows the caret must not rest on, so within such a block's neighbourhood j/k and the arrows step one
// source line at a time by hand, skipping the fences. A table or frontmatter line the caret lands on reveals itself as
// text; code lines are already editable source, and their fences switch only via the header's MD button.
function stepBlock(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head).number;
  const fences = fenceLines(view, line);
  let near = false;
  for (const fence of fences) if (line >= fence - 1 && line <= fence + 1) near = true;
  const plugin = view.plugin(markdownPreview);
  if (!near && plugin) {
    plugin.decorations.between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget;
      if (widget instanceof TableWidget || widget instanceof FrontmatterWidget) {
        const last = state.doc.lineAt(to).number;
        if (line >= widget.first - 1 && line <= last + 1) near = true;
      }
    });
  }
  if (!near) return false;
  let target = line + dir;
  while (target >= 1 && target <= state.doc.lines && fences.has(target)) target += dir;
  // The skip can run past the document edge; clamping back would rest the caret on the fence it just skipped, so the key
  // is swallowed and the caret stays put.
  if (target < 1 || target > state.doc.lines) return true;
  view.dispatch({ selection: { anchor: state.doc.line(target).from }, scrollIntoView: true });
  return true;
}

const motionMode = (view: EditorView) => {
  const vim = getCM(view)?.state?.vim;
  return !!vim && !vim.insertMode;
};

export const markdownPreviewKeys = Prec.highest(EditorView.domEventHandlers({
  keydown: (event, view) => {
    const dir = event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowUp' ? -1
      : event.key === 'j' && motionMode(view) ? 1
      : event.key === 'k' && motionMode(view) ? -1 : 0;
    if (!dir || !stepBlock(view, dir)) return false;
    event.preventDefault();
    return true;
  },
}));

