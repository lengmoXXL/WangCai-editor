const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { until, withHome, withWindow } = require('@lengmoxxl/wangcai-testkit');
const { activeLineBox, alert, backButton, clickFile, collectErrors, createWorkspace, drawnCloseButtons, drawnLines, editorPanels, editorPlugin, editorTab, editorView, filesColumn, filesPlugin, forwardButton, goToPath, landedOn, lineBoxes, lineShown, lists, machine, openDirectoryButton, openEditorWorkspace, openWorkspaces, refreshButton, selectionClass, selectionMarks, showAfter, showFile, shownPanel, shows, showWritten, storedHistory, viewMenu, waitForPath, workspaceTabs } = require('./editor-ui.cjs');

// An opening line for the pages of the cases that do not turn on which line comes first.
const firstLine = 'const first = 1;';
// How a case asks for a file to be opened: the payload the page takes for one visit.
const visitTo = (path) => ({ type: 'file', machine, path });
// A visit published from a link, waited for by a line of the file it opens.
const openVisit = async (page, visit, line) => {
  await clickFile(page, visit);
  await lineShown(page, line);
};

test('a file link opens as its text, and a path that cannot be read says so', { timeout: 180000 }, () => withWindow('wangcai-editor-open', lists, async ({ home, page, errors }) => {
  const code = join(home, 'sample.ts');
  const markdown = join(home, '说明 file.md');
  const binary = join(home, 'binary.bin');
  const asText = 'CODE_AS_TEXT';
  const asTextBody = `${firstLine}\nconst second = "${asText}";\n`;
  const markdownLine = '# Markdown source';
  const markdownBody = `${markdownLine}\n`;
  writeFileSync(code, asTextBody);
  writeFileSync(markdown, markdownBody);
  writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
  await openEditorWorkspace(page);
  await openVisit(page, visitTo(code), asText);
  assert.ok(await shows(shownPanel(page), code));
  // A page is a file like any other here: its own text is what is drawn.
  await showFile(shownPanel(page), markdown, markdownLine);
  await page.screenshot({ path: 'test/output/screenshots/editor-text.png' });
  await goToPath(shownPanel(page), binary);
  await alert(page).filter({ hasText: '暂不支持二进制' }).waitFor();
  await goToPath(shownPanel(page), join(home, 'missing.ts'));
  await alert(page).filter({ hasText: '路径不存在' }).waitFor();
  assert.deepEqual(errors, []);
}));

test('a file with nothing in it opens as an empty page', { timeout: 120000 }, () => withWindow('wangcai-editor-empty', lists, async ({ home, page, errors }) => {
  const empty = join(home, 'empty.ts');
  await showWritten(page, empty, '');
  assert.deepEqual(await drawnLines(page), ['']);
  assert.deepEqual(errors, []);
}));

test('the header hands the directory the shown file sits in to the files view', { timeout: 120000 }, () => withWindow('wangcai-editor-files', { ...lists, tabs: [...lists.tabs, filesPlugin] }, async ({ home, page, errors }) => {
  // A directory of its own under the workspace, so the column asked for below is not also the workspace root's.
  const directory = join(home, 'inner');
  mkdirSync(directory);
  const listedName = 'listed.ts';
  const file = join(directory, listedName);
  await showWritten(page, file, '');
  await openDirectoryButton(page).click();
  await filesColumn(page, directory).getByRole('button', { name: listedName, exact: true }).waitFor();
  assert.deepEqual(errors, []);
}));

