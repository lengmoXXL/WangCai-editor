# 旺财编辑器视图（editor）

旺财右侧的编辑器：一次显示一个文件（CodeMirror + vim 键），页头有返回、前进、刷新、地址框和搜索。

它会读一切能被当成文本的东西（代码、Markdown、HTML、JSON……），只按文字显示，只读，不写文件。
目录的遍历归 files 插件：在那里点一个文件就是送到这里（终端里点文件链接也一样）。
图片、渲染后的 Markdown 与 HTML 页面归 preview 插件。

## 配置

在 `~/.config/wangcai/init.ts` 的标签页条目里写 `config`，改完重启 App 生效：

```ts
// 文件由 files 送进来，又能从这里送到 preview，所以这两个插件也要在列表里。
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
| C / C++ | `c` `h` `cc` `cpp` `cxx` `hpp` `hh` |
| Go | `go` |
| YAML | `yaml` `yml` |
| Shell | `sh` `bash` `zsh`，以及 `.bashrc` `.zshrc` `.profile` |

表外的文件按纯文本显示。

## 键

编辑器只读，键就是 vim 的那一套（`@replit/codemirror-vim`）：两个模式都在，能改文本的命令因为只读而不生效。
键只在代码文本拿着键盘时算 vim 的键，下面两个是本插件自己的，不是 vim 的，对整页生效：

| 键 | 动作 |
| --- | --- |
| `<C-p>` | 把当前显示的文件交给 preview 插件 |
| `<leader>fe`（默认 `<Space>fe`） | 把本视图调到前面 |

## 搜索

页头的搜索按钮打开面板：直接打字是找文件名，前面加 `>` 是在工作区内容里搜。

