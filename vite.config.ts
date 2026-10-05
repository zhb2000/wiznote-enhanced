import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import pkg from './package.json' with { type: 'json' };

/**
 * 代码发布仓库（owner/repo）。必须与真实公开仓库一致：用户端的更新源就是这里的
 * `releases/latest` 固定地址，写错会让所有用户的更新检查 404。
 * 换仓库时只改这一处，下面的 namespace 与两个更新地址都从它派生。
 */
const REPO = 'zhb2000/wiznote-enhanced';
/** release 资产文件名，同时喂给 build.fileName / build.metaFileName，改的时候两边要一致 */
const USER_JS_FILE = 'wiznote-enhanced.user.js';
const META_JS_FILE = 'wiznote-enhanced.meta.js';
/**
 * GitHub 提供的固定地址：永远指向“最新正式 release”里的同名资产。
 * `latest` 只认正式 release，prerelease 不算 —— 所以“发布正式 release”即为“发布新版本”。
 */
const releaseAsset = (file: string) => `https://github.com/${REPO}/releases/latest/download/${file}`;

export default defineConfig(({ mode }) => ({
  // 版本号唯一来源是 package.json，脚本文档块与运行时代码都从这里派生
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // 仓库地址也注入运行时，供设置面板的“关于”展示（避免 REPO 写两份）
    __APP_REPO__: JSON.stringify(REPO),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    minify: mode === 'production',
    sourcemap: mode === 'production' ? false : 'inline',
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      // 这里的内容会生成成脚本文档块的 UserScript 注释，构建时写入 .user.js 文件头
      userscript: {
        name: 'wiznote-enhanced',
        namespace: `https://github.com/${REPO}`,
        version: pkg.version,
        description: '为知笔记增强脚本',
        author: 'ZHB',
        // 与 package.json 保持一致：直接读 pkg，避免两处各写一份而漂移
        license: pkg.license,
        icon: 'https://www.wiz.cn/favicon.ico',
        /*
         * `/xapp` 与 `/xapp/index.html` 是同一个应用的两个地址（站点对前者不做跳转），
         * 而 match pattern 的 `/xapp/*` 只匹配 `/xapp/` 开头的路径，覆盖不到 `/xapp` 本身，
         * 所以两条路径都要显式列出。
         */
        match: [
          'https://www.wiz.cn/xapp',
          'https://www.wiz.cn/xapp/*',
          'https://*.wiz.cn/xapp',
          'https://*.wiz.cn/xapp/*',
        ],
        // autoGrant 默认开启，会按代码里实际引用的 GM_* 自动补全（包括打包器
        // 自己生成的 CSS 注入代码用到的 GM_addStyle），这里只显式列出在用的基线
        grant: [
          'unsafeWindow',
          'GM_addStyle',
          'GM_getValue',
          'GM_setValue',
          'GM_deleteValue',
          'GM_registerMenuCommand',
          'GM_unregisterMenuCommand',
          // 导出在后台跑完时提醒用户（悬浮条形态下页面里看不到结果）
          'GM_notification',
        ],
        // 不发 GM_xmlhttpRequest / GM_download，联网一律走页面内的原生 fetch，
        // 因此不需要 @connect；若将来改用 GM_xmlhttpRequest，这里要补回来。
        // 离线公式渲染所需的 MathJax 源码已内联进产物（见
        // src/features/offline-mathjax.ts），不再需要 @resource，
        // 也就不再需要 GM_getResourceText。
        // xapp 是纯前端渲染的 SPA，document-start 注入才能拿到最早的时机
        'run-at': 'document-start',
        noframes: true,
        // 更新源：油猴检查更新时先拉 meta.js（只含这段注释头，几百字节），
        // 发现 @version 变大才按 downloadURL 下载完整脚本。
        // 这两个字段写在脚本头里，油猴一律采用、与安装方式无关（从 URL / 本地拖拽 / 编辑器新建都一样，已实测）；
        // 安装时的来源地址只是脚本没写这两个字段时的兜底更新源。
        // 只在生产构建里挂：dev 模式下的脚本是带 `server:` 前缀的独立条目，
        // 既不需要更新源，也免得对它点“检查更新”时被 GitHub 上的版本替换掉。
        ...(mode === 'production'
          ? {
              updateURL: releaseAsset(META_JS_FILE),
              downloadURL: releaseAsset(USER_JS_FILE),
            }
          : {}),
      },
      build: {
        fileName: USER_JS_FILE,
        // 额外产出只含注释头的 meta.js，供油猴检查更新时轻量下载
        metaFileName: META_JS_FILE,
      },
      server: {
        // 开发时不自动拉起浏览器；手动安装的是 dev server 提供的安装脚本：
        // http://127.0.0.1:5173/__vite-plugin-monkey.install.user.js
        open: false,
        // 开发环境下注入 GM_* API 的实现，避免本地跑报错
        mountGmApi: true,
      },
    }),
  ],
}));
