# 笔记类型体系

为知笔记的“类型”有两层，混在一起看很容易搞错：**原始 `type` 字段**（服务端存的字符串）和**应用归一化后的 `NoteType` 枚举**（7 个值）。脚本判定用的是后者。

- 判定逻辑：`src/export/note-type.ts`（与 renderer 一比一复刻）
- 转换实现：`src/export/note-content.ts` 的 `renderNote()`

---

## 一、原始 `type` 字段

存在服务端 / IndexedDB 的 `docs.type` 上，取值很杂，而且**不完全由 web 端定义**。

实际见过的取值，以及 web 端认不认：

| 原始 `type` | web 端认识？ |
| --- | --- |
| `''`（空字符串） | —（多数为空） |
| `document` | ✅ |
| `collaboration` | ✅ |
| `wholewebpage` | ❌ **两个产物里都 0 命中** |
| `lite/markdown` | ✅ |
| `outline` | ✅ |
| `tasklist` | ❌ **0 命中** |
| `article` | ❌（`article` 在 renderer 里出现 7 次，但都不是笔记类型） |
| `null` | — |
| `svgpainter` | ❌ **0 命中** |
| `handwriting` | ✅（源码支持，样本里没有） |
| `.mj` 标题 | ✅（同上） |

“web 端认识？”的判定方法是直接对 `https://wcdn.wiz.cn/xapp/0.1.107/renderer.dev.js` 和 `.../live-editor/index.js` 做字符串检索。`wholewebpage` / `tasklist` / `svgpainter` 在三处都搜不到，说明它们是**桌面端、移动端或服务端**写进去的，web 端没有专门处理。

### `fileType`：不是笔记类型，也不影响导出

`docs.fileType` 和 `type` 是两个不同的字段，实测见过的取值：

| `fileType` | 含义 |
| --- | --- |
| `''` | 普通 |
| `null` | 普通 |
| `'.mht'` | **当初保存成网页归档（MHT）的笔记** |
| `'att'` | 只有附件的笔记 |

`'.mht'` 一度让人担心“内容是 MHT 格式、`html2Doc` 可能拿不到正文，而且会静默失败”——所以按 `fileType` 分层抽样验证过。

**结论：完全没问题。** 服务端会用**同一套 HTML 渲染通道**输出，`/ks/note/view/…/index.html` 返回的是正常富文本 HTML，不是 MIME 归档：抽样笔记全部转换正常、零异常、图片可下载。

所以 `fileType` 只是**历史标记**（记录这篇当初怎么存进来的），既不参与类型判定，也不影响导出，**不需要任何特殊处理**。

`'att'` 那几篇也逐篇确认过：它们的 `rawType` 都是 `document`、`attachmentCount` 为 0、附件表里也没有记录，正文完整、转换正常。**`'att'` 是个名不副实的历史值** —— 看着像 attachment，实际跟附件毫无关系，语义不明但不影响处理。

**结论：`fileType` 的四个取值都不需要特殊处理**，一律按 `rawType` 走已有路径。

---

## 二、应用归一化后的 `NoteType`

renderer 里的判定函数（`src/export/note-type.ts` 复刻的就是它）：

```js
function getNoteType(note) {
  if (isCoEditNote(note.type))      return NoteType.Collaboration;   // type 以 collaboration 开头
  if (isMarkdownNote(note))         return isLiteNote(type) ? NoteType.LiteMarkdown : NoteType.NormalMarkdown;
  if (note.type === 'handwriting')  return NoteType.Handwriting;
  if (note.type?.toLowerCase() === 'outline') return NoteType.Outline;
  return /\.mj(\s|@|$)/i.test(note.title) ? NoteType.MathJax : NoteType.Normal;
}
// NoteType = { LiteMarkdown:0, NormalMarkdown:1, Outline:2, Collaboration:3,
//              MathJax:4, Handwriting:5, Normal:6 }
```

配套的判定函数：

| 函数 | 规则 |
| --- | --- |
| `isCoEditNote(type)` | `type` 以 `collaboration` 开头 |
| `isLiteNote(type)` | `type === 'lite'` 或以 `lite/` 开头 |
| `isMarkdownNoteTitle(title)` | 标题以 `.md` 结尾，或含 `.md ` / `.md@` |
| `isMarkdownNote(note)` | `type` 以 `/markdown`、`/md`、`/ma` 结尾，**或者**标题命中上一条 |

**注意判定顺序**：先看是否为协作笔记，再看是否像 markdown，最后才是兜底。所有 web 端不认识的原始 type（以及多数为空的 type、`null`）**都会落进 `Normal`**。

---

## 三、总表：界面名 / 判定 / 转换策略

