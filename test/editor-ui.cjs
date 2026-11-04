const { writeFileSync } = require('node:fs');
const { createWorkspace, openView, until } = require('@lengmoxxl/wangcai-testkit');

// The machine the window works on, which is the one a case's paths are read from.
const machine = { id: 'local', name: '本机' };

// What a case's window lists: the workspace a file link comes from, and the views the sidebar picks from.
const lists = { workspaces: ['terminal-agent'], tabs: ['editor', 'terminal'] };

// A list redraws as the app reports, which can take away the row a drag starts from between the wait that found it and
// the move that needs it, so a box is asked for again until one comes back.
const boxOf = async (locator) => {
  let locatorBox;
  await until(async () => (locatorBox = await locator.boundingBox()) !== null);
  return locatorBox;
};

// The title the editor's view is offered under, which is what a case opens and finds it by.
const editorView = '编辑器';

// The window's tab strips: a tab per workspace on the left, and the sidebar's own tabs on the right.
const workspaceBar = (page) => page.locator('.workspaces');
const workspaceTabs = (page) => workspaceBar(page).getByRole('tab');
const viewTab = (page, name) => page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name, exact: true });
const editorTab = (page) => viewTab(page, editorView);

// Every sidebar tab, hidden ones included, which is what their styles are read off; the one that is selected; the
// close button each of the drawn ones carries; and closing a named tab through the name its button is announced by.
const sidebarTabs = (page) => page.locator('.sidebar-tab');
const selectedViewTab = (page) => sidebarTabs(page).filter({ has: page.locator('[aria-selected=true]') });
const drawnCloseButtons = (page) => sidebarTabs(page).filter({ visible: true }).locator('.close-tab');
const closeTab = (page, name) => page.getByRole('button', { name: `关闭 ${name}`, exact: true });

// The window's two sidebars and the pane between them, plus the panel on show in the right one and every panel of this
// plugin, hidden ones included.
const sidebarLeft = (page) => page.locator('.sidebar-left');
const sidebarRight = (page) => page.locator('.sidebar-right');
const desktopMain = (page) => page.locator('.desktop-main');
const shownPanel = (page) => page.locator('.sidebar-panel:visible');
const editorPanels = (page) => page.locator('.sidebar-panel[data-plugin=editor]');

// The window's errors, which the cases collect and assert are empty.
const collectErrors = (page, errors) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
};

// The message the page shows for a path it cannot open: one it could not read, or one that is not there.
const alert = (page) => page.getByRole('alert');

// What the app keeps as it runs: the workspaces it has open, and the history this plugin has stored for them.
const openWorkspaces = (page) => page.evaluate(async () => (await window.wangcai.call('request', 'terminal-agent', 'config')).workspaces);
const storedHistory = (page) => page.evaluate(() => window.wangcai.call('request', 'editor', 'history'));

// A file link clicked in a terminal. The plugin subscribes as it mounts, so a click sent before that is gone.
const clickFile = (page, file) => page.evaluate((click) => window.wangcai.call('publish', 'onclick', click), file);

// The address box in the header.
const pathBox = (scope) => scope.getByRole('textbox', { name: '路径', exact: true });

// Pointing the panel at a path: the address box takes it and the panel reads that file. A box that has just appeared is
// still empty, since the workspace it resolves a path against is asked for when it mounts.
const goToPath = async (scope, path) => {
  const box = pathBox(scope).first();
  await box.waitFor();
  await until(async () => (await box.inputValue()) !== '');
  await box.fill(path);
  await box.press('Enter');
};
// Whether the address box names this path.
const shows = async (scope, path) => (await pathBox(scope).first().inputValue()) === path;
// The same read, waited for: a panel takes a path in on its own time.
const waitForPath = (scope, path) => until(() => shows(scope, path));

