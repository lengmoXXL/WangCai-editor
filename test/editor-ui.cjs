const { writeFileSync } = require('node:fs');
const { configure, until } = require('@lengmoxxl/wangcai-testkit');

// Concurrent Electron windows share the same machine and can take longer to start.
configure({ timeout: 120000, actionTimeout: 60000 });

const machine = { id: 'local', name: '本机' };

const terminalAgentPlugin = 'terminal-agent';
const editorPlugin = 'editor';
const terminalPlugin = 'terminal';
const filesPlugin = 'files';

const lists = { workspaces: [terminalAgentPlugin], tabs: [editorPlugin, terminalPlugin] };

const editorView = '编辑器';

const workspaceBar = (page) => page.locator('.workspaces');
const workspaceTabs = (page) => workspaceBar(page).getByRole('tab');

const createWorkspace = async (page) => {
  const next = await workspaceTabs(page).count();
  const bar = workspaceBar(page);
  let box;
  await until(async () => (box = await bar.boundingBox()) !== null);
  // Open the workspace menu in the empty space below the rows.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: 'right' });
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await workspaceTabs(page).nth(next).and(page.getByRole('tab', { selected: true })).waitFor();
};

const editorTab = (page) => page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab', { name: editorView, exact: true });
const drawnCloseButtons = (page) => page.locator('.sidebar-tab').filter({ visible: true }).locator('.close-tab');
const sidebarPanels = (page) => page.locator('.sidebar-panel');
const shownPanel = (page) => sidebarPanels(page).filter({ visible: true });

const editorPanels = (page) => sidebarPanels(page).and(page.locator(`[data-plugin=${editorPlugin}]`));

const filesColumn = (page, directory) => page.getByRole('navigation', { name: directory, exact: true });

const collectErrors = (page, errors) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
};

const alert = (scope) => scope.getByRole('alert');

const openWorkspaces = (page) => page.evaluate(async (plugin) => (await window.wangcai.call('request', plugin, 'config')).workspaces, terminalAgentPlugin);
const localMachineState = (page) => page.evaluate(async ({ plugin, id }) => {
  const states = await window.wangcai.call('request', plugin, 'states');
  return states.find(state => state.machineId === id);
}, { plugin: terminalAgentPlugin, id: machine.id });
const storedHistory = (page) => page.evaluate((plugin) => window.wangcai.call('request', plugin, 'history'), editorPlugin);

// The editor receives file clicks once its subscription has mounted.
const clickFile = (page, file) => page.evaluate((click) => window.wangcai.call('publish', 'onclick', click), file);

const pathBox = (scope) => scope.getByRole('textbox', { name: '路径', exact: true });

// A freshly mounted address box stays empty until the workspace directory resolves.
const goToPath = async (scope, path) => {
  const box = pathBox(scope).first();
  await box.waitFor();
  await until(async () => (await box.inputValue()) !== '');
  await box.fill(path);
  await box.press('Enter');
};
const shows = async (scope, path) => (await pathBox(scope).first().inputValue()) === path;
const waitForPath = (scope, path) => until(() => shows(scope, path));

const codeSurface = (scope) => scope.locator('.editor-code');
const codeContent = (scope) => codeSurface(scope).locator('.cm-content');
const codeShowing = (scope, text) => codeContent(scope).filter({ hasText: text });
const lineShown = (page, line) => codeShowing(shownPanel(page), line).waitFor();
const showAfter = async (page, control, line) => {
  await control.click();
  await lineShown(page, line);
};
const showFile = async (scope, path, text) => {
  await goToPath(scope, path);
  await (text === undefined ? codeContent(scope) : codeShowing(scope, text)).waitFor();
};
const lineBoxes = (scope) => codeSurface(scope).locator('.cm-line');
// CodeMirror can keep drawn lines outside the visible viewport.
const drawnLines = (page) => lineBoxes(page).evaluateAll((lines) => lines.map((line) => line.textContent ?? ''));
const activeLineBox = (scope) => codeSurface(scope).locator('.cm-activeLine');
const cursorAt = async (page, text) => (await activeLineBox(page).evaluate((active) => active.textContent ?? null)) === text;
const landedOn = (page, path, text) => until(async () => (await shows(shownPanel(page), path)) && (await cursorAt(page, text)));
const selectionClass = 'cm-selectionBackground';
const selectionMarks = (scope) => codeSurface(scope).locator(`.${selectionClass}`);

// The rendered Markdown table paints its own cell selection.
const tableGrid = (scope) => codeSurface(scope).locator('.cm-md-table');
const tableCells = (scope) => tableGrid(scope).locator('td');
const pickedCells = (scope) => tableGrid(scope).locator('.cm-md-table-picked');

const taskBoxes = (scope) => codeSurface(scope).locator('.cm-md-task');
const taskMarkers = (scope) => codeSurface(scope).locator('span').filter({ hasText: /^\[[ x]\]$/ });

// Measure against the adjacent text node to exclude line padding.
const taskCentreDelta = (scope) => taskBoxes(scope).first().evaluate((box) => {
  const b = box.getBoundingClientRect();
  const r = document.createRange();
  r.selectNodeContents(box.closest('.cm-line').lastChild);
  const t = r.getBoundingClientRect();
  return Math.abs((b.y + b.height / 2) - (t.y + t.height / 2));
});

const clearClipboard = (page) => page.evaluate(() => navigator.clipboard.writeText(''));
const clipboardText = (page) => page.evaluate(() => navigator.clipboard.readText());

const editorFocused = (page) => codeSurface(page).evaluateAll((scopes) => scopes.some((scope) => scope.contains(document.activeElement)));

const dirtyMark = (scope) => scope.locator('.editor-dirty');

