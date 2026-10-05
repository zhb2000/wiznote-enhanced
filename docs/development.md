# 开发指南

本项目的开发、构建、验证与发布流程。面向使用者的说明在 [README.md](../README.md)，与 AI 协作开发的约定见 [AGENTS.md](../AGENTS.md)。

基于 Vite 的油猴脚本（UserScript）开发脚手架，使用 [`vite-plugin-monkey`](https://github.com/lisonge/vite-plugin-monkey) 提供元数据生成、开发期自动重载与 GM API 支持。

## 环境要求

- Node.js >= 20
- 浏览器已安装 Tampermonkey / Violentmonkey / Greasemonkey 中任意一个

## 快速开始

```bash
npm install
npm run dev
```

`vite dev` 启动后，在浏览器里打开安装地址：

```
http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js
```

油猴插件会识别到名为 `server:wiznote-enhanced` 的脚本，安装后访问 `@match` 命中的页面即可生效。之后修改 `src/` 下的任何代码，页面会自动刷新并加载新代码，无需重新安装。

## 常用命令

```bash
npm run dev            # 开发服务器（热更新）
npm run build          # 类型检查 + 生产构建，产出 dist/wiznote-enhanced.user.js
npm run build:watch    # 监听模式，产物实时更新，适合本地长期调试
npm run typecheck      # 仅做类型检查
npm run serve:dist     # 用 HTTP 暴露 dist/，便于安装真实构建产物
npm run check:frontmatter # front matter（YAML 元数据）的引号 / 转义回归检查，零额外安装
npm run check:markdown # markdown 内联图片 / 链接目标的解析回归检查，零额外安装
npm run check:naming   # 文件名 / 目录名的合法化 + 唯一化回归检查，零额外安装
npm run dev:chrome     # 启动可被 AI 调试的 Chrome（专用 profile + CDP 9222）
npm run dev:chrome:dry # 只打印将使用的路径与参数，不启动浏览器
```

## 开发与验证流程

**能像普通前端项目一样起开发服务器热更新**，不需要先打包。但有两类改动 dev 模式验证不了，需要走真实产物。

### A. 日常开发：dev server（推荐，保存即生效）

```bash
npm run dev
```

首次在油猴里安装一次：

```
http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js
```

装好后列表里会多出一个 `server:wiznote-enhanced`（`server:` 前缀用来区分正式产物）。之后改 `src/` 下任何文件，页面会自动重载并加载新代码，**不需要重新安装**。

原理：这个开发态脚本本体只有几 KB，它做三件事 —— 把油猴沙箱的 window 挂到 `document` 上、把 GM_* / GM API 桥接到页面 window、再插入 `<script type="module" src="http://127.0.0.1:5173/__vite-plugin-monkey.entry.js">`。真正的代码由 Vite dev server 以原生 ES module 提供，由 `@vite/client` 驱动热更新。

### B. 验收：真实构建产物

有些行为 dev 模式**不可能**验证：

| 项目 | dev 模式 | 真实产物 |
| --- | --- | --- |
| 代码形态 | 页面上下文里的原生 ESM | 内联 IIFE |
| `unsafeWindow` | 被伪造成 `window` | 真正的沙箱隔离 |
| `@grant` 权限 | 一次性放开全部 GM API | 只按声明的 grant 生效 |
| `@resource`（当前未使用） | 可用（同样由油猴本地缓存） | 可用 |
| 整体可运行性 | 依赖 dev server 在线 | 完全独立，离线可用 |
| 体积 / 死代码消除 | 无参考价值 | 有 |

所以涉及 `@resource`、离线、权限、发布体积的改动，走这条链路：

> 本项目的离线公式渲染早期用 `@resource` 承载 MathJax 源码，现已改为构建时内联进产物（见 [site-internals.md §5.3](site-internals.md)），代码里不再有 `@resource`。

```bash
npm run build:watch    # 终端 1：改代码就重新产出 dist/wiznote-enhanced.user.js
npm run serve:dist     # 终端 2：把 dist/ 用 HTTP 暴露出来
```

然后在油猴里安装 / 覆盖这个地址（脚本名与 namespace 不变时会被识别为更新）：

```
http://127.0.0.1:8080/wiznote-enhanced.user.js
```

也可以直接把 `dist/wiznote-enhanced.user.js` 拖进浏览器安装。

### C. 怎么选

- 改逻辑、调 DOM、加菜单 → `npm run dev`，保存即生效。
- 改元数据 / front matter（标题、标签、时间怎么落盘）→ `npm run check:frontmatter`，它把极端标题 / 标签名（`- ` 开头、控制字符、`yes`、日期形状…）以及**标签层级拍路径**的脏数据（自环、互指、缺父、超长链、跨父同名）钉在 75 项断言里。
- 改文件名 / 目录名规则（清洗、加固、撞名去重）→ `npm run check:naming`，它把保留名、尾部点号、控制字符、超长截断、大小写 / Unicode 折叠查重、多篇同名导出这些情况钉在 61 项断言里。
- 改 markdown 图片 / 链接目标的解析（title、`=尺寸`、`|` 多图、`<url>`、目标里的成对括号），或改**资源名在请求路径里的转义**（`encodePathSegment`）→ `npm run check:markdown`，它把宿主产物里那些脏形态（含剪藏里 `x(2).png`、`open[1].gif` 这种名字）钉在 33 项断言里。
- 碰 `@resource` / 离线 / `@grant` / 发布体积 → `npm run build`（或 `build:watch`）+ `serve:dist`。
- 需要确认“上游页面有没有改版”“公式在真实笔记里渲染成什么样”→ 用 `npm run dev:chrome` 起的调试浏览器 + chrome-devtools MCP 去看，流程见 [ai-debugging.md](ai-debugging.md)。

## 构建与发布

```bash
npm run build          # 类型检查 + 生产构建
```

产物有两个：

| 文件 | 用途 |
| --- | --- |
| `dist/wiznote-enhanced.user.js` | 完整脚本，安装与升级用 |
| `dist/wiznote-enhanced.meta.js` | 只含 UserScript 注释头（没有正文），供油猴检查更新时轻量下载 |

### 发版流程

**发布正式 release 即为发布新版本**。产物在发布之前就已经挂在该 release 上，所以用户端不存在“latest 已指向新版本、资产却还没传完”的空窗期：

1. 改 `package.json` 的 `version`（如 `0.2.0`），提交并推送到 `master`；
2. 打 tag 并推送：`git tag v0.2.0 && git push origin v0.2.0`；
3. 这一步触发 `.github/workflows/release.yml`：校验 tag 与 `package.json` 的版本一致 → `npm run build` → 创建或更新 **draft release**，把两个产物挂成它的资产；
4. 在 GitHub 上打开这个 draft，填写 changelog；
5. 点 **Publish release**（**不要勾 prerelease**，否则 `releases/latest` 不会切过去）。

第 5 步之前 draft 及其资产对匿名用户不可见，`releases/latest` 仍指向上一个正式版本；点发布的那一瞬间新资产已经就绪，无需等待构建 —— 这就是把“构建上传”提前到打 tag 的原因。工作流重复运行是安全的：draft 阶段只覆盖资产、不动你写的 changelog，已经正式发布的 release 会被拒绝覆盖。

### 自动更新

`vite.config.ts` 把更新源指向 GitHub 提供的固定地址，仓库写在文件顶部的 `REPO` 常量里（换仓库只改这一处）：

```ts
const REPO = 'zhb2000/wiznote-enhanced';
updateURL: `https://github.com/${REPO}/releases/latest/download/wiznote-enhanced.meta.js`,
downloadURL: `https://github.com/${REPO}/releases/latest/download/wiznote-enhanced.user.js`,
```

- `releases/latest/download/<资产名>` 永远指向**最新正式 release** 里的同名资产，prerelease 不算，所以 URL 不必随版本改；
- 油猴检查更新时只下载 `meta.js`（几百字节），确认 `@version` 变大后才按 `downloadURL` 下载完整脚本；
- **产物不提交进仓库**：`dist/` 保持被 `.gitignore` 忽略，由 CI 上传到 release；本地构建只为自测（`npm run build` + `npm run serve:dist`）；
- 更新源写在脚本头里，油猴一律采用、与安装方式无关：本地拖拽安装的产物同样能自动更新（实测 2026-10-05）；“从 URL 安装”只是脚本没写 `@updateURL`/`@downloadURL` 时的兜底更新源；
- 更新源只在生产构建里写入：`npm run dev` / `dev:chrome` 提供的脚本（`@name` 带 `server:` 前缀）不带 `@updateURL`/`@downloadURL`，热更新走 dev server 的 HMR，与更新源无关；
- 发布正式 release 的那一刻资产已就绪，没有“版本已切换、文件还没传完”的窗口。

## 目录结构

```
.
├── .github
│   └── workflows
│       └── release.yml      # push tag 时构建并挂到 draft release（发布前资产就绪）
├── vite.config.ts          # Vite 配置 + 脚本元数据（@name/@match/@grant/更新源等）
├── tsconfig.json
├── AGENTS.md               # 与 AI 协作开发的约定
├── docs                    # 专题文档，索引见 docs/README.md
│   └── private.local/      # 私有实测记录（已被 .gitignore 忽略，不入库）
├── scripts
│   ├── dev-chrome.mjs      # 启动可被 AI 调试的 Chrome（专用 profile + CDP 端口）
│   ├── check-front-matter.mjs # front matter 的引号 / 转义回归检查（npm run check:frontmatter）
│   ├── check-markdown.mjs  # markdown 内联图片 / 链接目标的解析回归检查（npm run check:markdown）
│   ├── check-naming.mjs    # 文件名 / 目录名的合法化 + 唯一化回归检查（npm run check:naming）
│   └── serve-dist.mjs      # 用 HTTP 暴露 dist/，便于安装真实构建产物
└── src
    ├── main.ts             # 脚本入口：顶层先装离线公式（抢 document-start），onDomReady 后 bootstrap 串联其余
    ├── config.ts           # 脚本常量、META（名称 / 版本 / 仓库地址）与站点选择器
    ├── store.ts            # 持久化配置（基于 GM_setValue）
    ├── menu.ts             # 油猴菜单：只注册“设置”入口 + 保命项
    ├── wiz-app.ts          # window.wizApp 宿主桥接对象的类型化访问
    ├── style.css           # 注入到页面的样式
    ├── vite-env.d.ts       # Vite 与油猴全局类型声明
    ├── vendor
    │   └── mathjax
    │       └── tex-svg-full.min.js # 内联进产物的 MathJax 完整包（构建时经 ?raw）
    ├── features            # 业务功能模块，一个功能一个文件
    │   ├── export-menu.ts       # 两个右键菜单入口的注入
    │   └── offline-mathjax.ts   # 修复离线时公式报错
    ├── export              # 导出内核（与 UI 解耦）
    │   ├── types.ts             # 共享类型
    │   ├── note-type.ts         # 笔记类型判定（复刻应用逻辑）
    │   ├── naming.ts            # 文件名 / 目录名：对齐上游清洗 → 落盘加固 → 唯一化（零依赖）
    │   ├── tag-path.ts          # 标签树 → 父/子/孙 完整路径（纯函数）
    │   ├── app-bridge.ts        # ⚠️ 应用内部结构（编辑器 API / 虚拟域 / IndexedDB / 各类接口）
    │   ├── note-content.ts      # 单篇 → Markdown / HTML + 资源清单
    │   ├── comments.ts          # 评论章节（协作锚定型 + 旧版评论区）
    │   ├── metadata.ts          # 笔记元数据：front matter（js-yaml）/ .meta.json
    │   ├── outline.ts           # 大纲笔记：div.node 树 → 嵌套列表
    │   ├── archive.ts           # zip 打包
    │   ├── task.ts              # 单批次执行（遍历 / 限流 / 汇总）
    │   └── session.ts           # 导出任务队列（状态 / 串行调度 / 关页面守卫）
    ├── ui
    │   ├── export-dialog.ts     # 导出对话框（选项 / 笔记列表 / 进度 / 结果）
    │   ├── export-tasks.ts      # 最小化后的悬浮任务条 + 任务完成提醒
    │   ├── notify.ts            # 系统通知（GM_notification 优先）
    │   ├── settings-dialog.ts   # 设置对话框（通用开关 + 诊断）
    │   ├── toast.ts             # 页面内轻量提示（同在 Shadow DOM 里）
    │   ├── kit                  # 极简 UI 基座
    │   │   ├── el.ts            # DOM 工厂
    │   │   ├── confirm.ts       # 危险动作的确认行（三处共用）
    │   │   ├── focus.ts         # 焦点在哪 / 哪些元素能 Tab 到（模态与悬浮条共用）
    │   │   └── modal.ts         # 模态壳（遮罩 / 头部 / × / Esc / 插槽 / 焦点）
    │   └── panel                # 面板宿主（Shadow DOM）
    │       ├── host.ts          # attachShadow 挂载 + 样式注入
    │       └── panel.css        # shadow 内部样式（面板 + toast）
    └── utils
        ├── dom.ts          # onDomReady / $ / $$ / createEl / waitForElement
        ├── invariant.ts    # “不该发生”的不变量：dev 抛错 / prod 记日志
        ├── log.ts          # 带作用域前缀与调试开关的日志
        └── store.ts        # 类型安全的 GM 存储封装
```

## 常用改动点

### 1. 修改脚本元数据

统一在 `vite.config.ts` 的 `monkey({ userscript })` 里维护，字段与 UserScript 注释一一对应：

```ts
userscript: {
  name: 'wiznote-enhanced',
  version: pkg.version, // 唯一来源是 package.json
  // `/xapp` 与 `/xapp/index.html` 是同一个应用且不互相跳转，两条路径都要列
  match: ['https://www.wiz.cn/xapp', 'https://www.wiz.cn/xapp/*', 'https://*.wiz.cn/xapp', 'https://*.wiz.cn/xapp/*'],
  grant: ['unsafeWindow', 'GM_addStyle', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_notification'],
  // MathJax 源码已内联进产物，不再使用 @resource（见 src/features/offline-mathjax.ts）
  'run-at': 'document-start',
}
```

**版本号只改 `package.json` 的 `version` 一处**：它同时喂给脚本文档块（`vite.config.ts` 读 `pkg.version`）和运行时代码（`define` 注入 `__APP_VERSION__`，`src/config.ts` 的 `META.version` 用它，日志与设置面板的诊断区都从这里取）。文档块的 `@license` 同理直接读 `pkg.license`，不在 `vite.config.ts` 里另写字面量。改完 `match` / `grant` 后，开发模式下需要重新在油猴里确认一次权限。

**仓库地址同样只有一处**：`vite.config.ts` 顶部的 `REPO`。它除了喂给文档块的 `namespace` 与两个更新地址，还通过 `define` 注入 `__APP_REPO__`，由 `src/config.ts` 派生出 `META.authorUrl`（`owner` 主页）、`META.homepage`（仓库地址）与 `META.homepageLabel`（去协议后的展示文本），设置面板的“关于”区展示的就是这两个地址（`homepageLabel` 只用于显示，点击跳转仍走 `homepage`）。换仓库不用改 `src/`。

### 2. 添加新功能

在 `src/features/` 下新建模块并导出挂载函数，然后在 `src/main.ts` 的 `bootstrap()` 中调用。可参考 `features/export-menu.ts` 的写法。

### 3. 引入第三方库

普通 `npm i xxx` + `import` 会打包进脚本。若想走 CDN 以缩小体积，用 `build.externalGlobals` 把依赖外置成 `@require`：

```ts
import { cdn } from 'vite-plugin-monkey';

monkey({
  // ...
  build: {
    externalGlobals: {
      dayjs: cdn.jsdelivr('dayjs', 'dayjs.min.js'),
    },
  },
});
```

### 4. 样式

分两层：

- **`src/style.css`**：注入宿主文档（light DOM）的全局样式，目前只有注入进宿主右键菜单的菜单项。这里定义的 `--wze-*` CSS 变量会被 Shadow DOM 继承，所以暗色模式的调色板只需维护这一份。
- **`src/ui/panel/panel.css`**：面板（导出对话框）和 toast 的样式，以 `?inline` 导入后塞进 Shadow DOM，与宿主页面完全隔离 —— 既不会被宿主的 MUI 全局样式影响，也不会污染页面。挂载逻辑在 `src/ui/panel/host.ts`，面板和 toast 共用一个宿主元素。

交互可供性统一用 **hover 底色**（`--wze-hover`）承担，不靠手型光标：`cursor: pointer` 只用于超链接（`<a href>`），按钮 / 可点行 / 勾选项一律保持默认箭头（理由见 `AGENTS.md` 硬约束 12）。

### 5. 日志

统一走 `src/utils/log.ts` 的 `logger(scope)`：

- `log.debug` 受设置里的“调试日志”开关控制，**默认关闭**；
- `log.info` / `log.warn` / `log.error` 始终输出，只用在用户可见的重要节点上；
- 前缀固定是 `[wiznote-enhanced][scope]`，方便在 console 里过滤。

别直接 `console.log`：调试日志关掉之后，那些输出会变成不可控的噪音。

## 说明

- 开发模式下脚本名带 `server:` 前缀，与构建产物区分，可通过 `server.prefix` 自定义或关闭。
- 开发模式默认不自动打开浏览器（`server.open: false`），需要自动打开可改为 `true`。
- `build.autoGrant` 默认开启，会按代码里实际用到的 API 自动补全 `@grant`，因此不必手动维护得很精确。
- 不声明 `@connect`：联网一律走页面内的原生 `fetch`，没有用 `GM_xmlhttpRequest`。
