# AGENTS.md

给在这个仓库里干活的 AI 编码助手（以及新加入的开发者）的约定。人读的开发流程在 [docs/development.md](docs/development.md)，使用说明在 [README.md](README.md)。

## 一分钟了解

- **是什么**：为知笔记 Web 版（`wiz.cn/xapp`）的油猴脚本（UserScript）。
- **功能**：① 笔记导出为 Markdown（列表 / 阅读界面右键）；② 修复 PWA 离线时公式渲染报错。
- **技术栈**：TypeScript + Vite + `vite-plugin-monkey`；**无前端框架**，UI 是手写 DOM + Shadow DOM。
- **入口**：`src/main.ts`。`installOfflineMathJax()` 在**模块顶层同步执行**（`document-start` 就要占住 `window.MathJax`，必须抢在页面脚本之前）；其余 feature 由 `onDomReady` 后的 `bootstrap()` 串联。

## 硬约束（别顺手改坏）

这些约束**违反了不一定当场报错**，通常要到具体场景或 review 时才暴露 —— 动手前先确认自己没踩。

1. **`src/export/app-bridge.ts` 是唯一允许接触宿主内部结构的文件**，例外只有两处、且都要在 [docs/export-pipeline.md §十一](docs/export-pipeline.md) 的契约清单里登记：`export-menu.ts` 里的菜单选择器；`comments.ts` / `note-content.ts` / `outline.ts` 对**笔记内容结构**的只读解析（协作笔记 doc JSON 的评论锚点与 `type: 'embed'` 块、笔记 HTML 里的附件引用、大纲笔记的 `div.node` 树等）。
2. **样式分两层**：面板与 toast 必须留在 Shadow DOM（`panel.css`）；只有注入宿主右键菜单的菜单项样式才放 `style.css`。`--wze-*` 变量在 `style.css` 定义，靠继承进入 Shadow DOM。
3. `panel.css` 顶部的 `[hidden] { display: none !important }` **不能删** —— 作者样式里的 `display: flex` 会盖掉 UA 的 `[hidden]` 规则。
4. **注入宿主菜单的项**要：挂宿主自己的 MUI 类名（对齐外观）、放在整张菜单**最后一项**、并在注入后确认菜单没被顶出视口（`keepListMenuInViewport()`）。宿主只在插入菜单那一刻定位，不会自己重算。
5. **模态壳**（`src/ui/kit/modal.ts`）的关闭手势规则导出与设置**共用**：× 与 Esc 都只是“请求关闭”，由调用方裁决 —— 导出的**已开始任务**（排队 / 导出中 / **已结束**）一律**最小化**，只有草稿才真的丢弃；已结束后唯一的不可逆出口是底部“关闭”，它带一条确认行；点空白不关闭。**焦点也归这个壳管**（初始焦点落在容器自己、Tab 在对话框内环绕、点遮罩不丢焦点、关闭后还给打开它的元素），两个对话框共用，别在调用方另写一套、也别把它们挪进业务里。配套的一条硬规矩：**任务状态只在 `src/export/session.ts` 里改**，对话框与悬浮条都只是它的视图，别在视图里另存一份进度 / 结果（左栏的页签与滚动位置也一样，`task.listScroll`）。改之前先读 [docs/export-pipeline.md §1.2、§1.5](docs/export-pipeline.md)。
6. **会丢东西的动作一律用 `src/ui/kit/confirm.ts` 的确认行**（一句后果说明 + [不做] [执行]），别再各写一套：模态里挂 `ModalHandle.notice`（横幅放通知、notice 放决策，两槽并存），悬浮条里挂进任务卡片。“按钮变色 / 再点一次”那套已废弃 —— 说不出后果，还是隐性状态。契约见 [docs/export-pipeline.md §1.6](docs/export-pipeline.md)。
7. **反转义（`src/export/markdown-inline.ts` 的 `unescapeMarkdown()`）只作用于 `html2Doc → doc2markdown` 这条路**，且**只还原宿主 `escapeMarkdownText()` 真会转义的那几个字符**（`[ ] _ *`）—— 反斜杠与 `$` **刻意不还原**（公式里的 `\\` 是 LaTeX 换行；正文里的 `\$` 还原了反而可能被配成公式）。照抄 CommonMark 的标点全集会把 `\|` `\{` `\(` 这些公式原文改坏（实测 bug，见 [docs/export-pipeline.md §6.1](docs/export-pipeline.md)）。Lite Markdown 笔记的正文是用户手写的 markdown，里面的 `\_` 可能是故意写的，**绝对不能动**。
8. 不引入前端框架，运行时依赖保持克制（现有两个：`fflate` 做 zip、`js-yaml` 做 YAML 序列化 —— 后者是因为手写引号 / 转义实测有坑，见 [docs/export-pipeline.md §8.5](docs/export-pipeline.md)）。DOM 用 `src/ui/kit/el.ts` 的工厂构造。
9. **zip 内的文件名 / 目录名只由 `src/export/naming.ts` 决定**：先 `convertToValidFilename()` 对齐上游，再 `portableName()` 落盘加固（保留名 / 尾部点 / 控制字符 / 超长），最后由 `createNameAllocator()` 唯一化 —— 撞名统一加 ` (N)` 后缀（N 从 2 起），查重 key 做 NFC + 大小写折叠，**落盘不改原名里的任何字符**。别再在任何地方手写“拼路径 + 加序号”或另写一套清洗（见 [docs/export-pipeline.md §1.4](docs/export-pipeline.md)）。
10. **“理论上不该发生”的事只有一种姿势**：走 `invariant()`（`src/utils/invariant.ts`）—— 开发模式抛错、生产构建只 `log.error`。别各处手写 `if (...) throw`，也别静默忽略。生产不抛是刻意的：导出是分钟级长流程，抛错会让对话框的 catch 作废整份成果。
11. **整体进度 = “已完成篇数 + 当前篇内部比例”÷ 总篇数**（`session.ts` 的 `overallProgress()`）：**不是** `index / total` —— 后者一进最后一篇进度条就满了，和“还剩最后一篇没导完”是矛盾的。跑的过程中最多 99%，满格只留给任务真的结束（`applyOutcome()`）。**唯一的例外是扫描期**：那一段拿不出百分比，底部用**不确定**进度条（`.wze-export-bar-indeterminate`）表示“在动”，别把它改成确定进度、也别把 `running` 改成不确定。改这条之前先读 [docs/export-pipeline.md §1.5](docs/export-pipeline.md)。
12. **`cursor: pointer` 只用于超链接**。按钮、可点行、勾选项、菜单项等一律保持默认箭头：可供性交给 **hover 底色**（`--wze-hover`）承担；`<a href>` 浏览器 UA 默认就是 pointer 无需再改。理由：CSS UI 规范里 pointer 的定义就是 “indicates a link”，macOS / Windows 原生控件惯例也是箭头。**同理，整行可点的元素必须有键盘等价物**（`tabindex="0"` + `Enter` / `Space` 等价于点击 + `:focus-visible` 那圈）：hover 底色只服务鼠标。行里还装着别的控件时用 `role="group"` 而不是 `role="button"`（后者的子节点会被无障碍树当成纯装饰，里面的按钮会消失），见 [docs/export-pipeline.md §1.5](docs/export-pipeline.md)。
13. **调试输出统一走 `logger(scope)`**（`src/utils/log.ts`），`log.debug` 默认关闭；别直接 `console.log` —— 调试日志关掉之后那些输出会变成不可控的噪音。
14. **藏悬浮条用的是 `visibility: hidden`**（`panel.css` 的 `:host(.wze-dialog-open)`），**别改回 `display: none`**：藏起来的东西仍然要占着盒子。对话框收起时的落点就是悬浮条的盒子，而悬浮条常常是**在对话框还开着的时候**才被建出来的（第一次把任务收进去），`display: none` 会让那一刻谁也量不出落点，收起动画就只剩原地缩一下（症状：合并版悬浮条有方向、单任务版没有）。同理，`ui/export-dialog.ts` 的 `minimize()` 里**先** `notifyTasks()` 让它就位、**再** `closeDialog(getBarAnchor())`，顺序反了锚点就是空的。细节见 [docs/export-pipeline.md §1.5](docs/export-pipeline.md)。
15. **中止只有一条通道：一个 `AbortSignal`**（`session.ts` 的 `activeAbort` → `task.ts` 的 `hooks.signal` → `note-content.ts` → `app-bridge` 的每个 `fetch`）。**别**再在任务上挂 `cancelRequested` 之类的第二个标志 —— 两个真相源迟早不同步（请求已被掐断、标志还没置上）；判定一律 `signal.aborted`。中止打断的那一步带回来的“取不到”是中止的副作用，`task.ts` 会整篇作废它，**别**把它当成本篇的结论。不可中止的等待（应用的 `syncOfflineDoc`）用 `utils/abort.ts` 的 `raceAbort()` 收口。见 [docs/export-pipeline.md §1.7](docs/export-pipeline.md)。
16. **收尾打包不许把主线程占死**：`archive.ts` 的 `buildZip()` 是**流式 + 逐文件让出**（让出走 `src/utils/yield.ts` 的 `createYielder()`：`MessageChannel`，不是 `setTimeout` / `requestAnimationFrame` —— 后台标签页会把它们节流掉；**只在连续占用 ≥ 16ms 后才真的让**），并对已压缩格式跳过 deflate。别为了“简单”换回 `zipSync`：那是长流程里最长的一次冻结，中止之后尤其刺眼。打包**不可中止**（中止只承诺“不再往下导”）。篇内那几趟同步活（宿主 `html2Doc` / `doc2markdown`、`DOMParser`、一遍遍全篇 regex、编码）同样要插让出点，见 [docs/export-pipeline.md §1.8](docs/export-pipeline.md)。
17. **资源校验按“内容”认格式，不许按扩展名查表**，并且**先挡占位图再认格式**（`app-bridge.ts` 的 `sniffImageFormat()` / `looksLikePlaceholder()`）。理由都是实测：真实资源里有一批**扩展名与内容不符**的好图（`.png` 里是 JPEG、`.jpg` 里是 PNG、`.gif` 里是 PNG、`.bmp` 里是 WOFF 字体），按扩展名查表会把它们全判成“图片没取到”；反过来占位图是 1×1 / 807 字节的 GIF、content-type 还会跟着请求的扩展名撒谎，对 `.gif` 名字只有“1×1 + 正好 807 字节”挡得住。改这里之前读 [docs/export-pipeline.md §4.1.1](docs/export-pipeline.md)。
18. **正文为空不是问题**：空笔记同样要导出（产物就是元数据；勾了评论 / 附件时对应章节也不能因为“正文是空的”被丢掉），**别**再加“内容为空就跳过”。另一条同源的纪律：宿主 `html2Doc` 解析失败时**不能整篇丢** —— 先摘掉没有单元格的 `<table>` 重试（实测这种表会让它返回 `undefined`），仍失败且用户勾了“同时导出原始 HTML”就把原文按 HTML 产物落盘，没勾才跳过、且提示必须可操作。见 [docs/export-pipeline.md §5.4](docs/export-pipeline.md)。
19. **所有可能打到后端的请求都要走 `app-bridge` 的 `pacedFetch()`**（图片 / 附件 / 正文 `index.html` / 评论 / 附件清单与详情），**别在别处直接 `fetch()`** —— 那样就绕过了节流。节流是“**网络请求的起始时刻**之间至少隔 60ms”的限速器，**不是**“每个请求结束再睡 60ms”：本地命中（`cameFromCache()`，`deliveryType === 'cache'`）会把名额还回去且**结算必须推迟到下一次领号**（timing 条目要等响应体读完才出现），慢请求则自己就把间隔吃掉。所以**也别在调用方再写固定 sleep**（`task.ts` 里那两处已删）。判定拿不到条目时一律按“走了网络”处理 —— 判错方向只能是多等。见 [docs/export-pipeline.md §十](docs/export-pipeline.md)。

