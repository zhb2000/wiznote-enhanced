# 目标站点实测结论

对 `https://www.wiz.cn/xapp/index.html`（xapp `0.1.107`）的实测记录。**所有结论都标注了日期和验证方式**，上游改版后需要重新核对。

脚本里对应的封装：`src/wiz-app.ts`（页面桥接）、`src/export/app-bridge.ts`（数据与资源）。

---

## 一、页面结构

- **React** 应用，挂载点 `#root`，`document.body.className === 'desktop-body'`
- 页面暴露 **`window.wizApp`** 宿主桥接对象，已知键：`isElectron` / `isMainWindow` / `localhostPort` / `version` / `windowManager` / `settings` / `platform` / `utils` / `crypto` / `appPath` / `getResourcesPath` / `isDev` / `isMobile` / `os`
- 做增强功能优先从 `window.wizApp` 下手，比直接操作 React 内部 DOM 稳得多
- 未登录时进入登录页（存在 `input[type="password"]`），所以调试必须用持久化 profile 复用登录态

---

## 二、Service Worker

站点注册了 `/xapp/sw.js`（Workbox）。它把页面发出的**部分**请求拦截到本地数据服务，这是整个增强方案的基础。

### 2.1 哪些路径被代理

| 路径 | 被 SW 代理？ | 验证方式 |
| --- | --- | --- |
| `/ks/**` | ✅ | 请求 `/ks/note/view/…/index.html` 有响应，且 SW 打印 `console.log` |
| `/editor/**/resources/**` | ✅（但见 §2.3） | SW 日志 `handling resource get …` |
| `/ks/attachment/**` | ❌ | `//wiznote-desktop/ks/attachment/download/…` → `Failed to fetch`（本地数据服务没实现这条路由，见 §2.7） |
| `/as/**` | ❌ | `//wiznote-desktop/as/user/groups` → `ERR_NAME_NOT_RESOLVED` |

**`/as/**` 不被代理**是个容易误判的点 —— 只因为看到 SW 日志里有 `/as/activity/adInformation` 就以为被代理了，实际那条请求是直连账号服务的。

### 2.2 虚拟域 `//wiznote-desktop/…`

应用用协议相对地址 `//wiznote-desktop/…` 指向"本地数据服务"。因为页面是 https，它会解析成 `https://wiznote-desktop/…`，然后被 SW 接管。

### 2.3 资源处理逻辑（图片下载失败的根源）

SW 处理 `/editor/**/resources/**` 的代码：

```js
const cached = await cacheDb.get(nameOfPath(url));  // 按“文件名”查缓存，与 host 无关
if (cached && cached.data) return new Response(cached.data, { … });
const token = (await getToken(kbGuid, docGuid)).token;
if (token == null) return new Response('no token', { status: 403 });
const target = `${url.protocol}//${url.host}${url.pathname}?token=${token}`;
return fetch(target);                               // ← 用“请求自身的 host”去拉
```

两个后果：

1. **缓存 key 是文件名，与 host 无关**。所以同一个资源，不管从哪个域名请求，只要缓存里有这个名字就能命中。
2. **缓存未命中时用请求自身的 host 去网络拉**。打 `//wiznote-desktop` 那就是 `fetch('https://wiznote-desktop/…')` → DNS 失败 → `TypeError: Failed to fetch`。

**所以虚拟主机只在“编辑器已经拉过一次、缓存里已有该文件名”时才碰巧可用。** 这就是“打开笔记后导出图片全失败、手动滚动一遍后全部成功”的真正原因 —— 编辑器是懒渲染的，不滚到那一段就不会去拉对应图片。