const typeInto = async (page, text) => {
  await until(() => editorFocused(page));
  await page.keyboard.press('i');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await dirtyMark(shownPanel(page)).waitFor();
};

const lspDot = (scope, state) => scope.locator(`.editor-lsp.${state}`);
const lspDetail = (scope) => scope.locator('.editor-lsp-detail');
const noServerReason = async (page) => {
  const dot = lspDot(shownPanel(page), 'missing');
  const detail = lspDetail(shownPanel(page));
  let reason = '';
  await until(async () => {
    await dot.hover();
    reason = await detail.evaluateAll(([el]) => el?.checkVisibility() ? el.innerText : '');
    return reason.includes('未启动');
  });
  return reason;
};
const placeList = (scope, title) => scope.getByRole('dialog', { name: title });
const placeRows = (list) => list.locator('.lsp-place');
const placeFileName = (row) => row.locator('.lsp-place-file').innerText();
const placeText = async (row, body) => {
  const [line] = (await row.locator('.lsp-place-at').innerText()).split(':');
  return body.split('\n')[Number(line) - 1];
};
const hoverTips = (page) => page.locator('.cm-tooltip');
const diagnostics = (scope) => codeSurface(scope).locator('[class*=cm-lintRange]');

const backButton = (page) => page.getByRole('button', { name: '后退', exact: true });
const forwardButton = (page) => page.getByRole('button', { name: '前进', exact: true });
const refreshButton = (scope) => scope.getByRole('button', { name: '刷新', exact: true });
const openDirectoryButton = (page) => page.getByRole('button', { name: '打开所在目录', exact: true });

const viewMenu = (page) => page.locator('#view-menu');

const searchPanel = (scope) => scope.getByRole('dialog', { name: '搜索' });
const searchInput = (scope) => searchPanel(scope).getByRole('textbox', { name: '搜索' });
const searchRows = (scope) => searchPanel(scope).locator('.search-row');
const searchRow = (scope, text) => searchRows(scope).filter({ hasText: text }).first();
const searchRowNamed = (scope, name) => searchRows(scope).and(scope.getByRole('button', { name, exact: true }));
const fileSearchEmpty = (scope) => searchPanel(scope).getByText('没有匹配的文件', { exact: true });

// The visible parent is the nearest preceding row with a shallower depth.
const searchRowEntries = (scope) => searchRows(scope).evaluateAll((rows) => {
  const entries = rows.map((row) => ({ text: row.innerText, depth: Number(getComputedStyle(row).getPropertyValue('--depth')) }));
  return entries.map((row, place) => ({ ...row, holder: entries.slice(0, place).findLast((above) => above.depth < row.depth)?.text }));
});

const titleRunSelector = '.search-title b';
const searchMarks = (row) => row.locator(titleRunSelector).allInnerTexts();
// Wait for a match highlight so the previous query's rows cannot satisfy the check.
const queryApplied = (scope) => until(() => searchRows(scope).evaluateAll((rows, selector) => rows.some((row) => row.querySelector(selector) !== null), titleRunSelector), { timeout: 60000 });

const openSearch = async (scope) => {
  await scope.getByRole('button', { name: '搜索', exact: true }).click();
  await searchPanel(scope).waitFor();
};

const submitSearch = async (scope) => {
  await searchInput(scope).press('Enter');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

const dismiss = async (panel) => {
  await panel.page().keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
};

const dismissSearch = async (scope) => {
  await searchInput(scope).press('Escape');
  await searchPanel(scope).waitFor({ state: 'detached' });
};

const search = async (scope, query) => {
  await openSearch(scope);
  await searchInput(scope).fill(query);
  await until(async () => (await searchRows(scope).count()) > 0);
};

const openEditorWorkspace = async (page) => {
  await createWorkspace(page);
  const addTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await addTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await addTab.click();
  await viewMenu(page).getByRole('button', { name: editorView, exact: true }).click();
};

const showWritten = async (page, path, body, line) => {
  writeFileSync(path, body);
  await openEditorWorkspace(page);
  await showFile(shownPanel(page), path, line);
};

const closeWorkspace = async (tab) => {
  await tab.click({ button: 'right' });
  await tab.page().getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
};

module.exports = {
  machine,
  editorPlugin,
  filesPlugin,
  lists,
  editorView,
  workspaceTabs,
  createWorkspace,
  editorTab,
  drawnCloseButtons,
  shownPanel,
  editorPanels,
  filesColumn,
  collectErrors,
  alert,
  openWorkspaces,
  localMachineState,
  storedHistory,
  clickFile,
  goToPath,
  shows,
  waitForPath,
  codeSurface,
  codeContent,
  codeShowing,
  lineShown,
  showAfter,
  showFile,
  lineBoxes,
  drawnLines,
  activeLineBox,
  cursorAt,
  landedOn,
  selectionClass,
  selectionMarks,
  tableGrid,
  tableCells,
  pickedCells,
  taskBoxes,
  taskMarkers,
  taskCentreDelta,
  clearClipboard,
  clipboardText,
  editorFocused,
  dirtyMark,
  typeInto,
  lspDot,
  lspDetail,
  noServerReason,
  placeList,
  placeRows,
  placeFileName,
  placeText,
  hoverTips,
  diagnostics,
  backButton,
  forwardButton,
  refreshButton,
  openDirectoryButton,
  viewMenu,
  searchPanel,
  searchInput,
  searchRows,
  searchRow,
  fileSearchEmpty,
  searchRowEntries,
  searchRowNamed,
  searchMarks,
  queryApplied,
  openSearch,
  submitSearch,
  dismiss,
  dismissSearch,
  search,
  openEditorWorkspace,
  showWritten,
  closeWorkspace,
};