## 文档与信息纪律

**1. 个人信息绝不进被跟踪的文件。** 作者本人环境产生的数据一律放 **`docs/private.local/`**，根 `.gitignore` 已经忽略 `*.local/`、`*.local`、`*.local.*`。

**算私有**（只能写进 `private.local/`）：库规模与任何按库统计的计数（多少篇笔记、各类型各多少篇、缓存覆盖多少篇…）；具体笔记的标题、正文片段、资源文件名、字节数；账号标识（`kbGuid`、`kbServer` 含 `vipkshttpsN` 分片、`token`、`serverUrl`）；本机绝对路径与用户名之类。

**可以进公开文档**：机制、代码路径、上游契约、判定规则、结论，以及“验证过 / 没验证过”。

**2. 文档分层别串。**

| 文件 | 只写什么 |
| --- | --- |
| `README.md` | 面向使用者：安装、使用、选项、权限、FAQ、已知限制 |
| `docs/development.md` | 面向开发者：环境、命令、开发/验收流程、目录结构、发布 |
| `docs/ai-debugging.md` | 真实浏览器实测的方法、流程与纪律 |
| `docs/note-types.md` | 笔记类型体系、判定规则、各类型的转换策略 |
| `docs/site-internals.md` | 目标站点实测结论：页面结构、Service Worker、IndexedDB、MathJax |
| `docs/export-pipeline.md` | 导出链路：产物、预检、资源下载、联网补全、反转义、内部契约 |
| `AGENTS.md` | 协作约定（本文件） |

