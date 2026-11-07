# 旺财编辑器视图（editor）

旺财右侧的编辑器：一次显示一个文件（CodeMirror + vim 键），页头有后退、前进、刷新、地址框、未写回标记、语言服务的状态圆点、打开所在目录、预览和搜索。

它会读一切能被当成文本的东西（代码、Markdown、HTML、JSON……），按文字显示、按 vim 的方式改，改完写回磁盘。
目录的遍历归 files 插件：在那里点一个文件就是送到这里（终端里点文件链接也一样）；反过来的路是页头的打开所在目录按钮，它把当前文件所在的目录交给 files 插件。
图片、渲染后的 Markdown 与 HTML 页面归 preview 插件，页头的预览按钮把文件交给它。

## 配置

在 `~/.config/wangcai/init.ts` 的标签页条目里写 `config`，改完重启 App 生效：

```ts
// files 和 preview 都与编辑器有交接，两个都要在列表里。
tabs: [
  { id: 'files' },
  { id: 'editor', config: { font: { size: 13 } } },
  { id: 'preview' },
  { id: 'terminal' },
],
```

### `font`

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `family` | `"DejaVuSansM Nerd Font Mono", monospace` | 面板与代码的字体 |
| `size` | `12` | 代码的字号（面板文字固定 12px） |
| `lineHeight` | 编辑器默认 | 行高，按 `size` 的倍数算 |

## 语法高亮

按文件后缀给语言，认得这些：

| 语言 | 后缀 |
| --- | --- |
| TypeScript | `ts` `mts` `cts` |
| JavaScript | `js` `mjs` `cjs` |
| TSX / JSX | `tsx` `jsx` |
| JSON | `json` |
| Markdown | `md` `markdown` |
| HTML | `html` `htm` |
| CSS | `css` |
| Python | `py` |
| Rust | `rs` |
| Java | `java` |
| C / C++ | `c` `h` `cc` `cpp` `cxx` `hpp` `hh` |
| Go | `go` |
| YAML | `yaml` `yml` |
| Shell | `sh` `bash` `zsh`，以及 `.bashrc` `.zshrc` `.profile` |

表外的文件按纯文本显示。

## 键

键就是 vim 的那一套（`@replit/codemirror-vim`）：插入模式改的是当前文件的文本。
下面这些是本插件接过来的：

- `gd`、`gD`、`gr`、`<C-s>`：这个库没绑定（`gd` 在 Vim 里本来是跳局部声明）。
- `gi`（先到上次编辑处再插入）、`<C-o>`、`<C-i>`（跳转）、`<C-f>`（翻页）、`:w`：库里本来就有，被本插件改成了下面的
  意思，其中 `:w` 在库里映射到一个什么都不落盘的 `write`。

普通模式下，代码文本拿着键盘时：

| 键 | 动作 |
| --- | --- |
| `gd` | 转到定义 |
| `gi` | 转到实现 |
| `gD` | 转到类型定义 |
| `gr` | 查找引用 |
| `:w` | 把当前文件写回磁盘 |

要离开这段文字、把键交回窗口，用 Ctrl+Shift+Q：这一下同时结束正在开着的插入模式，点回文字时落在普通模式。

只要焦点不在输入框里（比如停在页头的按钮上）：

| 键 | 动作 |
| --- | --- |
| `<C-o>` `<C-i>` | 在标签页的历史里后退、前进，也就是页头的后退、前进 |
| `<C-f>` | 打开搜索面板 |
| `<C-s>` | 把当前文件写回磁盘 |

`<leader>e`（默认 `<C-Space>e`）由窗口注册，哪个视图在前台都有效，按下去把本视图调到前面。

## 未写回的改动

文本改过而没写回文件时，地址框右边有一个 `*`。改动留在内存里：切到别的文件再切回来，改的东西还在；
点刷新或者文件在磁盘上被别人改了，读的是磁盘上的那份，没写回的改动就没了。

## 搜索

页头的搜索按钮打开面板：直接打字是在工作区的路径里找文件（整条相对路径都参与匹配），
前面加 `>` 是在工作区内容里搜，选中结果就跳过去。

`@` 按层级显示当前文件的声明，包括类型、命名空间、函数、常量和成员；普通变量不列，函数和常量内部不展开。
输入名称过滤时，保留命中的声明及其祖先，选中后跳到对应位置。

## 语言服务

按语言起一个服务：`config.lsp` 按语言 id 分键（`typescriptreact` 这类，不是 `tsx` 后缀）。
每一项里写 `command`（含参数）或 `markers` 就换掉对应的一项，没写的沿用默认；`false` 关掉这个语言。

服务在文件所在的机器上启动，根是离文件最近的标记文件（`.git` 也算一个）所在处；同一个根、同一种语言的每个文件共用
一个服务。

| 语言 id | 默认命令 | 找根的标记 |
| --- | --- | --- |
| `typescript` `javascript` `typescriptreact` `javascriptreact` | `typescript-language-server --stdio` | `tsconfig.json` `jsconfig.json` `package.json` |
| `go` | `gopls` | `go.mod` `go.work` |
| `rust` | `rust-analyzer` | `Cargo.toml` |
| `c` `cpp` | `clangd` | `compile_commands.json` `.clangd` `CMakeLists.txt` |
| `java` | `jdtls` | `pom.xml` `build.gradle` `build.gradle.kts` `settings.gradle` `settings.gradle.kts` |
| `python` | `pyright-langserver --stdio`，没有就用 `pylsp` | `pyproject.toml` `setup.py` `requirements.txt` |
| `shell` | `bash-language-server start` | 无 |

```ts
// 写在 editor 那一项的 config 里，上面那个 tabs 写法照旧。
config: { lsp: { go: { command: ['gopls', '-remote=auto'] }, python: false } },
```

页头的圆点是当前文件的服务：运行中、正在启动、已退出、未启动，悬停看服务名、根目录和它最后写出的错误，点一下
重启。

服务自己退出会被重试三次（间隔 1s、3s、7s），稳定跑满 30 秒之后这三次会还回来；最后一个需要它的标签页关掉时，
服务一起关。

服务给编辑器的东西：诊断（画成下划线）、代码里名字上的悬停、搜索面板里的 `@` 符号，还有右键菜单里的跳转与引用：

| 动作 | 说明 |
| --- | --- |
| 转到定义、实现、类型定义 | 服务声明了哪项就列哪项；找到一处就跳过去，找到不止一处时列成一张表挑一处 |
| 查找引用 | 服务给出的每一处都列成一张表 |

右键菜单和结果表里的行用鼠标点，也可以用 vim 的 `j`、`k` 走、`Enter` 打开，`Esc` 关掉。