正解是直接打真实源站（`{kbServer}/editor/{kb}/{doc}/resources/{name}`），SW 的路由同样匹配它，缓存未命中时会带着 token 从源站取回。详见 [export-pipeline.md § 4.2](export-pipeline.md#42-协作笔记的图片必须直连真实源站)。

> 同一个文件用虚拟主机取会失败，用真实源站取得到真图；而 `/ks/note/view/…/index_files/…` 会返回 **200 + 807 字节的伪造小图**。三条路径实测对比见 [export-pipeline.md §4.2](export-pipeline.md)。

### 2.4 SW 与页面之间的同步协议

SW 需要把文档同步到本地时，会向所有客户端广播：

```js
// SW 侧
client.postMessage({ type: 'wiz-ds-editor-sync-doc', ksURL, appId, docId, timeout });
// 页面侧（应用自己的监听器）
window.LiveEditor.syncOfflineDoc(ksURL, appId, docId, timeout)
  .then(() => event.source.postMessage({ type: 'wiz-ds-editor-sync-doc', appId, docId, success: true }))
```

这是**捕获 `ksURL` 的时机**（`watchServiceWorkerMessages()` 就在监听它）。不过触发时机由 SW 决定，不能依赖 —— 常态下从 IndexedDB 读更可靠。

### 2.5 调试注意

改了代码看不到效果，多半是 SW 缓存。在 DevTools 的 Application → Service Workers 勾选 **Update on reload**，或直接 **Unregister**。

⚠️ **SW 没接管页面时，所有 `//wiznote-desktop/**` 请求会集体 `Failed to fetch`**（实测 2026-10-04）：硬刷新之后的瞬间、或 SW 正在更新时 `navigator.serviceWorker.controller` 为 `null`，此时连**本地已缓存**的笔记也会失败 —— 它的 `index.html` 明明就在 `wiz-note-resource` 里。现象极像“这篇笔记没同步/没打开过”，实际刷新一次页面就恢复。导出侧用 `isLocalDataServiceReady()` 把这种状态从“正文取不到”里区分开，提示用户刷新（见 [export-pipeline.md §五](export-pipeline.md)）。

### 2.6 本地资源的两个通道（按笔记类型）

“离线也能浏览笔记”的原理是 **SW 当本地优先代理 + 三层本地存储**，但**不同类型走的是不同的通道、查的是不同的库**（2026-10-04 实测）：

| 笔记类型 | 取资源的路径 | 本地存在哪 | key |
| --- | --- | --- | --- |
| 普通笔记（`''`/`document`）、保存网页、`article`、`tasklist`、`svgpainter`、大纲、旧版 md、Lite md | `//wiznote-desktop/ks/note/view/{kb}/{doc}/index_files/{名}` | ① IndexedDB `wiz-<库>.docs` / `.data`（正文本体）② Cache Storage `wiz-note-resource`（渲染过的 `index.html` / CSS / 图片） | **裸文件名**（`index_files/` 前缀会被本地服务忽略） |
| 协作笔记 | `//wiznote-desktop/editor/{kb}/{doc}/resources/{名}` | ① IndexedDB `wiz-editor-ot` / `wiz-editor-ot-res` ② Cache Storage `wiz-ot-resource` | **裸名字**（实测 43 字符 base64url 资源名） |
| 普通笔记的**附件** | `{kbServer}/ks/attachment/download/{kb}/{doc}/{attGuid}`（**只能打真实源站**） | 本地 `attachments` 表里**只有元数据**（名称 / md5 / status），没有字节 | attGuid（见 §2.7） |

关键点：

- **SW 收到的 fetch 事件包括跨域请求**，所以“真实源站 URL”(`{kbServer}/editor/…`) 同样会被 `/editor/**/resources/**` 这条路由接住、**先按文件名查本地 OT 缓存**（实测十毫秒级返回，字节与 `wiz-ot-resource` 里完全一致）。打网络地址 ≠ 真的走网络。
- `/ks/**` 与之相反：查的是**本地数据服务**（笔记数据 + `wiz-note-resource`），命中即本地真图（3–5 ms），miss 才联网兜底。
- 两条路都会在 miss 时返回 **200 + 807 B 占位图**，所以“拿到 200”不代表拿到真图，必须校验（见 [export-pipeline.md §4.1.1](export-pipeline.md)）。实测（2026-10-07）：它是一张 **1×1 的 `GIF89a`、正好 807 字节**，而且 **content-type 会跟着请求的扩展名变**（`.png` 名字就声明 `image/png`、`.gif` 名字就声明 `image/gif`）—— 所以按扩展名做魔数校验对 `.gif` 名字完全无效（这条原先只标着“仅推断、未实测”，现在实测确认）。导出侧改成“**1×1 + 正好 807 字节**”精确识别，与扩展名无关；非 `.gif` 名字另有“体积小 + GIF 头”兜底。⚠️ 上游若改了占位图的字节数，`.gif` 名字那一路会重新漏。
- `wiz-note-resource` 的条目 URL 是 **`http://wiznote-desktop/note/resources/{kb}/{doc}/{文件名}`**（注意是 `http:`、路径是 `/note/resources/`，而且**按笔记分桶** —— `{kb}` / `{doc}` 各占一段）。请求形态是 `/ks/note/view/{kb}/{doc}/index_files/{名}`，落到缓存里会被规范化成上面那种 key；查表按文件名核对。
- `wiz-note-resource` 的 key 是**原始字符**：`icon@2x.png` 和 `icon%402x.png` 是两条不同条目（前者真图，后者 807 B 占位图）。⚠️ 反过来说：**拿一个错名字去请求，会把服务端返回的占位图按那个错名字固化进缓存** —— 实测踩过两次：名字被截断那次缓存里多出 `…(2).png` / `…(2` / `…(2.png` 三个变体（见 [export-pipeline.md §4.1.2](export-pipeline.md)）；`[` `]` 被多转义那次同理（见 [§4.2](export-pipeline.md) 的资源名编码一节）。所以**请求名必须与浏览器解析相对地址时一致**。

**覆盖范围是懒填充的**，但**不需要用户手动打开笔记**：实测（2026-10-07）对一篇**从没进过缓存**的普通笔记只发一次 `/ks/note/view/{kb}/{doc}/index.html`，它名下的资源就整批进了 `wiz-note-resource`（0 → 十几到上百条）；随后按 `/ks/…/index_files/{名}` 取图，**第一次请求就拿到真图**（两个冷样本各 3 张全中）。所以“要打开滚一遍”是误解 —— 导出本来就会先取 `index.html`，暖缓存是这一步的副产物。覆盖率数字见 `docs/private.local/library-stats.md`。

### 2.7 附件的通道（普通笔记）

附件跟上面两条通道都不同：**它没有走 SW，必须直连真实源站**（2026-10-04 实测，xapp 0.1.107）。

| 试法 | 结果 |
| --- | --- |
| `{kbServer}/ks/attachment/download/{kb}/{doc}/{attGuid}`（不带 token） | ❌ **500**（`text/plain`，21 字节）—— 缺 token |
| 同上 + `?token=…` | ✅ 200，原始文件字节（PNG 文件头 `89 50 4E 47`） |
| 同上但 attGuid 不存在 | 404 `Not Found`（不会造假数据） |
| `//wiznote-desktop/ks/attachment/download/…` | ❌ `Failed to fetch`（本地数据服务没有这条路由，miss 后 SW 拿 `wiznote-desktop` 当 host 去拉 → DNS 失败） |
| `{kbServer}/ks/note/attachments/{kb}/{doc}`（清单） | 不带 token → `301 Invalid token`；带 token → 200 + 附件列表 |
| `{kbServer}/ks/attachment/info/{kb}/{doc}/{attGuid}`（详情） | 带 token → 200 |
| `{kbServer}/ks/attachment/data/…` / `/ks/attachment/…` | 404 |

正文里的两种写法（都实测过）：

```html
<!-- 附件在正文里是这样被引用的：外层是 wiz:// 协议链接，里层是预览图 -->
<a href="wiz://open_attachment?guid=X"><img src="index_files/X_image.png" class="wiz-img-attachment"></a>
```

- **预览图 ≠ 附件本体**：预览是服务端重编码过的，实测甚至比原始文件还大，不能拿 `index_files/{attGuid}_image.png` 冒充附件。
- **附件可能完全不在正文里**：实测有一篇挂了多个附件的笔记，正文 HTML 里 `wiz://` 0 处、`<img>` 0 个 —— 它们只存在于应用的附件面板（数据来自 `/ks/note/attachments/…`），本地则落在 `attachments` 表。
- **清单接口是权威来源**：应用自己的附件面板用的就是 `/ks/note/attachments/{kb}/{doc}`，本地 `attachments` 表只是它的缓存 —— 所以导出时本地表缺行/行数不足，**可以也应该联网补一次**，不必当成限制。
- **`attachments` 表只有元数据**：字段 `attGuid` / `docGuid` / `kbGuid` / `name` / `dataSize` / `infoMd5` / `dataMd5` / `status`…，没有字节字段。而且 **`dataSize` 不可信**：本地行和服务端 list 接口都返回 `0`，已同步过的附件里表里的值也和实际大小对不上。要字节只能走下载接口。
- ⚠️ **同一个 token 校验，三个接口的表现不一致**：`download` 缺 token → HTTP **500**；`info` / `note/attachments` 缺 token → HTTP **200** + `{"returnCode":301,"returnMessage":"Invalid token"}`。所以**别只看 HTTP 状态码判成败，也别只测一个接口就推广到全族**（这个坑真踩过：只测下载接口、恰巧拿到一次 200，就误判成“不需要 token”）。

导出侧的用法见 [export-pipeline.md §4.5](export-pipeline.md#45-附件二普通笔记的-attachments-表)。

---

## 三、IndexedDB

页面与 SW 同源共享，**可以直接读**。实测库清单：

| 库名 | 用途 |
| --- | --- |
| `wiz-account` | 账号信息。`accounts` 表存 `{ kbGuid, kbServer, serverUrl, token, endpoint, … }` |
| `wiz-<guid>` | 每个知识库一个库。表：`docs` / `data` / `kbs` / `folders` / `tags` / `attachments` / … |
| `wiz-editor-db-store` | 编辑器 KV（`store` 表，`keyPath: key`） |
| `wiz-editor-ot` / `wiz-editor-ot-res` | OT 文档与资源缓存。后者就是 §2.3 里的 `cacheDb` |
| `wiz-editor-local-storage-<x>` | 编辑器的 localStorage 替代品 |
| `wiz-log` | 日志 |

### 3.1 `wiz-account` → `accounts`（字段样例）

```json
{
  "kbGuid":    "<知识库 guid>",
  "kbServer":  "https://vipkshttpsN.wiz.cn",
  "serverUrl": "https://as.wiz.cn",
  "token": "<访问令牌>",
  "endpoint": { "account_server_url": "https://as.wiz.cn", "…": "…" }
}
```

这也是导出功能拿 `kbServer` 的地方（`fetchKbServer()`）。`kbGuid` / `kbServer` 的**真实值属账号私有信息**，不要写进本文档或任何提交内容。

### 3.2 判断笔记是否在本地

主库的 `docs` 表有全部笔记的元数据；正文在 `data` 表。`isNoteStoredLocally()` 就是在这些表上做存在性检查，**不产生任何请求**。

### 3.3 笔记类型

`docs.type` 的实际取值见 [note-types.md § 一](note-types.md#一原始-type-字段)。

### 3.4 `tags` 表是一棵树

主库的 `tags` 表承载**层级标签**：字段 `tagGuid` / `name` / `parentGuid` / `pos` / `noteCount` / `status`…，且**每一行都带 `parentGuid`**。顶层标签的 `parentGuid` 是字面量 **`rootTagGuid`**（不是 guid，表里也没有这一行）—— 向上走到它就等于到顶。

- 应用自己按 `children` 递归渲染成**缩进树**，`hasSameChildTag(parentGuid, name)` 说明**同名只约束在同一父下**（跨父允许同名）；bundle 里没有“路径字符串”这套约定；
- 实际层级靠 `parentGuid` 向上递归数出来（层级分布见 `docs/private.local/library-stats.md`）；
- 笔记侧的 `docs.tags` 是 `guid1*guid2` 的**叶子 guid 列表**，层级只能从 `tags` 表补；
- ⚠️ `docs.tags` 与**笔记列表 DTO** 上的 `tags` 不是一回事：后者实测是**空串**（列表接口没带标签），所以从列表右键导出时读的是 `docs` 行；
- 导出侧拍成 `父/子/孙` 路径（`buildTagPaths()`），规则见 [export-pipeline.md §8.1](export-pipeline.md#81-数据从哪来零网络)。

---

## 四、知识库服务器 `kbServer`

- 形如 `https://vipkshttpsN.wiz.cn`（`vipkshttpsN` 是**账号相关的分片名**，**不能硬编码**）
- 协作笔记的 WebSocket（`wss://{kbServer}/editor/{kb}/{doc}`）和资源（`https://{kbServer}/editor/{kb}/{doc}/resources/{name}`）都挂在它下面
- 前端**没有**把它暴露到 `window` 上（我把 renderer 里所有 `window.X =` 赋值都过了一遍），只能从 IndexedDB 读

上游用它做 `/ks/**` 请求的 baseURL：

```js
if (url.startsWith('/ks')) {
  baseURL = useDefaultKbServer ? account.kbServer : kb.kbServer;
} else {
  baseURL = account.serverUrl;
}
```

---

## 五、公式引擎 MathJax

### 5.1 它是运行时从第三方 CDN 拉的

`renderer.dev.js` / `live-editor/index.js` 里的配置：

```js
CdnUrlConfig = {
  mathjax: 'https://cdn.staticfile.org/mathjax/3.2.0/es5/tex-svg.min.js',
  mermaid: '...', prismCore: '...', flowchart: [...], drawioIframe: '...',
}
```

它**不在 PWA 预缓存里**。而 `/xapp/sw.js` 预缓存的 `MathJax.js`、`config/TeX-AMS-MML_SVG.js`、`extensions/*` 全是站点自己域下的 **MathJax v2**（旧编辑器遗留，跟渲染路径无关）。SW 的兜底分支只在 URL 含 `wiz.cn/xapp/` 时生效，`cdn.staticfile.org` 直接走网络。**所以断网后公式必然失败。**

### 5.2 为什么报的是 `tex2svgPromise is not a function`

应用的脚本注入函数长这样：

```js
function z(url, id, cb) {
  if (document.getElementById(id)) { setTimeout(cb); }   // ← 已存在 ⇒ 直接当作加载成功
  else { ...创建 script...; onerror: e => cb(new URIError("The script … didn't load correctly.")) }
}
```

| 次数 | 现象 |
| --- | --- |
| 第 1 次渲染 | 网络失败 → `onerror` → 报 `The script … didn't load correctly.` |
| 第 2 次起 | 上次失败的 `<script id="MathJax-script">` **元素还留在 DOM 里** → `getElementById` 判重命中 → 直接当作成功 → 调用 `window.MathJax.tex2svgPromise` → **`tex2svgPromise is not a function`** |

`window.MathJax` 之所以存在（而不是 undefined），是因为应用在加载前先执行了 `window.MathJax || (window.MathJax = { options: { skipHtmlTags: [...] } })` —— 断网时它只是个没有 API 的配置对象。

### 5.3 脚本里的修复

`src/features/offline-mathjax.ts` 在 `document-start` 阶段同步做两件事：

1. 把 MathJax 3.2.0 完整包的源码（`src/vendor/mathjax/tex-svg-full.min.js`）在构建时用 Vite 的 `?raw` **内联进脚本体** —— 脚本因此完全自包含，不依赖 `@resource`、也不依赖油猴的资源缓存；
2. 先占住 `window.MathJax`（应用用的是 `||`，检测到已存在就不会覆盖自己的配置），再以 **`id="MathJax-script"`** 注入这份内联源码。用同一个 id 是关键：应用的判重会直接命中，**连那个必然失败的 CDN 请求都不会发起**。

用真实构建产物 + 断网环境验证通过（在线 / 离线 / 离线+修复 三种对照）。

> 早期版本走的是 `@resource` + `GM_getResourceText`（由油猴在安装时抓取并缓存），后来改为内联：`@resource` 的抓取/缓存不可靠（抓取失败、dev 模式的 loader、断网重装都会让资源读不到），失败时会静默降级回“应用自己拉 CDN → not a function”。内联把这条依赖彻底去掉，代价是产物体积约 1.9 MB（gzip 约 660 kB）。

### 5.4 内置的必须是完整包 `tex-svg-full.min.js`（不能用 min 包）

`tex-svg.min.js` 是**精简包**，默认只加载 `base / ams / newcommand / noundefined / require / autoload / configmacros`，**不含 `boldsymbol`**（以及 `amscd` / `bbox` / `cancel` / `color` / `mathtools` 等一长串）。`\boldsymbol` 属于独立扩展 `[tex]/boldsymbol`，由 `autoload` 在首次遇到该宏时**运行时按需加载**。

上游在线时没问题：它用 `<script src="…/es5/tex-svg.min.js">` 注入，MathJax 靠脚本的 `src` 推断出 base 是 `https://cdn.staticfile.org/mathjax/3.2.0/es5`，autoload 才能把扩展拉下来。

我们的离线修复是**内联注入**（`script.textContent = 源码`），这个 script **没有 `src`**。MathJax 推断根路径的代码是：

```js
e.getRoot = function () {
  var t, e = '//../../es5';
  if ('undefined' != typeof document) {
    t = document.currentScript || document.getElementById('MathJax-script');
    if (t) e = t.src.replace(/\/[^\/]*$/, '');   // 内联 script 的 src 是空字符串
  }
  return e;
}
```

我们特意用了 `id="MathJax-script"`（为了命中应用的判重），结果 `t` 一定存在、`t.src` 是空字符串 → **base 被覆盖成空路径**，连默认值 `//../../es5` 都保不住。于是 autoload 的扩展请求变成相对页面地址 `https://www.wiz.cn/xapp/input/tex/extensions/boldsymbol.js`；实测该地址返回 **200 + `Content-Type: text/html`（2573 字节的 SPA 首页）**，被当 JS 执行直接语法报错，扩展加载失败 → `\boldsymbol` 变成未定义。

**这一条与“离线”无关**：只要启用了本修复，联网时 `\boldsymbol` 同样会坏。

所以内置的必须是**完整包** `tex-svg-full.min.js`（1.88 MB）：它把全部 TeX 扩展都打包进去，autoload 检查到 `packages` 里已有 `boldsymbol` 就不会再发请求，内联注入 + 离线都能正常渲染。

> 补充实测（2026-10-04）：各类笔记（协作 / 普通 / 旧版 Markdown）渲染时都走同一个 `window.MathJax.tex2svgPromise`，所以这份修复对它们**一起生效**，不存在“只影响某类笔记”的情况；换用完整包后，协作笔记与旧版 Markdown 笔记的 `\boldsymbol` 均已恢复正常。

### 5.5 注意

- 完整包源码放在 `src/vendor/mathjax/tex-svg-full.min.js`，构建时经 `?raw` 内联进产物（产物体积约 1.9 MB，gzip 约 660 kB）。上游若升级 MathJax 版本，替换这个文件即可；**必须保持 full 包**（不能图省事换成 `tex-svg.min.js`，原因见 §5.4）。
- 脚本自包含，因此**不依赖 `@resource` / `GM_getResourceText`**：安装时不需要联网抓资源，断网重装也能用。
- 不想启用就关掉它（油猴菜单 →“设置”→ 离线公式渲染；菜单里也留了同名保命开关），刷新后生效。

## 六、转换链路：html2Doc / doc2markdown

导出时的内容转换**不是我们实现的**，而是调用应用导出的两个函数。但它们的内部构成不一样，值得记一笔（都能在 `live-editor/index.js` 的导出表里对上）。

### 6.1 `doc2markdown` —— 应用自己写的

```js
function doc2markdown(doc, options) {
  const opts = { buildResourceUrl: (n) => n, keepImageSize: false, customConverter: () => {}, ...options };
  const lines = sl(doc, doc.blocks, opts);   // ← 逐块遍历，应用自己的实现
  // 再追加评论块
}
```

它是一个**逐块遍历器**（block-by-block），**不经过 Turndown**。好处是公式 / 图片 / mermaid / 表格 / 列表的规则和应用自身完全一致，所以我们的导出结果和应用里复制出来的 markdown 是同一套。

**embed 块的渲染方式（实测 2026-10-04，xapp 0.1.107）**：`type: 'embed'` 的块一律渲染成 `[<embedType>](<资源名>)`，**链接文案取的是 embedType 而不是 `embedData.fileName`**：

| embedType | doc 里的块 | doc2markdown 产物 |
| --- | --- | --- |
| `office`（上传的文件） | `embedData: { src, fileName, fileSize, fileType, previewType }` | `[office](qj-….pdf)` |
| `drawio` | `embedData: { src }` | `[drawio](….svg)` |
| `webpage` | `embedData: { src: 'http://…' }` | `[webpage](http://…)` |
| `image` | `embedData: { src }` | `![image](…)`（注意是图片语法，且文案固定 `image`） |
| `math` | `src` 是 `data:image/svg+xml;base64,…` | 无链接，按公式渲染 |

只有 `office` 的 `embedData` 带 `fileName`（上传时的原始文件名）；我们导出附件时就是靠它还原可读文件名的（见 [export-pipeline.md §4.4](export-pipeline.md#44-附件协作笔记的-embed-块)）。

### 6.2 `html2Doc` —— 三条路，优先级不同

```js
function html2Doc(html, options) {
  // 路 1：HTML 里内嵌了 doc 数据 → 直接解开，无损
  const marker = 'wiz-editor-doc::';
  const start = html.indexOf(marker);
  if (start !== -1) {
    const end = html.indexOf('::wiz-editor-doc', start + marker.length);
    if (end !== -1) {
      const payload = html.substr(start + marker.length, end - start - marker.length);
      try { return JSON.parse(decode(payload)); } catch { /* 落到下面 */ }
    }
  }
  // 路 2：从 Word / Office 粘进来的内容
  if (html.indexOf('xmlns:o="urn:schemas-microsoft-com:office:office"') !== -1) {
    const doc = vc(html, options);
    if (doc) return doc;
  }
  // 路 3：兜底 —— HTML →（Turndown）→ markdown →（marked）→ doc
  try { return Mc(html); } catch (e) { console.error(e); }
}
```

**路 1 是无损的**：笔记 HTML 里如果嵌了 `wiz-editor-doc::<base64>::wiz-editor-doc`，解开就是原始 doc，不经过任何 markdown。

**路 3 是有损的**：先 `Turndown`（HTML→markdown），再用 `marked` 的 Lexer（`markdown2Doc` 里定制了 `tokenizer.rules.inline.link` 规则）解析回 doc。我们处理过的“markdown 字面文本被转义”问题（见 [export-pipeline.md § 六](export-pipeline.md#六富文本笔记里的markdown-字面文本要先反转义)）就是这条路产生的。

> **同一类笔记可能走不同路**：走哪条取决于该笔记的 HTML 里有没有内嵌 doc 数据，所以保真度会不一样。这是“为什么有的富文本笔记导出很准、有的有偏差”的根源。

#### ⚠️ 没有单元格的 `<table>` 会让 `html2Doc` 整个返回 `undefined`（2026-10-07 实测）

在真实页面上直接调 `html2Doc`（xapp 0.1.107）：

| 输入 | 返回 |
| --- | --- |
| `<table></table>` | **undefined** |
| `<table><tbody></tbody></table>` | **undefined** |
| `<table><tbody><tr></tr></tbody></table>` | **undefined** |
| `<table><tbody><tr><td></td></tr></tbody></table>` | object |
| `<table><tbody><tr><td>x</td></tr></tbody></table>` | object |
| 单独 `<tr></tr>`（不在 table 里） | object |

即“**没有任何单元格的表格**”会让整篇解析失败 —— 不是这一处内容丢失，而是整篇返回 `undefined`。某篇保存网页（一篇体量不小的剪藏）的正文里正是一个 `<table class="atd"><tbody><tr></tr></tbody></table>`，它就是那批真实导出里唯一一篇“已跳过 · 无法解析笔记内容”；把那个空表摘掉后同一次会话里 `html2Doc` 返回 object、`doc2markdown` 正常产出 markdown（具体样本与数字见 `docs/private.local/samples.md`）。

导出侧的处理（重试 → HTML 兜底）见 [export-pipeline.md §5.4](export-pipeline.md)。

### 6.3 应用内部用的第三方库

产物里实际打包了：

| 库 | 用途 | 产物里的路径 |
| --- | --- | --- |
| **Turndown** | HTML → Markdown | `turndown/lib/turndown.browser.es.js` |
| **turndown-plugin-gfm** | Turndown 的 GFM 扩展（表格 / 删除线…） | `turndown-plugin-gfm/lib/turndown-plugin-gfm.es.js` |
| **marked** | Markdown → HTML / 词法分析 | `marked/lib/marked.js` |

`kc = new TurndownService()` 上注册了 6 个 `use()` 插件/规则，还 `addRule` 了自定义规则（如 `preOnlyBlockToCode`）。

### 6.4 ⚠️ 我们那个转义问题，源头就是 Turndown

```js
// 应用导出表里：
escapeMarkdownText: () => Dc
// 而：
function Dc(e) { return kc.escape(e); }   // kc 就是 TurndownService
```

**`escapeMarkdownText` 直接用了 Turndown 的 `escape()`。** `doc2markdown` 生成 markdown 时用它转义字面文本，于是正文里的 `![](...)`、`[TOC]`、`mo_device` 变成了 `!\[\](...)`、`\[TOC\]`、`mo\_device` —— 也就是我们后来用 `unescapeMarkdown()` 修掉的那个问题。

**所以：Turndown 只出现在“HTML→markdown”和“转义”这两个点上，`doc2markdown` 的块遍历本身是应用自己写的。**