// The pane the plugin draws its editor in, which the text selectors below it are found from.
const codeSurface = (scope) => scope.locator('.editor-code');
// CodeMirror's editing element, which holds the text and is what a case waits for when it does not know the lines.
const codeContent = (scope) => codeSurface(scope).locator('.cm-content');
const codeShowing = (scope, text) => codeContent(scope).filter({ hasText: text });
// The line of the entry a press brought to the page, waited for: the page reads that file on its own time.
const lineShown = (page, line) => codeShowing(shownPanel(page), line).waitFor();
// A control of the header or the tab row pressed, waited for by the line it brings.
const showAfter = async (page, control, line) => {
  await control.click();
  await lineShown(page, line);
};
// A panel pointed at a file, waited for by a line the file holds — or, for a file with nothing in it, by the editor that
// draws it.
const showFile = async (scope, path, text) => {
  await goToPath(scope, path);
  await (text === undefined ? codeContent(scope) : codeShowing(scope, text)).waitFor();
};
const lineBoxes = (scope) => codeSurface(scope).locator('.cm-line');
// The lines the pane has drawn: a view that scrolled keeps the lines it drew before, so this is not only what is on
// screen.
const drawnLines = (page) => lineBoxes(page).evaluateAll((lines) => lines.map((line) => line.textContent ?? ''));
// CodeMirror marks the line the caret is on, and that mark does not follow the keyboard.
const activeLineBox = (scope) => codeSurface(scope).locator('.cm-activeLine');
// Whether the caret is on this line of the text.
const cursorAt = async (page, text) => (await activeLineBox(page).evaluate((active) => active.textContent ?? null)) === text;
// Whether the page shows that file with the cursor on that line. Read from the page itself, so this takes a page rather
// than a panel.
const landed = async (page, path, text) => (await shows(shownPanel(page), path)) && (await cursorAt(page, text));
const landedOn = (page, path, text) => until(() => landed(page, path, text));
// The class a selection is drawn with, which the marks are found by and a case reads back.
const selectionClass = 'cm-selectionBackground';
// The marks a selection is drawn as, one per line it covers.
const selectionMarks = (scope) => codeSurface(scope).locator(`.${selectionClass}`);

// Whether an editor in this window is holding the keyboard.
const editorFocused = (page) => codeSurface(page).evaluateAll((scopes) => scopes.some((scope) => scope.contains(document.activeElement)));

// The dot the language service behind the file is shown by, in the state it is asked about.
const lspDot = (scope, state) => scope.locator(`.editor-lsp.${state}`);
// The panel that names that service while the pointer rests on the dot.
const lspDetail = (scope) => scope.locator('.editor-lsp-detail');
// The panel a question about a place in the file opens, by the title the question gives it.
const placeList = (scope, title) => scope.getByRole('dialog', { name: title });
// The places that panel lists, one row each.
const placeRows = (list) => list.locator('.lsp-place');
// The file a row names, as the first part of the row shows it.
const placeFileName = (row) => row.locator('.lsp-place-file').innerText();
// That line of that file, which is what the page must draw when the row is opened.
const placeText = async (row, body) => {
  const [line] = (await row.locator('.lsp-place-at').innerText()).split(':');
  return body.split('\n')[Number(line) - 1];
};
// The tooltip a hover opens.
const hoverTips = (page) => page.locator('.cm-tooltip');
// The underline a diagnostic is drawn as.
const diagnostics = (scope) => codeSurface(scope).locator('[class*=cm-lintRange]');

// The buttons of a panel's header.
const backButton = (page) => page.getByRole('button', { name: '后退', exact: true });
const forwardButton = (page) => page.getByRole('button', { name: '前进', exact: true });
const refreshButton = (page) => page.getByRole('button', { name: '刷新', exact: true });

// The right sidebar is shown and hidden by its own button, and added to from the button beside it.
const sidebarToggle = (page) => page.getByRole('button', { name: '切换右侧栏' });
const newSidebarTab = (page) => page.getByRole('button', { name: '新建侧栏标签页' });