test('a selection is painted on the line the cursor is on, which keeps a fill of its own', { timeout: 120000 }, () => withWindow('wangcai-editor-selection', lists, async ({ home, page, errors }) => {
  // The colour a layer that paints nothing reports, which is what "painted" is measured against: a layer painting none
  // lets what is beneath it show.
  const noPaint = 'rgba(0, 0, 0, 0)';
  // What fills each of the points of the page, in one read of it: the first thing under the pointer that paints a colour.
  // Read off the page, so it says what the reader sees rather than what a stylesheet meant.
  const paintedAt = (points) => page.evaluate(({ points, noPaint }) => points.map(({ x, y }) => {
    for (const element of document.elementsFromPoint(x, y)) {
      const color = getComputedStyle(element).backgroundColor;
      if (color !== noPaint) return { name: String(element.className), color };
    }
  }), { points, noPaint });
  const file = join(home, 'selection.ts');
  const selectionBody = `${firstLine}\nconst second = 2;\nconst third = 3;\n`;
  await showWritten(page, file, selectionBody, firstLine);
  // Dragging down from the first line selects it and the next one, which leaves the cursor — the editor's active line — on
  // the second of the two.
  const [start, end] = await lineBoxes(page).evaluateAll((lines) => lines.slice(0, 2).map((line) => {
    const box = line.getBoundingClientRect();
    return { x: box.x + 40, y: box.y + box.height / 2 };
  }));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  // The marks are drawn again as the view measures, so a point of each kind — on the cursor's line and off it — is read in
  // one go, and the read is asked for again until both are there.
  let offLine;
  let onLine;
  await until(async () => {
    const cursorTop = (await activeLineBox(page).boundingBox())?.y;
    if (cursorTop === undefined) return false;
    const markPoints = await selectionMarks(page).evaluateAll((marks, cursorTop) => marks.map((mark) => {
      const box = mark.getBoundingClientRect();
      return { x: box.x + Math.min(10, box.width / 2), y: box.y + box.height / 2, onCursorLine: Math.abs(box.y - cursorTop) < 2 };
    }), cursorTop);
    offLine = markPoints.find((point) => !point.onCursorLine);
    onLine = markPoints.find((point) => point.onCursorLine);
    return Boolean(offLine && onLine);
  });
  const [paintedOff, paintedOn] = await paintedAt([offLine, onLine]);
  assert.ok(paintedOff.name.split(' ').includes(selectionClass), `painted ${JSON.stringify(paintedOff)}`);
  assert.deepEqual(paintedOn, paintedOff);
  // The line the cursor is on keeps a colour of its own as well, which the selection is painted over.
  const [fill, ground] = await activeLineBox(page).evaluate((line) => [
    getComputedStyle(line, '::before').backgroundColor,
    getComputedStyle(line.closest('.cm-editor')).backgroundColor,
  ]);
  assert.ok(fill !== noPaint && fill !== ground, `the line the cursor is on paints ${fill} over ${ground}`);
  assert.deepEqual(errors, []);
}));

test('a file is shown again where it was left', { timeout: 120000 }, () => withWindow('wangcai-editor-position', lists, async ({ home, page, errors }) => {
  const long = join(home, 'long.ts');
  const other = join(home, 'other.ts');
  // Every line of the long file looks the same apart from its number, and the other file holds one line.
  const longLine = (index) => `const line${index} = ${index};`;
  const lastLine = 400;
  const otherLine = 'export const other = 1;';
  const otherBody = `${otherLine}\n`;
  const longBody = Array.from({ length: lastLine }, (_, index) => longLine(index + 1)).join('\n') + '\n';
  await showWritten(page, long, longBody, longLine(1));
  writeFileSync(other, otherBody);
  // Down at the end of the file, which is where the offset is written down as the editor scrolls.
  await page.keyboard.press('G');
  await lineShown(page, longLine(lastLine));
  await goToPath(shownPanel(page), other);
  await landedOn(page, other, otherLine);
  await backButton(page).click();
  await waitForPath(shownPanel(page), long);
  // The editor comes back where it was left rather than at its top: what it draws is far into the file.
  await until(async () => (await drawnLines(page)).some((line) => line === longLine(lastLine)));
  assert.deepEqual(errors, []);
}));

