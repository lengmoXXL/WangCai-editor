import { forceParsing, syntaxTree } from '@codemirror/language';
import { Compartment, Facet, Prec, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
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

// The language a fenced code block names is kept as a label at the head of the box, where the fence's own marks were.
class CodeLanguageWidget extends WidgetType {
  constructor(readonly language: string) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-md-code-lang';
    el.textContent = this.language;
    return el;
  }
  eq(other: CodeLanguageWidget) { return other.language === this.language; }
  ignoreEvent() { return true; }
}

// A table cell keeps the inline marks the rest of the page draws, built as text nodes so nothing in the file can inject
// markup of its own.
const inlineToken = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)|(\[[^\]]*\]\([^)\s]+\))/g;
function appendInline(parent: HTMLElement, text: string) {
  let last = 0;
  for (const m of text.matchAll(inlineToken)) {
    const at = m.index ?? 0;
    if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
    const tok = m[0];
    let el: HTMLElement;
    if (tok.startsWith('`')) { el = document.createElement('code'); el.className = 'cm-md-code'; el.textContent = tok.slice(1, -1); }
    else if (tok.startsWith('**')) { el = document.createElement('strong'); el.className = 'cm-md-bold'; el.textContent = tok.slice(2, -2); }
    else if (tok.startsWith('~~')) { el = document.createElement('span'); el.className = 'cm-md-strike'; el.textContent = tok.slice(2, -2); }
    else if (tok.startsWith('*')) { el = document.createElement('em'); el.className = 'cm-md-italic'; el.textContent = tok.slice(1, -1); }
    else { el = document.createElement('span'); el.className = 'cm-md-link'; el.textContent = /^\[([^\]]*)\]/.exec(tok)![1]; }
    parent.appendChild(el);
    last = at + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// A table is drawn as a grid below the lines that name it, which keep their line boxes so vertical motion walks them;
// header and alignment are read from the delimiter row, the way the preview tab draws GFM tables.
class TableWidget extends WidgetType {
  constructor(readonly text: string, readonly first: number) { super(); }
  toDOM() {
    const lines = this.text.split('\n').filter((l) => l.trim() !== '');
    const row = (l: string) => {
      let s = l.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map((c) => c.trim());
    };
    const align = (d: string) => {
      const left = d.startsWith(':'), right = d.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    };
    const delim = lines[1] ? row(lines[1]) : [];
    const cell = (tag: 'th' | 'td', c: string, i: number) => {
      const el = document.createElement(tag);
      const a = align(delim[i] || '');
      if (a) el.style.textAlign = a;
      appendInline(el, c);
      return el;
    };
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    row(lines[0]).forEach((c, i) => hr.appendChild(cell('th', c, i)));
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    for (const l of lines.slice(2)) {
      const tr = document.createElement('tr');
      row(l).forEach((c, i) => tr.appendChild(cell('td', c, i)));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    return table;
  }
  eq(other: TableWidget) { return other.text === this.text && other.first === this.first; }
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
function render(state: EditorState): DecorationSet {
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
  if (fmLast && !revealed(0, fmTo)) {
    for (let l = 1; l <= fmLast; l++) {
      const ln = doc.line(l);
      if (l === fmLast) ranges.push({ from: ln.from, to: ln.to, value: Decoration.mark({ class: 'cm-md-frontmatter-src' }) });
      else ranges.push({ from: ln.from, to: ln.from, value: Decoration.line({ class: 'cm-md-frontmatter-hidden' }) });
    }
    const body = fmLast > 2 ? doc.sliceString(doc.line(2).from, doc.line(fmLast - 1).to) : '';
    ranges.push({ from: fmTo, to: fmTo, value: Decoration.widget({ widget: new FrontmatterWidget(body, 1), side: 1 }) });
  }
  syntaxTree(state).iterate({
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
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough' || name === 'InlineCode') {
        const open = node.node.firstChild;
        const close = node.node.lastChild;
        if (open && close && open !== close) {
          const cls = name === 'StrongEmphasis' ? 'cm-md-bold'
            : name === 'Emphasis' ? 'cm-md-italic'
            : name === 'Strikethrough' ? 'cm-md-strike' : 'cm-md-code';
          mark(open.to, close.from, cls);
        }
        return;
      }
      if (name === 'Link') {
        const marks = node.node.getChildren('LinkMark');
        if (marks.length >= 2) {
          const open = marks[0];
          const close = marks[1];
          mark(open.to, close.from, 'cm-md-link');
          syntax(from, open.to);
          syntax(close.from, to);
        }
        return false;
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
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        const info = name === 'FencedCode' ? node.node.getChild('CodeInfo') : null;
        const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : '';
        for (let l = first; l <= last; l += 1) {
          const ln = doc.line(l);
          // A fence's own marks give way to the box's edge; the opening one keeps the language it names as a label, and a
          // fence the caret rests on reads as text. No decoration spans a line break.
          if (name === 'FencedCode' && (l === first || l === last)) {
            syntax(ln.from, ln.to, l === first && language ? new CodeLanguageWidget(language) : undefined);
          }
          let cls = 'cm-md-codeblock';
          if (l === first) cls += ' cm-md-codeblock-top';
          if (l === last) cls += ' cm-md-codeblock-bottom';
          line(ln.from, cls);
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
        const last = doc.line(lastLine).to;
        ranges.push({ from: last, to: last, value: Decoration.widget({ widget: new TableWidget(doc.sliceString(from, last), firstLine), side: 1 }) });
        return false;
      }
      if (name === 'HorizontalRule') {
        if (!revealed(from, to)) ranges.push({ from, to, value: Decoration.replace({ widget: new RuleWidget() }) });
        return false;
      }
      if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark' || name === 'QuoteMark' || name === 'CodeInfo') {
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
// to parse, and it is swapped in and out by a compartment without rebuilding the view. The overlay is one state field so
// the motion assist can read the drawn blocks back out of state to find a collapsed block's neighbourhood.
export const markdownPreview = StateField.define<DecorationSet>({
  create: (state) => render(state),
  update: (value, tr) => (tr.docChanged || !tr.state.selection.eq(tr.startState.selection) || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? render(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

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

// Collapsed table and frontmatter lines have no height for the view's vertical motion to land on, so within such a
// block's neighbourhood j/k and the arrows step one source line at a time by hand; the line the caret lands on reveals
// itself as text.
function blockNear(state: EditorState, line: number): boolean {
  const field = state.field(markdownPreview, false);
  if (!field) return false;
  let near = false;
  field.between(0, state.doc.length, (from, to, value) => {
    const widget = value.spec.widget;
    if (widget instanceof TableWidget || widget instanceof FrontmatterWidget) {
      const last = state.doc.lineAt(to).number;
      if (line >= widget.first - 1 && line <= last + 1) near = true;
    }
  });
  return near;
}

function stepBlock(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head).number;
  if (!blockNear(state, line)) return false;
  const target = Math.min(Math.max(line + dir, 1), state.doc.lines);
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

