import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Theme } from '@lengmoxxl/sdk';
import type { Font } from './shared';

// The editor drawn in the app's own colours: the shell around the text, and the colours the text is read in. Both are
// built once, from the theme and the font the window was started with.
export function editorTheme(theme: Theme, font: Font) {
  const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
  const lineHeight = font.lineHeight ? Math.round(font.size * font.lineHeight) : 0;
  const shell = EditorView.theme({
    '&': { height: '100%', color: theme.foreground, backgroundColor: theme.background, fontSize: `${font.size}px` },
    '.cm-scroller': lineHeight ? { fontFamily: font.family, lineHeight: `${lineHeight}px` } : { fontFamily: font.family },
    // Both selectors below are as long as they are because the vim package and the base theme reach these two elements
    // with selectors of their own, some of them later in the sheet: a simpler one loses without saying so.
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: theme.selection },
    '&.cm-editor.cm-focused .cm-fat-cursor': { backgroundColor: theme.cursor },
    '.cm-gutters': { backgroundColor: theme.background, color: theme.muted, border: 'none' },
    '.cm-activeLine': { backgroundColor: theme.overlay },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-thumb': { backgroundColor: theme.muted, borderRadius: '5px' },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': { backgroundColor: theme.foreground },
    '.cm-scroller::-webkit-scrollbar-corner': { backgroundColor: 'transparent' },
  }, { dark });
  const tokens = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: theme.muted },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: theme.green },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: theme.yellow },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: theme.magenta },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: theme.cyan },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: theme.blue },
    { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName), tags.self], color: theme.brightMagenta },
    { tag: [tags.heading, tags.strong], color: theme.blue, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.link, tags.url], color: theme.cyan, textDecoration: 'underline' },
  ]);
  return [shell, syntaxHighlighting(tokens)];
}
