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

// The window's tab strips: a tab per workspace on the left, and the sidebar's own tabs on the right.
const workspaceBar = (page) => page.locator('.workspaces');
const workspaceTabs = (page) => workspaceBar(page).getByRole('tab');
const viewTab = (page, name) => page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name, exact: true });
const editorTab = (page) => viewTab(page, '编辑器');

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
// The address box shows a path once the panel has taken it in.
const waitForPath = (scope, path) => until(async () => (await pathBox(scope).first().inputValue()) === path);

// The code a panel's editor shows.
const editorLines = (scope) => scope.locator('.editor-code .cm-content');
const codeView = (scope, text) => editorLines(scope).filter({ hasText: text });
// A panel pointed at a file, waited for by a line the file holds — or, for a file with nothing in it, by the editor that
// draws it.
const showFile = async (scope, path, text) => {
  await goToPath(scope, path);
  await (text === undefined ? editorLines(scope) : codeView(scope, text)).waitFor();
};
// The lines the editor has drawn: a view that scrolled keeps the ones it drew before, so this is not only what is on
// screen.
const drawnLines = (page) => page.evaluate(() => [...document.querySelectorAll('.editor-code .cm-line')].map((line) => line.textContent ?? ''));

// The line the caret is drawn on: the editor marks it, and the mark is the line the keyboard is on.
const cursorLine = (page) => page.evaluate(() => {
  const active = document.querySelector('.editor-code .cm-activeLine');
  return active ? active.textContent : null;
});
const waitForLine = (page, text) => until(async () => (await cursorLine(page)) === text);
// A jump that landed: the page shows that file, with the cursor on that line. The cursor is read from the page itself, so
// this takes a page rather than a panel.
const landedOn = async (page, path, line) => {
  await waitForPath(shownPanel(page), path);
  await waitForLine(page, line);
};

// Whether the keyboard is in this editor.
const editorFocused = (page) => page.evaluate(() => Boolean(document.activeElement?.closest('.editor-code')));

// The dot the language service behind the file is shown by, in the state it is asked about, and the panel that names the
// service while the pointer rests on it.
const lspDot = (scope, state) => scope.locator(`.editor-lsp.${state}`);
const lspDetail = (scope) => scope.locator('.editor-lsp-detail');
// The list of references a menu entry opens, and the rows it holds.
const referenceList = (scope) => scope.getByRole('dialog', { name: '引用' });
const referenceRows = (scope) => referenceList(scope).locator('.lsp-reference');
// What the language service draws in the editor: the tooltip a hover opens, and the underline of a diagnostic.
const hoverTips = (page) => page.locator('.cm-tooltip');
const diagnostics = (scope) => scope.locator('.editor-code [class*=cm-lintRange]');
// The box the text is drawn in, which a case measuring where the editor ends takes.
const codeSurface = (scope) => scope.locator('.editor-code');

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

// Escape closes an overlay of this plugin's — its menu or its list of references — which the page waits out before the
// next question.
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
  await openView(page, '编辑器');
};

// A workspace opened, with one of its files shown: the panel on show, since a tab can be one of several.
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
  codeView,
  showFile,
  drawnLines,
  cursorLine,
  waitForLine,
  landedOn,
  editorFocused,
  lspDot,
  lspDetail,
  referenceList,
  referenceRows,
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
  openOn,
  closeWorkspace,
};
