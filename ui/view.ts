import type { EditorState, Text } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';
import type { HistoryEntry } from '../shared';

// Vim callbacks expose the CM5 interface. Its CM6 adapter also holds the EditorView.
export const viewOf = (cm: unknown) => (cm as { cm6?: EditorView }).cm6;

export function cursorPosition(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}

export function cursorOffset(doc: Text, line: number, column = 1) {
  const row = doc.line(Math.min(doc.lines, Math.max(1, line)));
  return Math.min(row.to, row.from + Math.max(0, column - 1));
}

export function restorePosition(view: EditorView, scroller: HTMLElement, { line, column, top }: HistoryEntry, defaultOffset?: number) {
  const at = line === undefined ? defaultOffset : cursorOffset(view.state.doc, line, column);
  if (at === undefined && top === undefined) return;
  const selection = view.state.selection.main;
  const head = at ?? selection.head;
  // A named jump records the clamped position. A path-only visit at the default caret keeps its coordinates implicit.
  if (at !== undefined && (line !== undefined || !selection.empty || selection.head !== at)) view.dispatch({ selection: { anchor: at } });
  let observer: ResizeObserver | undefined;
  let frame = 0, attempts = 0;
  const place = () => {
    if (view.state.selection.main.head !== head) return;
    if (!scroller.clientHeight) {
      observer = new ResizeObserver(() => {
        if (!scroller.clientHeight) return;
        observer?.disconnect();
        frame = requestAnimationFrame(place);
      });
      observer.observe(scroller);
      return;
    }
    if (top === undefined) {
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
    } else {
      scroller.scrollTop = top;
      // A newly mounted view may still be drawing the lines from before this scroll.
      view.requestMeasure();
      if (Math.abs(scroller.scrollTop - top) > 1 && ++attempts < 60) frame = requestAnimationFrame(place);
    }
  };
  // CodeMirror can shift a pixel offset applied before its initial layout.
  if (top === undefined) place();
  else frame = requestAnimationFrame(place);
  return () => { observer?.disconnect(); cancelAnimationFrame(frame); };
}

// Vim suppresses native selection, so both editor and diff views need drawSelection().
export const viewChrome = [vim(), lineNumbers(), highlightActiveLine(), drawSelection()];

// Vim actions are global. Dispatch each action to the view that received the key.
export const mapVimAction = (keys: string, name: string, run: (view: EditorView, repeat: number) => void) => {
  Vim.defineAction(name, (cm, args) => {
    const view = viewOf(cm);
    if (view) run(view, args.repeat || 1);
  });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
};
