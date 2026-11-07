const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { until, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { alert, backButton, closeWorkspace, codeShowing, codeSurface, cursorAt, diagnostics, dismiss, dismissSearch, editorFocused, hoverTips, landed, landedOn, lineBoxes, lists, lspDetail, lspDot, noServerReason, placeFileName, placeList, placeRows, placeText, queryApplied, search, searchInput, searchMarks, searchPanel, searchRowEntries, searchRowNamed, showFile, shownPanel, showWritten, storedHistory, submitSearch, typeInto, workspaceTabs } = require('./editor-ui.cjs');
const { areaNameAt, flatBody, flatNames, flatServer, languageServers, openRust, openTs, serverFor, treeBody, treeNames, treeServer } = require('./lsp-fixtures.cjs');

// The name the shapes file a case writes is imported by, so that the specifier and the path agree.
const shapesName = 'shapes';
const stubName = 'Demo.ts';

// The tokens, lines and panel titles the cases below share, so that each is written once and read by name.
const answerToken = 'answer';
const shapeToken = 'Shape';
const squareToken = 'Square';
const areaToken = 'area';
const answerLine = `export const ${answerToken} = 42;`;
const interfaceLine = `export interface ${shapeToken} {`;
const classLine = `export class ${squareToken} implements ${shapeToken} {`;
const subjectLine = `const shape: ${shapeToken} = new ${squareToken}();`;
const firstLine = `const first = ${answerToken};`;
const referencesTitle = '引用';
const implementationsTitle = '实现';

// The keys the plugin answers itself, as the README lists them: the three jumps of the normal mode, the pair that walks
// the tab's history, and the one that opens the search picker.
const definitionKeys = ['g', 'd'];
const implementationKeys = ['g', 'i'];
const referencesKeys = ['g', 'r'];
const jumpBackKey = 'Control+o';
const jumpForwardKey = 'Control+i';
const pickerKey = 'Control+f';
// The interface and the class that implements it, which the fixtures that jump between places are built on.
const shapeBlock = `${interfaceLine}\n  ${areaToken}(): number;\n}\n\n${classLine}\n  ${areaToken}(): number {\n    return 4;\n  }\n}`;
// A file with the shapes a case jumps to — one value, one interface, and a class implementing it — so that a jump has
// places to land on.
const shapesBody = `${answerLine}\n\n${shapeBlock}\n`;
// The main file a case opens: the import of those shapes, then the two lines it jumps from.
const mainBody = `import { ${shapeToken}, ${squareToken}, ${answerToken} } from "./${shapesName}";\n\n${firstLine}\n${subjectLine}\n`;
// The shapes file written to disk for the server to read, and the main file that imports it opened in the window; both
// paths are handed back.
const openShapes = async (home, page) => {
  const shapes = join(home, `${shapesName}.ts`);
  writeFileSync(shapes, shapesBody);
  return { main: await openTs(home, page, mainBody, subjectLine), shapes };
};

// Where a word is drawn: the editor draws one element per line, so the line is looked for by what it says and the word by
// the box of the character the server is asked about.
const tokenAt = (page, lineText, token) => lineBoxes(page).evaluateAll((lines, [lineText, token]) => {
  const line = lines.find((row) => row.textContent.includes(lineText));
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node; node = walker.nextNode();) {
    const at = node.textContent.indexOf(token);
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
  // The answer file this case writes beside the one it opens, whose single line is the name they import.
  const answerBody = `${answerLine}\n`;
  writeFileSync(join(home, `${answerToken}.ts`), answerBody);
  // The line that uses the name, and the mistake the server underlines on the line after it.
  const answerUse = `${answerToken};`;
  const typeError = 'TYPE_ERROR';
  const useBody = [`import { ${answerToken} } from "./${answerToken}";`, answerUse, `const value: number = '${typeError}';`, ''].join('\n');
  await openTs(home, page, useBody, typeError);
  // A tooltip that is already up does not ask again, so the pointer leaves the name and comes back on every attempt; what a
  // hover says is read from the tooltip the editor draws over it. An attempt is given half a second, since the next one takes
  // the pointer away again and an answer still on its way would be missed.
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
  const at = await tokenAt(page, answerUse, answerToken);
  await hoverUntil(at, `const ${answerToken}: 42`);
  // A restart drops the server of this file and starts another one, which the view follows: the hover answers again once
  // the new server has been told what the file holds.
  await dot.click();
  await dot.waitFor();
  // The new server answers about the same name again, which the editor shows in the tooltip of that line. A server that
  // has just started knows only the import at first, so what it answers is not judged by the type it has yet to read.
  await hoverUntil(at, `import ${answerToken}`);
  // A server started again is a process of its own, which takes its moment to appear where it is looked for.
  await until(() => languageServers(home).length === 1);
  // Closing the workspace takes the server with it: no file of this window is left to need it.
  await closeWorkspace(workspaceTabs(page).first());
  await until(() => !languageServers(home).length);
  assert.deepEqual(errors, []);
}));

