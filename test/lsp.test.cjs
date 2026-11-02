const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, closeWorkspace, codeSurface, cursorLine, diagnostics, dismiss, dismissSearch, editorFocused, hoverTips, landedOn, lists, lspDetail, lspDot, openSearch, pathBox, referenceList, referenceRows, searchInput, searchPanel, searchRow, showFile, shownPanel, storedHistory, submitSearch, workspaceTabs } = require('./editor-ui.cjs');
const { languageServers, openRust, openTs, rustServer } = require('./lsp-fixtures.cjs');

// A file with the shapes a case jumps to — one value, one interface, and a class implementing it — so that a jump has
// places to land on.
const shapesSource = 'export const answer = 42;\n\nexport interface Shape {\n  area(): number;\n}\n\nexport class Square implements Shape {\n  area(): number {\n    return 4;\n  }\n}\n';
// That file, beside a project a case writes, shown on the file that imports them; both paths are handed back.
const openShapes = async (home, page, source, text) => {
  const shapes = join(home, 'shapes.ts');
  writeFileSync(shapes, shapesSource);
  return { main: await openTs(home, page, source, text), shapes };
};

// Where a word is drawn: the editor draws one element per line, so the line is looked for by what it says and the word by
// the box of the character the server is asked about.
const tokenAt = (page, lineText, token) => page.evaluate(([lineText, text]) => {
  const line = [...document.querySelectorAll('.editor-code .cm-line')].find((row) => row.textContent.includes(lineText));
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node; node = walker.nextNode();) {
    const at = node.textContent.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + 1, y: rect.y + rect.height / 2 };
  }
  return null;
}, [lineText, token]);

test('a code file hovers and underlines from a language server, which the dot restarts and a closing workspace drops', { timeout: 90000 }, () => withWindow('wangcai-editor-lsp', lists, async ({ home, page, errors }) => {
  writeFileSync(join(home, 'answer.ts'), 'export const answer = 42;\n');
  await openTs(home, page, [
    'import { answer } from "./answer";',
    'answer;',
    "const value: number = 'TYPE_ERROR';",
    '',
  ].join('\n'), 'TYPE_ERROR');
  // A tooltip that is already up does not ask again, so the pointer leaves the name and comes back on every attempt; what a
  // hover says is read from the tooltip the editor draws over it.
  const hoverUntil = (at, phrase) => until(
    async () => (await hoverTips(page).allInnerTexts()).some((text) => text.replace(/\s+/g, ' ').includes(phrase)),
    { act: async () => { await page.mouse.move(at.x, at.y + 40); await page.mouse.move(at.x, at.y); }, interval: 500 },
  );
  const dot = lspDot(shownPanel(page), 'open');
  const detail = lspDetail(shownPanel(page));
  await dot.hover();
  await detail.filter({ hasText: 'typescript-language-server' }).waitFor();
  await page.mouse.move(0, 0);
  // A diagnostic arrives as a marker, which the editor paints as an underline over the offending text.
  await diagnostics(shownPanel(page)).first().waitFor({ timeout: 60000 });
  const at = await tokenAt(page, 'answer;', 'answer');
  await hoverUntil(at, 'const answer: 42');
  // A restart drops the server of this file and starts another one, which the view follows: the hover answers again once
  // the new server has been told what the file holds.
  await dot.click();
  await dot.waitFor();
  // The new server answers about the same name again, which the editor shows in the tooltip of that line. A server that
  // has just started knows only the import at first, so what it answers is not judged by the type it has yet to read.
  await hoverUntil(at, 'import answer');
  // A server started again is a process of its own, which takes its moment to appear where it is looked for.
  await until(() => languageServers(home).length === 1);
  // Closing the workspace takes the server with it: no file of this window is left to need it.
  await closeWorkspace(workspaceTabs(page).first());
  await until(() => !languageServers(home).length);
  assert.deepEqual(errors, []);
}));

