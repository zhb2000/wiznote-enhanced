import { logger } from '../utils/log';
// MathJax 3.2.0 完整包（es5/tex-svg-full.min.js）的源码。
// 构建时由 Vite 的 `?raw` 把文件内容转成一个字符串常量打进产物，
// 脚本因此完全自包含 —— 不依赖 @resource、也不依赖油猴的资源缓存，
// 断网（含 DevTools Offline）时照样能渲染公式。
import mathjaxSource from '../vendor/mathjax/tex-svg-full.min.js?raw';

const log = logger('mathjax');

/**
 * 应用加载 MathJax 时写死的 script id。
 * 应用的注入函数逻辑是：
 *   if (document.getElementById(id)) { setTimeout(cb) }   // 已存在 ⇒ 直接当作加载成功
 *   else { 创建 script，onerror 时 reject URIError }
 * 所以只要我们用同一个 id 提前注入，应用就会跳过那个必然失败的 CDN 请求。
 */
const SCRIPT_ID = 'MathJax-script';

/** 与为知笔记 internal 里设置的配置保持一致，见 renderer 的 mathjax2Svg */
function mathjaxConfig() {
  return {
    options: {
      skipHtmlTags: [
        'script',
        'noscript',
        'style',
        'textarea',
        'pre',
        'code',
        'annotation',
        'annotation-xml',
        'body',
      ],
    },
    /** 只提供转换 API，不让 MathJax 启动时扫描整页（编辑器 DOM 很大） */
    startup: { typeset: false },
  };
}

/**
 * 为知笔记把公式引擎 MathJax 3.2.0 放在第三方 CDN 上按需加载：
 *   https://cdn.staticfile.org/mathjax/3.2.0/es5/tex-svg.min.js
 * Service Worker 的预缓存清单里只有站点自己域下的 MathJax v2（旧编辑器用），
 * 不包含这个跨域 v3 文件，所以离线时该脚本(script)加载不到，
 * window.MathJax 会停留在“只有配置对象”的状态，
 * 调用 window.MathJax.tex2svgPromise 就报 `... is not a function`。
 *
 * 修复思路：把 MathJax 源码**内置进脚本体**（构建时 `?raw` 内联），在
 * document-start 阶段同步注入页面，并抢在应用之前占住 window.MathJax。
 * 这是安全的，因为应用写的是 `window.MathJax || (window.MathJax = {...})`，
 * 检测到已存在就不会覆盖，后续调用即可命中我们注入的引擎。
 *
 * 为什么内置源码而不是走 `@resource`：`@resource` 要在安装/更新脚本时联网抓取、
 * 由油猴缓存，一旦抓取失败或缓存不可用（例如 dev 模式的 loader、断网重装），
 * 就会静默降级成“应用自己拉 CDN → 失败 → not a function”。
 * 内置源码让脚本自包含，把这条依赖彻底去掉；代价是产物体积约 1.9 MB。
 *
 * ⚠️ 内置的必须是 **full** 包（tex-svg-full.min.js），不能换成 min 包：
 * MathJax 用 `document.currentScript || #MathJax-script 的 src` 推断自身 base。
 * min 包不含 boldsymbol 等扩展，靠 autoload 在运行时按需加载；而我们是内联注入
 * （script 没有 src，读到的是空字符串），base 被推断成空路径，扩展请求会落到站点
 * 自身（返回 HTML 而不是 JS）而失败，表现就是 `\boldsymbol` 等宏不可用 —— 且联网时
 * 同样会坏。full 包把全部 TeX 扩展打包进来，不依赖 autoload，内联 + 离线都可用。
 */
export function installOfflineMathJax(): void {
  const win = unsafeWindow as unknown as { MathJax?: unknown };
  if (win.MathJax) return;

  if (!mathjaxSource || mathjaxSource.length < 10_000) {
    log.warn('内置 MathJax 源码异常（为空或过短），跳过离线注入');
    return;
  }

  win.MathJax = mathjaxConfig();

  const parent: Element = document.head ?? document.documentElement;
  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.textContent = mathjaxSource;
  parent.appendChild(script);

  log.info('已注入内置 MathJax 3.2.0（完整包），离线可渲染公式');
}
