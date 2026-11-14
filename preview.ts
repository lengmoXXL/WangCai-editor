import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

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

// An image is shown where its markdown sits: a remote one loads, a local one is named on a card, since the text channel
// this editor reads through carries no bytes for it.
class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly url: string) { super(); }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';
    if (/^https?:\/\//i.test(this.url)) {
      const img = document.createElement('img');
      img.src = this.url;
      img.alt = this.alt;
      img.loading = 'lazy';
      wrap.appendChild(img);
    } else {
      wrap.classList.add('cm-md-image-local');
      const label = document.createElement('span');
      label.className = 'cm-md-image-label';
      label.textContent = '图片';
      const name = document.createElement('span');
      name.className = 'cm-md-image-name';
      name.textContent = this.alt || this.url;
      wrap.append(label, name);
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

const headingSize = /^ATXHeading([1-6])$/;

// What the view draws: the markdown rendered inline, with the raw syntax of every line the caret or a selection rests on
// left visible, the way a live preview lets the line being edited be edited as text.
function render(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
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

  syntaxTree(state).iterate({
    enter(node) {
      const { name, from, to } = node;
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
          ranges.push({ from, to, value: Decoration.replace({ widget: new ImageWidget(match[1], match[2]) }) });
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

class LivePreview {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = render(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = render(update.view);
    }
  }
}

// The live preview laid over a markdown buffer: it reads the same syntax tree the highlighting does, so it adds nothing
// to parse, and it is swapped in and out by a compartment without rebuilding the view.
export const markdownPreview = ViewPlugin.fromClass(LivePreview, { decorations: (plugin) => plugin.decorations });