test('the right-click menu answers definitions, type definitions, and references', { timeout: 120000 }, () => withWindow('wangcai-editor-menu', lists, async ({ home, page, errors }) => {
  const { main, shapes } = await openShapes(home, page, 'import { Shape, Square, answer } from "./shapes";\n\nconst first = answer;\nconst second = answer;\nconst shape: Shape = new Square();\nshape.area();\n', 'new Square');
  const menu = shownPanel(page).getByRole('menu', { name: '语言服务' });
  // The menu is offered only for a word, and only once the server has answered the handshake, so the click is given again
  // until the menu it asked for is up with the cursor on the line it landed on.
  const openMenu = async (line, token) => {
    let at;
    await until(async () => {
      // A menu left by an earlier round would answer the count below at once, so it is closed first.
      if (await menu.count()) await dismiss(menu);
      at = await tokenAt(page, line, token);
      if (!at) return false;
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await menu.waitFor({ timeout: 1500 }).catch(() => undefined);
      return (await menu.count()) > 0 && (await cursorLine(page)) === line;
    });
    const box = await menu.boundingBox();
    assert.ok(Math.abs(box.x - at.x) <= 2 && Math.abs(box.y - at.y) <= 2, `menu at ${box.x},${box.y}, click at ${at.x},${at.y}`);
  };
  const choose = async (name) => {
    await menu.getByRole('menuitem', { name }).click();
    await menu.waitFor({ state: 'detached' });
  };
  // A server answers a request only once it has read the file, so a jump that lands nowhere is asked for again.
  const jump = async (line, token, name, target) => {
    await until(async () => (await pathBox(shownPanel(page)).inputValue()) === target, {
      act: async () => {
        await openMenu(line, token);
        await choose(name);
      },
    });
  };
  await openMenu('const shape: Shape = new Square();', 'Square');
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['转到定义', '转到实现', '转到类型定义', '查找引用']);
  // The class of a type annotation is a file of its own, which the jump opens at the class with the cursor in it.
  await jump('const shape: Shape = new Square();', 'Square', '转到定义', shapes);
  await landedOn(page, shapes, 'export class Square implements Shape {');
  // The jump is recorded against the file it left.
  const leftEntry = Object.values(await storedHistory(page)).flatMap((history) => history.entries).filter((entry) => entry.path === main).at(-1);
  assert.equal(leftEntry.line, 5);
  assert.ok(await editorFocused(page));
  // Going back returns to the line the jump started from, with the cursor focused there.
  await backButton(page).click();
  await landedOn(page, main, 'const shape: Shape = new Square();');
  assert.ok(await editorFocused(page));
  // The type of the annotation is the interface the class implements.
  await jump('const shape: Shape = new Square();', 'Shape', '转到类型定义', shapes);
  await landedOn(page, shapes, 'export interface Shape {');
  await backButton(page).click();
  await landedOn(page, main, 'const shape: Shape = new Square();');
  // References are listed in a panel of this plugin, which names each place they were found in; opening one moves the page
  // to that file and line.
  await openMenu('const first = answer;', 'answer');
  await choose('查找引用');
  const references = referenceList(shownPanel(page));
  await references.waitFor();
  const row = referenceRows(shownPanel(page)).filter({ hasText: 'shapes.ts' });
  await row.waitFor();
  assert.match(await row.innerText(), /1:/);
  await row.click();
  await landedOn(page, shapes, 'export const answer = 42;');
  assert.ok(await editorFocused(page));
  // The menu follows what the server answers, not where the cursor is: a declaration offers the jumps too.
  await openMenu('export const answer = 42;', 'answer');
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['转到定义', '转到实现', '转到类型定义', '查找引用']);
  await dismiss(menu);
  // A menu that must not open is given the moment it would have taken to appear before the absence is asserted.
  const noMenu = async (click) => {
    await click();
    await page.waitForTimeout(500);
    assert.equal(await menu.count(), 0);
  };
  // A right click below the last line opens nothing.
  const editorBox = await codeSurface(shownPanel(page)).boundingBox();
  await noMenu(() => page.mouse.click(editorBox.x + 200, editorBox.y + editorBox.height - 40, { button: 'right' }));
  // A file no language server answers gets no menu at all.
  writeFileSync(join(home, 'notes.txt'), 'notes\n');
  await showFile(shownPanel(page), join(home, 'notes.txt'), 'notes');
  const plainAt = await tokenAt(page, 'notes', 'notes');
  await noMenu(() => page.mouse.click(plainAt.x, plainAt.y, { button: 'right' }));
  assert.deepEqual(errors, []);
}));