test('navigation history recovers its position and follows workspace tab ownership', { timeout: 180000 }, () => withHome('wangcai-editor-recover', { ...lists, tabs: [editorPlugin] }, async ({ home, open }) => {
  let { page, close } = await open();
  const code = join(home, 'first.ts');
  const middle = join(home, 'middle.md');
  const latest = join(home, 'latest.md');
  const recoveredLine = 'const recovered = true;';
  const middleLine = 'middle-body';
  const latestLine = 'latest-body';
  const codeBody = `${firstLine}\n${recoveredLine}\n`;
  const middleBody = `# Middle page\n\n${middleLine}\n`;
  const latestBody = `# Latest page\n\n${latestLine}\n`;
  writeFileSync(code, codeBody);
  writeFileSync(middle, middleBody);
  writeFileSync(latest, latestBody);
  const codeVisit = visitTo(code);
  // A visit that names a place in the file, which the history records as it was given rather than by the line alone.
  const recoveredColumn = 3;
  const recoveredVisit = { ...codeVisit, line: codeBody.split('\n').indexOf(recoveredLine) + 1, column: recoveredColumn };
  const middleVisit = visitTo(middle);
  const latestVisit = visitTo(latest);
  const errors = [];
  collectErrors(page, errors);
  // The window closed and opened again on the same files, which is what the two readings below it start from.
  const reopen = async () => {
    await close();
    ({ page, close } = await open());
    collectErrors(page, errors);
  };
  // A plugin's menu entries are drawn when it registers its views, and the clicks below go to those views, so the entry
  // is waited for; the menu is closed at this point, which is why the entry is asked for as attached.
  await viewMenu(page).getByRole('button', { name: editorView, exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  await openVisit(page, recoveredVisit, recoveredLine);
  await openVisit(page, middleVisit, middleLine);
  await openVisit(page, latestVisit, latestLine);
  await showAfter(page, backButton(page), middleLine);
  assert.deepEqual((await storedHistory(page))[''], { entries: [recoveredVisit, middleVisit, latestVisit], index: 1 });
  await reopen();
  await lineShown(page, middleLine);
  assert.ok(await backButton(page).isEnabled());
  assert.ok(await forwardButton(page).isEnabled());
  await createWorkspace(page);
  const firstWorkspace = (await openWorkspaces(page))[0].id;
  await openVisit(page, middleVisit, middleLine);
  await goToPath(shownPanel(page), code);
  await showAfter(page, backButton(page), middleLine);
  await createWorkspace(page);
  const secondWorkspace = (await openWorkspaces(page))[1].id;
  await openVisit(page, latestVisit, latestLine);
  const history = await storedHistory(page);
  assert.ok(!('' in history));
  assert.deepEqual(history[firstWorkspace], { entries: [recoveredVisit, middleVisit, codeVisit], index: 1 });
  assert.deepEqual(history[secondWorkspace], { entries: [latestVisit], index: 0 });
  await reopen();
  await editorPanels(page).nth(1).waitFor({ state: 'attached' });
  assert.deepEqual(await storedHistory(page), history);
  const workspaces = workspaceTabs(page);
  await workspaces.first().click();
  const onlyTab = editorTab(page);
  assert.equal(await onlyTab.count(), 1);
  await showAfter(page, onlyTab, middleLine);
  const back = backButton(page);
  const forward = forwardButton(page);
  assert.ok(await shows(shownPanel(page), middle));
  assert.ok(await back.isEnabled());
  assert.ok(await forward.isEnabled());
  const historyPath = join(home, '.local/share/wangcai/data/editor/history.json');
  const mtimeBefore = statSync(historyPath, { bigint: true }).mtimeNs;
  await showAfter(page, refreshButton(page), middleLine);
  await onlyTab.click();
  // Asking for the history is a read: the file it comes from is not written again for it.
  await storedHistory(page);
  assert.equal(statSync(historyPath, { bigint: true }).mtimeNs, mtimeBefore);
  await showAfter(page, forward, recoveredLine);
  await showAfter(page, back, middleLine);
  await showAfter(page, back, recoveredLine);
  assert.ok(await shows(shownPanel(page), code));
  assert.ok(await back.isDisabled());
  await showFile(shownPanel(page), middle, middleLine);
  assert.ok(await forward.isDisabled());
  assert.deepEqual((await storedHistory(page))[firstWorkspace], {
    entries: [recoveredVisit, middleVisit], index: 1,
  });
  await workspaces.last().click();
  await showAfter(page, onlyTab, latestLine);
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());
  await drawnCloseButtons(page).last().click();
  const remaining = await storedHistory(page);
  assert.ok(!(secondWorkspace in remaining));
  assert.ok(firstWorkspace in remaining);
  // The workspace that is left still has its tab, and the entry it was left on.
  await workspaces.first().click();
  await showAfter(page, editorTab(page), middleLine);
  assert.ok(await back.isEnabled());
  assert.ok(await forward.isDisabled());
  assert.deepEqual(errors, []);
}));
