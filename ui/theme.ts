import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Theme } from '@lengmoxxl/sdk';
import type { UiContext } from '@lengmoxxl/sdk/channel';
import type { Settings } from '../shared';
import { languageOf } from './mode';

let currentTheme: Theme;
export function trackTheme(context: UiContext) {
  currentTheme = context.host.config.theme;
  return context.global.subscribe<Theme>('theme', next => { currentTheme = next; });
}

export function editorTheme({ font, fontSizes }: Settings, path: string, theme = currentTheme) {
  const size = fontSizes?.[languageOf(path) ?? ''] ?? font.size;
  const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
  const lineHeight = font.lineHeight ? Math.round(size * font.lineHeight) : 0;
  const shell = EditorView.theme({
    '&': { height: '100%', color: theme.foreground, backgroundColor: theme.background, fontSize: `${size}px` },
    '.cm-scroller': lineHeight ? { fontFamily: font.family, lineHeight: `${lineHeight}px` } : { fontFamily: font.family },
    // These selectors must outrank the Vim and CodeMirror base themes.
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: theme.selection },
    '&.cm-editor.cm-focused .cm-fat-cursor': { backgroundColor: theme.cursor },
    '.cm-gutters': { backgroundColor: theme.background, color: theme.muted, border: 'none' },
    // Paint below the selection layer so the active line cannot cover selected text.
    '.cm-activeLine': { position: 'relative', backgroundColor: 'transparent' },
    // CodeMirror places the selection layer at z-index -2.
    '.cm-activeLine::before': { content: '""', position: 'absolute', inset: '0', zIndex: '-10', backgroundColor: theme.overlay },
    // The selection already highlights the active line.
    '&:has(.cm-selectionBackground) .cm-activeLine::before': { backgroundColor: 'transparent' },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-thumb': { backgroundColor: theme.muted, borderRadius: '5px' },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': { backgroundColor: theme.foreground },
    '.cm-scroller::-webkit-scrollbar-corner': { backgroundColor: 'transparent' },
  }, { dark });
  const tokens = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: theme.muted },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: theme.green },
    { tag: [tags.number, tags.bool, tags.null], color: theme.yellow },
    // The task marker "[ ]" is an atom; it reads with the heading blue rather than the numeric yellow.
    { tag: tags.atom, color: theme.blue },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: theme.magenta },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: theme.cyan },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: theme.blue },
    { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName), tags.self], color: theme.brightMagenta },
    { tag: tags.heading, color: theme.blue, fontWeight: '600' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.link, tags.url], color: theme.cyan, textDecoration: 'underline' },
  ]);
  return [shell, syntaxHighlighting(tokens)];
}