test('the jump keys ask the server, walk back through where they were made, and open the picker', { timeout: 120000 }, () => withWindow('wangcai-editor-jump-keys', lists, async ({ home, page, errors }) => {
  const { main, shapes } = await openShapes(home, page, 'import { Shape, Square, answer } from "./shapes";\n\nconst first = answer;\nconst shape: Shape = new Square();\n', 'new Square');
  // A click puts the cursor on the name the keys are about, the way a reader would.
  const press = async (lineText, token, ...keys) => {
    const at = await tokenAt(page, lineText, token);
    await page.mouse.click(at.x, at.y);
    // One key at a time, the way a person types a command: the vim layer holds a prefix like `g` open until the next key.
    for (const key of keys) { await page.keyboard.press(key); await page.waitForTimeout(60); }
  };
  await press('const shape: Shape = new Square();', 'Square', 'g', 'i');
  await landedOn(page, shapes, 'export class Square implements Shape {');
  // The list of jumps holds where the key started and where it landed, and the pair is walked both ways.
  await press('export class Square implements Shape {', 'Square', 'Control+o');
  await landedOn(page, main, 'const shape: Shape = new Square();');
  await page.keyboard.press('Control+i');
  await landedOn(page, shapes, 'export class Square implements Shape {');
  await page.keyboard.press('Control+o');
  await landedOn(page, main, 'const shape: Shape = new Square();');
  // `gd` takes the same road for a definition, and `gr` lists what it found rather than moving the page. A server that has
  // just been told what the file holds answers nothing about its references yet, so the key is pressed again until the list
  // it opens is there.
  const references = referenceList(shownPanel(page));
  await until(async () => (await references.count()) > 0, {
    act: async () => { await press('const first = answer;', 'answer', 'g', 'r'); },
    interval: 1000,
    timeout: 60000,
  });
  assert.ok((await referenceRows(shownPanel(page)).count()) >= 2);
  await dismiss(references);
  await press('const first = answer;', 'answer', 'g', 'd');
  await landedOn(page, shapes, 'export const answer = 42;');
  // `<C-f>` opens the picker, which owns the keyboard until it is dismissed.
  await press('export const answer = 42;', 'answer', 'Control+f');
  await searchPanel(page).waitFor();
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('the search box offers the symbols of the file the tab is on', { timeout: 90000 }, () => withWindow('wangcai-editor-symbols', lists, async ({ home, page, errors }) => {
  const main = await openTs(home, page, 'export function computeTotal() {\n  return 1;\n}\n\nexport interface Shape {\n  area(): number;\n}\n', 'computeTotal');
  // A leading @ asks the file's server for its symbols, and a row jumps into the declaration it names.
  await openSearch(page);
  await searchInput(page).fill('@Shape');
  await searchRow(page, 'Shape').waitFor({ timeout: 60000 });
  await submitSearch(page);
  await landedOn(page, main, 'export interface Shape {');
  assert.deepEqual(errors, []);
}));

// Rust's server is asked for by a command this machine does not have, so the window finds out it has none.
test('a language with no server on this machine says so on its dot, and the page stays quiet', { timeout: 120000 }, () => withWindow('wangcai-editor-missing-server', rustServer(['no-such-language-server']), async ({ home, page, errors }) => {
  await openRust(home, page);
  const dot = lspDot(shownPanel(page), 'missing');
  const detail = lspDetail(shownPanel(page));
  await dot.waitFor();
  await dot.hover();
  // The reason a server is not there is read on the dot, and the page raises nothing of its own about it.
  await until(async () => (await detail.innerText()).includes('未启动'));
  assert.match(await detail.innerText(), /no-such-language-server/);
  assert.equal(await alert(page).count(), 0);
  assert.deepEqual(errors, []);
}));
