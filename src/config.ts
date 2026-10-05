/** 版本号唯一来源是 package.json、仓库地址唯一来源是 vite.config.ts 的 REPO，都在构建时注入 */
const REPO = __APP_REPO__;

export const META = {
  name: 'wiznote-enhanced',
  version: __APP_VERSION__,
  /** 作者名（与 vite.config.ts 的 userscript.author 保持一致） */
  author: 'ZHB',
  /** 作者主页：从 REPO 的 owner 派生，省得多写一处地址 */
  authorUrl: `https://github.com/${REPO.split('/')[0]}`,
  /** 项目地址（GitHub 仓库） */
  homepage: `https://github.com/${REPO}`,
  /** 项目地址的展示文本（去掉协议，设置面板里一行放得下） */
  homepageLabel: `github.com/${REPO}`,
} as const;

export const config = {
  /** 注入 DOM 时使用的 class 前缀，避免污染宿主页面样式 */
  prefix: 'wze',
  /**
   * 站点选择器集中放这里，页面改版时只改这一处。
   * 2026-10-03 实测 xapp 0.1.107：React 应用挂在 #root，body class 为 desktop-body。
   */
  selectors: {
    appRoot: '#root',
  },
  /**
   * 应用地址。`/xapp` 与 `/xapp/index.html` 是同一个应用，站点不做跳转，
   * 所以 `vite.config.ts` 的 `@match` 两条都要覆盖（见那里的注释）。
   */
  targetUrl: 'https://www.wiz.cn/xapp',
} as const;