**3. 改了行为就同步文档。漏更新视同没做完。**

| 改了什么 | 必须更新 |
| --- | --- |
| 功能、选项、安装方式、权限、用户可见的限制 | `README.md` |
| 开发流程、命令、目录结构、发布方式 | `docs/development.md` |
| 导出产物、预检、资源下载策略、内部契约 | `docs/export-pipeline.md` |
| 笔记类型判定或转换策略 | `docs/note-types.md` |
| 宿主页面结构 / SW / IndexedDB / MathJax 的实测结论 | `docs/site-internals.md` |
| 新增的实测数字、样本、账号信息 | `docs/private.local/*.md` |
| 协作约定 | `AGENTS.md`（本文件） |

**4. Markdown 一段一行。** 一个段落、一个列表项、一个引用块各占一行；换行只出现在空行、列表项之间、表格行与代码块内部（表格与围栏代码块原样保留）。别为了对齐列宽手动断行。

**5. 提交前自检。**

- `npm run typecheck`（或 `npm run build`）通过；
- 动过元数据 / front matter 的话：`npm run check:frontmatter` 通过；
- 动过 markdown 图片 / 链接目标的解析、或富文本正文反转义的话：`npm run check:markdown` 通过；
- 动过文件名 / 目录名规则的话：`npm run check:naming` 通过；
- 没有散的调试输出（`grep -rn "console\.log" src/` 只应命中 `src/utils/log.ts` 的 logger 实现与 `src/vendor/` 里的第三方包）；
- 对照上面第 3 条，该更新的文档都更新了。