test('the right-click menu answers definitions, type definitions, and references, its rows are walked with the vim keys, and it stays shut where there is no word', { timeout: 120000 }, () => withWindow('wangcai-editor-menu', lists, async ({ home, page, errors }) => {
  const { main, shapes } = await openShapes(home, page);
  const menu = shownPanel(page).getByRole('menu', { name: '语言服务' });
  // The menu is offered only for a word, and only once the server has answered the handshake, so the click is given again
  // until the menu it asked for is up with the cursor on the line it landed on.
  const openMenu = async (lineText, token) => {
    let at;
    await until(async () => {
      // A menu left by an earlier round would answer the count below at once, so it is closed first.
      if (await menu.count()) await dismiss(menu);
      at = await tokenAt(page, lineText, token);
      if (!at) return false;
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await menu.waitFor({ timeout: 1500 }).catch(() => undefined);
      return (await menu.count()) > 0 && (await cursorAt(page, lineText));
    });
    const box = await menu.boundingBox();
    assert.ok(Math.abs(box.x - at.x) <= 2 && Math.abs(box.y - at.y) <= 2, `menu at ${box.x},${box.y}, click at ${at.x},${at.y}`);
  };
  const clickEntry = (name) => menu.getByRole('menuitem', { name }).click();
  const pick = async (lineText, token, take) => {
    await openMenu(lineText, token);
    await take();
    await menu.waitFor({ state: 'detached' });
  };
  // A jump that landed nowhere is asked for again.
  const jump = async (lineText, token, take, path, landedText) => {
    await until(() => landed(page, path, landedText), { act: async () => pick(lineText, token, take) });
  };
  const back = async () => {
    await backButton(page).click();
    await landedOn(page, main, subjectLine);
  };
  // The entries the menu offers for a word the server knows, in the order it offers them.
  const definitionEntry = '转到定义';
  const implementationEntry = '转到实现';
  const typeDefinitionEntry = '转到类型定义';
  const referencesEntry = '查找引用';
  const languageMenu = [definitionEntry, implementationEntry, typeDefinitionEntry, referencesEntry];
  await openMenu(subjectLine, squareToken);
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), languageMenu);
  // The class of a type annotation is a file of its own, which the jump opens at the class with the cursor in it.
  await jump(subjectLine, squareToken, () => clickEntry(definitionEntry), shapes, classLine);
  // The jump is recorded against the file it left.
  const leftEntry = Object.values(await storedHistory(page)).flatMap((history) => history.entries).filter((entry) => entry.path === main).at(-1);
  assert.equal(leftEntry.line, mainBody.split('\n').indexOf(subjectLine) + 1);
  assert.ok(await editorFocused(page));
  await back();
  assert.ok(await editorFocused(page));
  // The type of the annotation is the interface the class implements.
  await jump(subjectLine, shapeToken, () => clickEntry(typeDefinitionEntry), shapes, interfaceLine);
  await back();
  // The menu takes the keys a panel of places takes. The name opened is the annotation, whose definition is the interface
  // and whose implementation is the class, so the two entries land on different lines.
  await jump(subjectLine, shapeToken, async () => {
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
  }, shapes, classLine);
  await back();
  await pick(firstLine, answerToken, () => clickEntry(referencesEntry));
  const places = placeList(shownPanel(page), referencesTitle);
  await places.waitFor();
  const row = placeRows(places).filter({ hasText: basename(shapes) });
  await row.waitFor();
  const referenced = await placeText(row, shapesBody);
  await row.click();
  await landedOn(page, shapes, referenced);
  assert.ok(await editorFocused(page));
  // The menu follows what the server answers, not where the cursor is: a declaration offers the jumps too.
  await openMenu(answerLine, answerToken);
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), languageMenu);
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
  const notes = join(home, 'notes.txt');
  const notesLine = 'notes';
  const notesBody = `${notesLine}\n`;
  writeFileSync(notes, notesBody);
  await showFile(shownPanel(page), notes, notesLine);
  const plainAt = await tokenAt(page, notesLine, notesLine);
  await noMenu(() => page.mouse.click(plainAt.x, plainAt.y, { button: 'right' }));
  assert.deepEqual(errors, []);
}));