| 界面显示 | `NoteType` | 判定 | 转换策略 | 产物 |
| --- | --- | --- | --- | --- |
| 旧版 Markdown 笔记 | `NormalMarkdown` | 像 markdown 但**不是** Lite | `index.html` → `html2Doc` → `doc2markdown` → 反转义 | `.md` |
| Lite Markdown 笔记 | `LiteMarkdown` | 像 markdown **且** `isLiteNote(type)` | `index.html` → 从 `<pre>` 抠 **markdown 原文** | `.md` |
| 协作笔记 | `Collaboration` | `type` 以 `collaboration` 开头 | `getOfflineDocData` → 必要时 `syncOfflineDoc` → `doc2markdown` | `.md` |
| 普通笔记 | `Normal` | 以上都不匹配 | 同“旧版 Markdown 笔记” | `.md` |
| 大纲笔记 | `Outline` | `type.toLowerCase() === 'outline'` | **自己遍历 `div.node` 树** → 嵌套 markdown 列表（不走 `html2Doc`，见 §五） | `.md` |
| 手写笔记 | `Handwriting` | `type === 'handwriting'` | **暂不支持** → 导原始 HTML | `.html` |
| 旧版公式笔记 | `MathJax` | 标题匹配 `/\.mj(\s\|@\|$)/i` | **暂不支持** → 导原始 HTML | `.html` |

---

## 四、逐个类型

### 旧版 Markdown 笔记（`NormalMarkdown`）

**本质上它就是一篇普通笔记**——内容按富文本 / HTML 存储，跟其它的备忘录没有区别。

老版 WizNote 渲染时**只看文件名里有没有 `.md`**：有就换一条渲染路径—— 把富文本内容**当作 markdown 纯文本**，再按 markdown 语法渲染成富文本。这是个挺别扭的约定：它既不是 markdown 源码，也**不是规规矩矩的富文本**，所以“把 HTML 还原成 markdown”（`html2Doc` → `doc2markdown`）本身就有损失。

对导出的两个直接影响：