## 要改什么 → 动哪里

| 要改的东西 | 落点 |
| --- | --- |
| 新增一个功能 | `src/features/<name>.ts` 导出挂载函数 + 在 `src/main.ts` 的 `bootstrap()` 里调用（需要 `document-start` 时机的例外，见“一分钟了解”） |
| 碰宿主内部结构（虚拟域 / `window.LiveEditor` / React fiber / IndexedDB 表名 / 宿主菜单 DOM） | `src/export/app-bridge.ts` 或 `src/features/export-menu.ts` 的 `SELECTOR` |
| 导出流程、资源下载、打包 | `src/export/task.ts`、`note-content.ts`、`archive.ts` |
| 资源的格式校验与占位图识别（**按内容**，别按扩展名） | `src/export/app-bridge.ts` 的 `sniffImageFormat()` / `looksLikePlaceholder()`（见 [docs/export-pipeline.md §4.1.1](docs/export-pipeline.md)） |
| 请求节流 / 本地命中判定 / 网络失败重试 | `src/export/app-bridge.ts` 的 `pacedFetch()`、`requestPacer`（`createRequestPacer`）、`attemptCandidates()`（见 [docs/export-pipeline.md §十](docs/export-pipeline.md)） |
| markdown 图片 / 链接目标的解析（title / `=尺寸` / `\|` 多图 / `<url>` / 目标里的成对括号）、资源名在请求路径里的转义、富文本正文的反转义 | `src/export/markdown-inline.ts` 的 `replaceInlineLinks()`、`splitImageTitle()`、`rewriteImageTargets()`、`encodePathSegment()`、`unescapeMarkdown()`（**刻意零依赖**：`npm run check:markdown` 要直接 import 它，别给它加 import；见 [docs/export-pipeline.md §4.1.2、§4.1.3、§4.2、§6.1](docs/export-pipeline.md)） |
| 笔记链接（内链 `wiz://open_document` / 协作双链 `[[名称 id=…]]`）→ wikilink、wikilink 名字的冲突判定与回退、markdown 链接目标的百分号编码 | `src/export/note-content.ts` 的 `rewriteInternalLinks()` / `rewriteWikiLinks()` / `resolveLinkTarget()` / `noteBaseName()`（名字与校验的纯函数在 `markdown-inline.ts`，同样**零依赖**）；目标标题来自 `src/export/app-bridge.ts` 的 `resolveNoteTitles()`；名字冲突时退化成标准 markdown 链接要用批次落点，见 [docs/export-pipeline.md §9.1、§9.3](docs/export-pipeline.md) |
| 一篇笔记在产物里的落点（目录名 / 正文文件名 / ` (N)` 消歧） | `src/export/task.ts` 的**预分配**那段（渲染前按顺序登记一遍；循环里不再分配）；命名规则本身仍然只在 `src/export/naming.ts`（见 [docs/export-pipeline.md §1.4、§9.3](docs/export-pipeline.md)） |
| 宿主 `html2Doc` 解析失败时的补救（空表格重试 / HTML 兜底产物） | `src/export/note-content.ts` 的 `stripCellLessTables()`、`buildHtmlOnlyResult()`（见 [docs/export-pipeline.md §5.4](docs/export-pipeline.md)） |
| 空笔记（正文为空）也要正常导出 | `src/export/note-content.ts` 的 `renderNote()` —— **别**再加“内容为空就跳过” |
| 笔记元数据 / front matter | `src/export/metadata.ts` |
| 标签层级拍路径（`父/子/孙`） | `src/export/tag-path.ts` |
| 评论章节（协作锚定型 + 旧版评论区） | `src/export/comments.ts` |
| 笔记类型判定 | `src/export/note-type.ts` |
| 文件 / 目录名的合法化与唯一化（清洗 / 加固 / 撞名加 ` (N)` 后缀 / 折叠查重） | `src/export/naming.ts`（唯一落点，**刻意零依赖**，见 [docs/export-pipeline.md §1.4](docs/export-pipeline.md)） |
| 大纲笔记的转换（`div.node` 树 → 嵌套列表） | `src/export/outline.ts` |
| 导出任务的队列 / 状态 / 关页面守卫 / **中止**（`activeAbort` 那条取消通道） | `src/export/session.ts`（唯一落点，见 [docs/export-pipeline.md §1.5、§1.7](docs/export-pipeline.md)） |
| 中止的检查点、以及在飞请求的作废（`hooks.signal` 往下传） | `src/export/task.ts`、`src/export/note-content.ts`（每一个 app-bridge 请求都要接上 `signal`，见 [docs/export-pipeline.md §1.7](docs/export-pipeline.md)） |
| 打包 zip（流式、让出主线程、已压缩格式跳过 deflate） | `src/export/archive.ts` 的 `buildZip()`（见 [docs/export-pipeline.md §1.8](docs/export-pipeline.md)） |
| 让出主线程（打包与篇内字符串处理的时间切片） | `src/utils/yield.ts`（唯一落点：`yieldToMain()` / `createYielder()`；篇内的让出点见 `src/export/note-content.ts` 的 `renderNote`，**别把相邻几步合并成一行**——那会把让出点吃掉） |
| 导出对话框 / 预检 / 结果页 | `src/ui/export-dialog.ts` |
| 最小化后的悬浮任务条（拖动位置 / 多任务合并折叠）、任务完成提醒 | `src/ui/export-tasks.ts`、`src/ui/notify.ts` |
| 悬浮条 ↔ 对话框的接力（从哪来 / 回哪去、双击把手飞回原位、进出场补间） | `src/ui/kit/morph.ts`（补间原语 + 接力锚点，两个视图读写它，避免互相 import）、`src/ui/panel/host.ts`（`setExportDialogOpen` 的广播，见 [docs/export-pipeline.md §1.5](docs/export-pipeline.md)） |
| 一块内容“长出来 / 收回去”的补间（展开折叠、确认行露头、头部横幅露头） | `src/ui/kit/morph.ts` 的 `setRevealed()`（唯一落点；被补间的节点不能带 padding / margin、也不能带作者 `display`，间距与 `display` 放内层 —— 横幅走 `modal.setBanner()`、确认行走 `ui/kit/confirm.ts`） |
| 设置面板与诊断 | `src/ui/settings-dialog.ts` |
| 会丢东西的动作的二次确认 | `src/ui/kit/confirm.ts`（三处共用：露头 / 收起走 `kit/morph.ts` 的 `setRevealed()`；待决期间把**触发按钮**置成不可用、Esc 与焦点也都在控件里收口，别在调用方另写一套，见 [docs/export-pipeline.md §1.6](docs/export-pipeline.md)） |
| 模态壳的外框 / 关闭手势 / 焦点（初始焦点、Tab 环绕、关闭还焦） | `src/ui/kit/modal.ts`（导出与设置共用；“焦点在哪 / 哪些元素能 Tab 到”在 `src/ui/kit/focus.ts`，悬浮条也用它接着还焦点；改之前读 [docs/export-pipeline.md §1.2](docs/export-pipeline.md)） |
| 新增一个持久化设置项 | `src/store.ts`（默认值）+ 需要的地方读取；用户可见的开关放 `settings-dialog.ts` |
| 动效的时长 / 曲线 | `src/style.css` 的 `--wze-dur-*` 与 `--wze-ease`（**唯一来源**：`panel.css` 直接 `var()`，`kit/morph.ts` 的 `motionMs()` / `motionEase()` 读同一份 —— 别再在任何地方写死时长） |
| 面板 / toast 的样式 | `src/ui/panel/panel.css`（Shadow DOM 内） |
| 注入到宿主文档的样式 | `src/style.css`（目前只有菜单项；`--wze-*` 变量在这里定义） |
| 离线公式渲染 / 内置 MathJax | `src/features/offline-mathjax.ts` + `src/vendor/mathjax/`（见 [docs/site-internals.md §5](docs/site-internals.md)） |
| 脚本元数据（`@name` / `@match` / `@grant`） | `vite.config.ts` |
| 用户端更新源、发版流程 | `vite.config.ts` 顶部的 `REPO` 与 `updateURL`/`downloadURL`；`.github/workflows/release.yml` |
| 油猴菜单项 | `src/menu.ts` |

## 上手

- **命令**（开发服务器 / 构建 / 回归检查 / 调试浏览器）见 [docs/development.md](docs/development.md) 的“常用命令”。
- **验证纪律**（完整版见 [docs/development.md](docs/development.md) 与 [docs/ai-debugging.md](docs/ai-debugging.md)）—— 只有下面两条会改变你的**动作选择**，其余是“注意点”，读那两份文档自然会知道：
  - **能实测就别猜。** 涉及宿主 DOM / Service Worker / IndexedDB / 网络行为时，静态分析经常得出错误结论；有真实浏览器就用（`npm run dev:chrome` + chrome-devtools MCP）。
  - **dev 模式验证不了这些**：脚本头元数据与 `@grant` 权限、离线行为、脚本体积 / 死代码消除 —— 这类改动必须走 `npm run build`（或 `build:watch`）+ `serve:dist` 装真实产物。
- **实测会真的改动数据**：导出会产生下载、协作笔记同步会把内容拉到本地缓存。动作前想清楚，并在回复里说明做过什么。