// A click puts the cursor on the name the keys are about, the way a reader would; the keys follow one at a time, since the
// vim layer holds a prefix like `g` open until the next key.
const pressOn = async (page, lineText, token, ...keys) => {
  // The box of the word is asked for until one comes back: its line is drawn a moment after the file is shown.
  let at;
  await until(async () => (at = await tokenAt(page, lineText, token)) !== null);
  await page.mouse.click(at.x, at.y);
  for (const key of keys) { await page.keyboard.press(key); await page.waitForTimeout(60); }
};

// The press is made again until the list is there: a server answers a request only once it has read the file, and its answer
// about a file it has just been told of may name nothing yet.
//
// The click goes with every press, since it is what puts the caret on the word the question is about.
const untilPlace = async (page, title, lineText, token, ...keys) => {
  const list = placeList(shownPanel(page), title);
  await until(async () => (await list.count()) > 0, {
    act: async () => pressOn(page, lineText, token, ...keys),
    // Longer than a double click, which would select that word instead of putting the caret in it.
    interval: 700,
  });
  return list;
};

test('the jump keys ask the server, walk back through where they were made, and open the picker', { timeout: 120000 }, () => withWindow('wangcai-editor-jump-keys', lists, async ({ home, page, errors }) => {
  const { main, shapes } = await openShapes(home, page);
  await pressOn(page, subjectLine, squareToken, ...implementationKeys);
  await landedOn(page, shapes, classLine);
  // The tab's history holds where the key started and where it landed, and the pair is walked both ways.
  await pressOn(page, classLine, squareToken, jumpBackKey);
  await landedOn(page, main, subjectLine);
  await page.keyboard.press(jumpForwardKey);
  await landedOn(page, shapes, classLine);
  await page.keyboard.press(jumpBackKey);
  await landedOn(page, main, subjectLine);
  // `gd` takes the same road for a definition, and `gr` lists what it found rather than moving the page.
  const places = await untilPlace(page, referencesTitle, firstLine, answerToken, ...referencesKeys);
  // The declaration, the import of it, and the line that uses it.
  assert.equal(await placeRows(places).count(), 3);
  await dismiss(places);
  await pressOn(page, firstLine, answerToken, ...definitionKeys);
  await landedOn(page, shapes, answerLine);
  // `<C-f>` opens the picker, which owns the keyboard until it is dismissed.
  await pressOn(page, answerLine, answerToken, pickerKey);
  await searchPanel(page).waitFor();
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('the search box offers the symbols of the file the tab is on', { timeout: 90000 }, () => withWindow('wangcai-editor-symbols', lists, async ({ home, page, errors }) => {
  const computeToken = 'computeTotal';
  const counterToken = 'counter';
  const bodyClassToken = 'BodyClass';
  const sameToken = 'Same';
  const echoToken = 'echo';
  const symbolsBody = `${answerLine}\n\nlet ${counterToken} = 0;\n\nexport function ${computeToken}() {\n  class ${bodyClassToken} {}\n  return ${counterToken};\n}\n\n${shapeBlock}\n\nexport namespace ${sameToken} {\n  export namespace ${sameToken} {\n    export function ${echoToken}() {}\n  }\n}\n`;
  const main = await openTs(home, page, symbolsBody, computeToken);
  // A leading @ asks the file's server for its symbols, and a row jumps into the declaration it names.
  await search(page, `@${shapeToken}`);
  await searchRowNamed(page, shapeToken).waitFor({ timeout: 60000 });
  await submitSearch(page);
  await landedOn(page, main, interfaceLine);
  await search(page, '@');
  await searchRowNamed(page, areaToken).first().waitFor({ timeout: 60000 });
  assert.equal(await searchRowNamed(page, answerToken).count(), 1);
  assert.equal(await searchRowNamed(page, computeToken).count(), 1);
  assert.equal(await searchRowNamed(page, counterToken).count(), 0);
  assert.equal(await searchRowNamed(page, bodyClassToken).count(), 0);
  const entries = await searchRowEntries(page);
  assert.deepEqual(entries.filter((row) => row.text === areaToken), [
    { text: areaToken, depth: 1, holder: shapeToken },
    { text: areaToken, depth: 1, holder: squareToken },
  ]);
  assert.deepEqual(entries.filter((row) => row.text === sameToken), [
    { text: sameToken, depth: 0, holder: undefined },
    { text: sameToken, depth: 1, holder: sameToken },
  ]);
  assert.deepEqual(entries.find((row) => row.text === echoToken), { text: echoToken, depth: 2, holder: sameToken });
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('a server that answers with a tree has its members listed under the holder they sit in', { timeout: 90000 }, () => withWindow('wangcai-editor-tree-symbols', treeServer, async ({ home, page, errors }) => {
  const demo = join(home, stubName);
  await showWritten(page, demo, treeBody);
  const areaRow = searchRowNamed(page, treeNames.area);
  assert.equal(await areaRow.count(), 0);
  await search(page, '@');
  await areaRow.waitFor({ timeout: 60000 });
  const unlisted = [treeNames.local, treeNames.value];
  for (const name of Object.values(treeNames)) {
    assert.equal(await searchRowNamed(page, name).count(), unlisted.includes(name) ? 0 : 1, name);
  }
  const entries = await searchRowEntries(page);
  assert.deepEqual(entries.find((row) => row.text === treeNames.area), { text: treeNames.area, depth: 2, holder: treeNames.shape });
  assert.deepEqual(entries.find((row) => row.text === treeNames.run), { text: treeNames.run, depth: 1, holder: treeNames.module });
  await searchInput(page).fill(`@${treeNames.area}`);
  await queryApplied(page);
  assert.deepEqual(await searchRowEntries(page), [
    { text: treeNames.space, depth: 0, holder: undefined },
    { text: treeNames.shape, depth: 1, holder: treeNames.space },
    { text: treeNames.area, depth: 2, holder: treeNames.shape },
  ]);
  assert.deepEqual(await searchMarks(searchRowNamed(page, treeNames.space)), []);
  assert.deepEqual(await searchMarks(searchRowNamed(page, treeNames.shape)), []);
  await areaRow.click();
  // Typing checks the exact cursor column; seeing the line alone would miss an incorrect selectionRange.
  const nameLineText = treeBody.split('\n')[areaNameAt.line];
  await landedOn(page, demo, nameLineText);
  const typedChar = 'X';
  await typeInto(page, typedChar);
  await codeShowing(shownPanel(page), `${nameLineText.slice(0, areaNameAt.character)}${typedChar}${nameLineText.slice(areaNameAt.character)}`).waitFor();
  assert.deepEqual(errors, []);
}));

test('a flat answer files each entry under the holder it names, as the tree form does', { timeout: 90000 }, () => withWindow('wangcai-editor-flat-symbols', flatServer, async ({ home, page, errors }) => {
  await showWritten(page, join(home, stubName), flatBody);
  await search(page, '@');
  await searchRowNamed(page, flatNames.area).waitFor({ timeout: 60000 });
  assert.deepEqual(await searchRowEntries(page), [
    { text: flatNames.inner, depth: 0, holder: undefined },
    { text: flatNames.inner, depth: 1, holder: flatNames.inner },
    { text: flatNames.area, depth: 1, holder: flatNames.inner },
    { text: flatNames.alone, depth: 0, holder: undefined },
    { text: flatNames.stand, depth: 1, holder: flatNames.alone },
  ]);
  await dismissSearch(page);
  assert.deepEqual(errors, []);
}));

test('an implementation jump lists every place the server found, and the row opened is the one clicked', { timeout: 120000 }, () => withWindow('wangcai-editor-implementations', lists, async ({ home, page, errors }) => {
  // An interface and two classes implementing it, so a jump has more than one place to offer.
  const circleToken = 'Circle';
  const twoShapes = `${shapeBlock}\n\nexport class ${circleToken} implements ${shapeToken} {\n  ${areaToken}(): number {\n    return 3;\n  }\n}\n`;
  const main = await openTs(home, page, twoShapes, areaToken);
  const rows = placeRows(await untilPlace(page, implementationsTitle, interfaceLine, shapeToken, ...implementationKeys));
  assert.equal(await rows.count(), 2);
  // The row opened is the one clicked, rather than whichever place the server named first.
  const second = rows.nth(1);
  const text = await placeText(second, twoShapes);
  await second.click();
  await landedOn(page, main, text);
  assert.deepEqual(errors, []);
}));

test('the list of references is walked with the vim keys and opened with Enter', { timeout: 120000 }, () => withWindow('wangcai-editor-reference-keys', lists, async ({ home, page, errors }) => {
  const { main, shapes } = await openShapes(home, page);
  const focusIndex = (rows) => rows.evaluateAll((all) => all.indexOf(document.activeElement));
  const walk = async (rows, key, at) => {
    await page.keyboard.press(key);
    await until(async () => (await focusIndex(rows)) === at);
  };
  // The references of the answer on the first line, which both openings below ask for.
  const openReferences = () => untilPlace(page, referencesTitle, firstLine, answerToken, ...referencesKeys);
  const places = await openReferences();
  const rows = placeRows(places);
  assert.equal(await focusIndex(rows), 0);
  await walk(rows, 'j', 1);
  await walk(rows, 'k', 0);
  // A panel closed without opening anything gives the keys back: the row that held them went with it.
  await dismiss(places);
  assert.ok(await editorFocused(page));
  // The panel opened again, and the row below the first, which is the one Enter is to open.
  const reopened = await openReferences();
  const reopenedRows = placeRows(reopened);
  await walk(reopenedRows, 'j', 1);
  const second = reopenedRows.nth(1);
  const opened = { [basename(main)]: { path: main, body: mainBody }, [basename(shapes)]: { path: shapes, body: shapesBody } };
  const file = opened[await placeFileName(second)];
  const text = await placeText(second, file.body);
  await page.keyboard.press('Enter');
  await reopened.waitFor({ state: 'detached' });
  await landedOn(page, file.path, text);
  // The keys come back with the text as well, whether the jump rebuilt the view or landed in the file already shown.
  assert.ok(await editorFocused(page));
  assert.deepEqual(errors, []);
}));

// A command this machine does not have, which a case gives a language's server so that it cannot start.
const missingCommand = 'no-such-language-server';

test('a language with no server on this machine says so on its dot, and the page stays quiet', { timeout: 120000 }, () => withWindow('wangcai-editor-missing-server', serverFor('rust', [missingCommand]), async ({ home, page, errors }) => {
  await openRust(home, page);
  // The reason a server is not there is read on the dot, and the page raises nothing of its own about it.
  assert.match(await noServerReason(page), new RegExp(missingCommand));
  assert.equal(await alert(page).count(), 0);
  assert.deepEqual(errors, []);
}));

test('a java file is read as java, so the command java names is the one it asks about', { timeout: 120000 }, () => withWindow('wangcai-editor-java-server', serverFor('java', [missingCommand]), async ({ home, page, errors }) => {
  await showWritten(page, join(home, 'Demo.java'), '');
  // The language the file is read as is what picks the entry, so a file read as anything else asks about another command.
  assert.match(await noServerReason(page), new RegExp(missingCommand));
  assert.deepEqual(errors, []);
}));