// The line typed into a terminal pane.
const runIn = async (pane, line) => {
  const page = pane.page();
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

// The menu a view is picked from, once that button has opened it.
const viewMenu = (page) => page.locator('#view-menu');

// The search picker a panel opens: the panel it draws in, the input a query goes into, the rows it found, and the message
// a search for files shows when it finds none.
const searchPanel = (scope) => scope.getByRole('dialog', { name: '搜索' });
const searchInput = (scope) => searchPanel(scope).getByRole('textbox', { name: '搜索' });
const searchRows = (scope) => searchPanel(scope).locator('.search-row');
const searchRow = (scope, text) => searchRows(scope).filter({ hasText: text }).first();
const filesEmpty = (scope) => searchPanel(scope).getByText('没有匹配的文件', { exact: true });
// The runs of text the picker marked in the title of a row: neighbouring hits share a run, not one character each.
const searchMarks = (row) => row.locator('.search-title b').allInnerTexts();

// The picker opened from the panel's header, with nothing in it yet.
const openSearch = async (scope) => {
  await scope.getByRole('button', { name: '搜索', exact: true }).click();
  await searchPanel(scope).waitFor();
};

// Enter opens the row under the selection, which closes the picker.
const submitSearch = async (scope) => {
  await searchInput(scope).press('Enter');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

// Escape closes an overlay of this plugin's — its menu or a panel of places — and waits for it to be gone.
const dismiss = async (panel) => {
  await panel.page().keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
};

// Escape leaves the picker without opening anything.
const dismissSearch = async (scope) => {
  await searchInput(scope).press('Escape');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

// The picker opened with a query in it, waited for its rows: a search answers a moment after the query is typed.
const search = async (scope, query) => {
  await openSearch(scope);
  await searchInput(scope).fill(query);
  await until(async () => (await searchRows(scope).count()) > 0);
};

// A workspace and the editor panel of it, which is the state most of these cases start from.
const openEditorWorkspace = async (page) => {
  await createWorkspace(page);
  await openView(page, editorView);
};

// A workspace opened, with one of its files shown: the panel on show, since a tab can be one of several.
// A file written out and shown, waited for by a line of it: the page reads the disk, so the write comes first.
const showWritten = async (page, path, body, line) => {
  writeFileSync(path, body);
  await openOn(page, path, line);
};
const openOn = async (page, path, text) => {
  await openEditorWorkspace(page);
  await showFile(shownPanel(page), path, text);
};

// Closes a workspace through the row's own menu, the way a person does.
const closeWorkspace = async (tab) => {
  await tab.click({ button: 'right' });
  await tab.page().getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
};

module.exports = {
  machine,
  lists,
  boxOf,
  workspaceBar,
  workspaceTabs,
  viewTab,
  editorTab,
  sidebarTabs,
  selectedViewTab,
  drawnCloseButtons,
  closeTab,
  editorView,
  sidebarLeft,
  sidebarRight,
  desktopMain,
  shownPanel,
  editorPanels,
  collectErrors,
  alert,
  openWorkspaces,
  storedHistory,
  clickFile,
  pathBox,
  goToPath,
  waitForPath,
  shows,
  lineShown,
  showAfter,
  showFile,
  showWritten,
  drawnLines,
  cursorAt,
  landed,
  landedOn,
  activeLineBox,
  codeShowing,
  editorFocused,
  lineBoxes,
  lspDot,
  lspDetail,
  placeFileName,
  placeList,
  placeRows,
  placeText,
  selectionClass,
  selectionMarks,
  hoverTips,
  diagnostics,
  codeSurface,
  backButton,
  forwardButton,
  refreshButton,
  sidebarToggle,
  newSidebarTab,
  runIn,
  viewMenu,
  searchPanel,
  searchInput,
  searchRows,
  searchRow,
  filesEmpty,
  searchMarks,
  openSearch,
  submitSearch,
  dismiss,
  dismissSearch,
  search,
  openEditorWorkspace,
  closeWorkspace,
};
