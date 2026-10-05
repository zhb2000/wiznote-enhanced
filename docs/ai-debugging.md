# 让 AI 自主开发并用 Chrome 调试

配合 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Google 官方 MCP 服务器），AI 可以自己改代码、刷新页面、读 console 与网络、检查 DOM、执行脚本、截图，形成“改 → 跑 → 看 → 再改”的闭环。

这是 [AGENTS.md](../AGENTS.md)“上手”里那两条验证纪律（**能实测就别猜**、**dev 模式验证不了这些**）的完整版 —— 把它展开成可执行的流程与踩坑记录。什么时候该起浏览器、怎么读结果、哪些结论不能靠静态分析，下面逐条写清。

> **经验之谈**：这个项目里有好几个坑（`kbServer` 从哪来、图片为什么只有 807 字节、富文本笔记为什么被转义）如果只做静态分析会绕很久，其中两个判断还是错的。**有真实浏览器可用时，先实测再动手。**

---

## 一、Chrome 的三个硬限制

不处理的话一定会踩：

| 限制 | 现象 | 应对 |
| --- | --- | --- |
| Chrome 136+ | 对**默认 profile** 传 `--remote-debugging-port` 会被静默忽略 | 必须搭配 `--user-data-dir` 指向独立目录，`dev:chrome` 已处理 |
| Chrome 137+ | 品牌版 Chrome 移除了 `--load-extension`，无法侧载扩展 | 因此不自动装 Tampermonkey，而是复用你手动装好的 profile |
| Chrome 120+ | Tampermonkey 未开“开发者模式”时不注入用户脚本 | 在 `chrome://extensions` 打开右上角开发者模式 |

---

## 二、使用流程

```bash
# 1. 启动 dev 服务器（提供带热更新的脚本）
npm run dev

# 2. 另开终端，启动可被调试的 Chrome
npm run dev:chrome
```

按脚本提示在新 profile 里做一次性初始化：装 Tampermonkey 并开启开发者模式 → 安装 `server:wiznote-enhanced` → 登录为知笔记。之后 AI 即可接管该浏览器。

建议的调试循环：

1. `npm run dev:chrome:dry` 只打印将使用的路径与参数，不启动浏览器，用来排查环境问题
2. AI 改 `src/` → vite 热更新 → 页面自动 reload
3. AI 用 `list_console_messages` / `take_snapshot` / `evaluate_script` / `take_screenshot` / `list_network_requests` 检查结果
4. 有问题回到第 2 步

---

## 三、MCP 配置

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browserUrl=http://127.0.0.1:9222",
        "--no-usage-statistics",
        "--no-performance-crux"
      ]
    }
  }
}
```

关键参数是 `--browserUrl`：让 MCP 连接 `dev:chrome` 启动的那个实例，而不是自己另起一个 —— MCP 自己起的实例没有 Tampermonkey，也没有你的登录态，对这个场景没用。改完配置需要在 IDE 中重载 MCP 才会生效。

> ⚠️ `--browserUrl` 模式下 MCP 会**继承该 profile 的登录态和 Cookie**，这个 profile 请只用于调试、不要登录敏感账号。

---

## 四、`scripts/dev-chrome.mjs` 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WZE_DEBUG_PORT` | `9222` | CDP 端口，需与 MCP 配置一致 |
| `WZE_DEV_PORT` | `5173` | vite dev 端口 |
| `WZE_TARGET_URL` | `https://www.wiz.cn/xapp/index.html` | 启动后自动打开的页面 |
| `WZE_PROFILE_DIR` | `~/.cache/chrome-wiznote-enhanced/chrome-profile` | 调试专用 profile |
| `WZE_CHROME_PATH` | 自动探测 | Chrome 可执行文件路径 |

---

## 五、适合用浏览器实测的场合

| 场合 | 为什么必须实测 |
| --- | --- |
| 拿 `kbServer` 之类“前端没暴露、只在运行时存在”的数据 | 只能从 IndexedDB / Network 里挖 |
| 判断某个接口/路径是否被 Service Worker 代理 | 产物里读不出来，`/as/**` 的误判就是这么来的 |
| 判断一张图的响应是“真图”还是“200 + 占位图” | 必须看真实字节数 |
| 确认上游页面是否改版、DOM 结构是否变了 | 见 [site-internals.md](site-internals.md) |
| 验证一条完整链路（如 `syncOfflineDoc` 是否真能拉到正文） | 中间环节太多，静态分析容易漏 |

**常用手段**

- `evaluate_script`：读 `indexedDB.databases()`、遍历 `docs` 表、直接调 `window.LiveEditor.*` 复刻脚本里的逻辑，验证后再改代码
- `list_network_requests`：确认某个请求到底发没发、打到哪个 host
- 读 console：脚本日志带 `[wiznote-enhanced]` 前缀，建议先用油猴菜单的“设置”把“调试日志”开到 debug（设置对话框里的诊断区也能直接看到版本 / 公式引擎来源 / 为知宿主）

**注意**：用浏览器实测会**真的改到你的数据**（例如 `syncOfflineDoc` 会把笔记同步到本地缓存、导出会产生下载文件）。操作前想清楚副作用。

---

## 六、点不动？合成事件骗得过代码，骗不过浏览器

验证“点一下会发生什么”时，**不要**用 `el.click()` 或 `el.dispatchEvent(new MouseEvent('click'))`。合成事件不经过两层关键环节：

1. **命中测试**：它直接被投递给指定元素，而真实点击是谁在鼠标下面谁收；
2. **pointer capture 的重定向**：真实交互里，一旦某处捕获了指针，随后的 `pointerup` / `click` 会被改判给**捕获元素**。

这两层恰恰是“按钮点不动 / 点错元素 / 拖拽把点击吃掉”的常见成因。实测踩过一次：悬浮条上给外壳调了 `setPointerCapture`，合成 click 一路绿灯，真实鼠标却永远打不开对话框（事件被改判到外壳）。顺着这条线查下去，写法和验证方法一起改掉了，见 [export-pipeline.md §1.5](export-pipeline.md)。

**发真实鼠标事件的办法**（Chrome 的 CDP `Input.dispatchMouseEvent`，Node 22+ 自带 WebSocket，不需要额外依赖）：

```js
// node click.mjs <x> <y>
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.url.includes('你的页面'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
```

真实拖拽同理：`mousePressed` → 若干次带 `buttons: 1` 的 `mouseMoved` → `mouseReleased`（记得在关键时刻之间留几十毫秒，太快会被当成抖动）。

两个配套的坑：

- 页面**不在前台**时 CDP 的输入事件可能根本不被处理（表现为“点了没反应”）。先确认标签页是当前页，必要时 `osascript -e 'tell application "Google Chrome" to activate'`；
- `document.elementFromPoint()` 在**文档层**只会返回 Shadow DOM 的宿主元素，判断不了 shadow 内部谁被命中 —— 用 `shadowRoot.elementFromPoint(x, y)`。