1. 拿不到“markdown 原文”，只能从 HTML 反推；
2. 反推出来的 markdown 会被 `doc2markdown` **转义**（正文里的 `![](...)`、`[TOC]`、`**粗体**` 都是字面文本），所以导出前必须还原一次 —— 见 [export-pipeline.md § 六](export-pipeline.md#六富文本笔记里的markdown-字面文本要先反转义)。

> 判定只跟**标题**有关，跟内容无关，所以经常出现“标题带 `.md` 但内容是随手写的富文本”这种名不副实的情况。

### Lite Markdown 笔记（`LiteMarkdown`）

由当初的 **WizNote Lite 客户端**创建。Lite 的定位就是想取代上面那种别扭的旧版 Markdown 笔记（提供真正意义上的 markdown 笔记）。**该客户端已被放弃**，它的替代品是**协作笔记**。

正文是**真正的 markdown 源码**，被应用塞在 HTML 的 `<pre><!--wiznote-lite-markdown--></pre>` 里（`convertMarkdownToLite` 转换时写入，`type` 也写成 `lite/markdown`）。

导出时直接从这个 `<pre>` 里取原文，**不过任何转换器**，所以：

- 保真度最高，是唯一能拿到“用户手写 markdown”的类型；
- **不能对它做反转义** —— 里面的 `\_` 可能是用户故意写的；
- 少数空笔记会退回通用路径。

### 协作笔记（`Collaboration`）

协作笔记（co-edit），内容是 OT 文档，只在 OT 服务器上有权威副本。导出链路和其余类型差别最大：

- 正文只能靠 `LiveEditor.getOfflineDocData()` 从本地读，读不到就开一条只读 WebSocket（`LiveEditor.syncOfflineDoc`）同步下来；
- 同步需要知识库服务器地址 `kbServer`，它从 IndexedDB 的 `wiz-account/accounts` 里读；
- 图片走 `//wiznote-desktop/editor/{kb}/{doc}/resources/{名}`（或等价地直连真实源站）—— **SW 会按文件名先查本地 OT 缓存**，命中就本地返回，未命中才带 token 去源站（见 [site-internals.md §2.6](site-internals.md)）。虚拟主机那条路在缓存未命中时必然失败。

细节都在 [export-pipeline.md](export-pipeline.md)。三条坑（HTML 接口返回占位页、`location.origin` 不能猜、`index_files` 会返回假图）都写在那个文档里。

### 普通笔记（`Normal`）

兜底分支，包含三类：

1. 明确是普通富文本的 `document`；
2. 多数为空的 **`type`**；
3. web 端不认识的 `wholewebpage` / `tasklist` / `svgpainter` / `article`。

转换方式与“旧版 Markdown 笔记”完全相同。第 3 类属于**未验证区域**，见下方待办。

图片走 `/ks/note/view/{kb}/{doc}/index_files/{名}`（本地数据服务，**本地优先 + 联网兜底**），命中本地就零网络返回；本地没有时服务端会返回 **1×1 / 807 B 的占位 GIF**，必须靠 `looksLikePlaceholder()` 挡掉（并且要**按内容**认格式，别按扩展名 —— 见 [export-pipeline.md §4.1.1](export-pipeline.md)）。各类型的资源通道见 [site-internals.md §2.6](site-internals.md)。

### 大纲笔记（`Outline`）

正文是一棵**纯 `div.node` 树**（没有任何 `<ul>` / `<li>`），跟富文本完全不是一回事，所以**不走 `html2Doc`**：那条路（Turndown）会把树整个抹平。做法是自己遍历树、生成与 `doc2markdown` 同款的嵌套列表 markdown（每层 3 空格缩进 + `*`），实现见 `src/export/outline.ts`，实测与理由见 §五。

判定：`type.toLowerCase() === 'outline'`。

### 手写 / 旧版公式（暂不支持）

目前只导出原始 HTML（`.html`），并在结果里提示。判定都跟内容无关：

- `Handwriting` 靠 `type === 'handwriting'`；
- `MathJax` 靠**标题**匹配 `.mj`（历史遗留的旧版公式笔记）。

---

## 五、实测结论（2026-10-03）

每类取样本，抓 `/ks/note/view/…/index.html` 后跑 `html2Doc` → `doc2markdown`（即导出的实际路径），结果：

| 原始 `type` | 判定 | 实际结构 | 走通用路径的效果 |
| --- | --- | --- | --- |
| `''`（空） | `Normal` | 富文本，**普遍带多张图片** | ✅ 转得很好 |
| `document` | `Normal` / `NormalMarkdown` | 富文本 | ✅ |
| `collaboration` | `Collaboration` | OT 文档 | ✅（见 [export-pipeline.md](export-pipeline.md)） |
| `wholewebpage` | `Normal` | 富文本 + 源页地址（`docs.url`） | ✅ 未发现问题 |
| `lite/markdown` | `LiteMarkdown` | `<pre>` 里的 markdown 原文 | ✅ |
| **`outline`** | `Outline` | `div.outline-container > div.node > div.row` **嵌套** | ⚠️ `html2Doc` 会丢层级，所以**另走一条自研转换**，见下 |
| `tasklist` | `Normal` | 富文本（靠 `<br>` 换行） | ✅ 转得很好 |
| `article` | `Normal` | 富文本 + 图片 | ✅ 转得很好，图片正常下载 |
| `null` | `Normal` | 纯文本 | ✅ |
| `svgpainter` | `NormalMarkdown` | 富文本（标题恰好带 `.md`） | ✅ 转得很好 |

**结论：那 4 个“web 端不认识”的类型（`wholewebpage` / `tasklist` / `svgpainter` / `article`）当普通笔记处理是对的**，实测没发现内容或图片丢失。

### `outline` 为什么要自研转换

大纲笔记的层级**完全靠嵌套 `div` 表达，没有任何 `<ul>` / `<li>`**（实测 ul/li 计数为 0）：

```html
<body data-wiz-document-type="outline">
  <div class="outline-container">
    <div class="node">
      <div class="row">
        <div class="operator-container"><div class="switch active">…</div></div>
        <div class="content">节点文本</div>
      </div>
      <div class="child children">      ← 子节点容器；叶子节点没有它
        <div class="node">…</div>
      </div>
```

**走通用路径（`html2Doc`）不行**：那条路的 HTML→doc 是 Turndown + marked，实测会把整棵树**抹平**成一串平级文字（还夹着 `\*` 转义垃圾），而层级正是大纲的全部意义。

**但 doc 层是好的**：实测 `markdown2Doc → doc2markdown` 对嵌套列表**逐字节往返一致**（3 空格缩进、`*`、`\*` 转义、多层嵌套都对）。所以只要自己遍历树、生成与 `doc2markdown` 同款的嵌套列表文本即可 —— 实现是 `src/export/outline.ts`，**不走 `html2Doc`、也不做反转义**（节点文本是纯文本，转义是我们故意加的）；折叠状态不影响导出（它是编辑器的界面状态，不持久化、不改内容）。

逐条规则、验证方式与实测依据见 [export-pipeline.md §9.2](export-pipeline.md)。

> 顺带一个结论：`outline` 的 HTML 里没有 `<img>`、没有 `wiz://` 附件链接、也没有批注层，所以它只需要“层级”这一件事 —— 这也是自研转换能很小的原因。

> 导出的 HTML 会先过 `sanitizeNoteHtml()` 剥掉编辑器脚手架（否则 `body { opacity: 0 }` 会让双击打开一片空白）：这不只针对大纲笔记，所有导出 HTML 的路径都走它，见 [export-pipeline.md §3.2](export-pipeline.md)。

### 还没实测的

- `handwriting`（手写笔记）、旧版 `.mj` 公式笔记：**暂无这两类的真实样本**，尚未实测；这两类目前仍只导出原始 HTML。
