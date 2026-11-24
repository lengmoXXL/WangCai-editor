import { EditorView, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';

// The view behind the vim adapter: `cm6` is the field it carries the CodeMirror view in, which its own types do not say.
export const viewOf = (cm: unknown) => (cm as { cm6?: EditorView }).cm6;

// The viewing experience every page shares — the vim keys over the text, the line numbers, the caret's line, and the
// selection a visual mode draws (the vim keys blank the browser's own ::selection) — whether the page edits the text or
// only reads a comparison of it.
export const viewChrome = [vim(), lineNumbers(), highlightActiveLine(), drawSelection()];

// A normal-mode key answered by our own action, defined once for the window since the vim layer is one state shared by
// every view; the action asks the view it was typed into, and a count reaches it as the repeat.
export const mapVimAction = (keys: string, name: string, run: (view: EditorView, repeat: number) => void) => {
  Vim.defineAction(name, (cm, args) => {
    const view = viewOf(cm);
    if (view) run(view, args.repeat || 1);
  });
  Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
};
