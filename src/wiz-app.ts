/**
 * 为知笔记 web 版会把桌面端的宿主桥接对象挂到 window.wizApp 上，
 * 这是做增强功能时最稳定的切入点（比直接操作 React DOM 可靠得多）。
 *
 * 脚本运行在油猴沙箱里，必须通过 unsafeWindow 才能拿到页面自己的 window。
 */
/**
 * 运行平台。⚠️ 是个**对象**不是字符串 —— 早期这里声明成 `string` 是错的，
 * 界面上直接印出来就成了 `[object Object]`（2026-10-04 实测抓出来的）。
 * 要给人看的名字用 `WizAppBridge.os`（形如 `macOS`）。
 */
export interface WizPlatform {
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isAndroid: boolean;
  isIOS: boolean;
}

export interface WizAppBridge {
  isElectron: boolean;
  isMainWindow: boolean;
  isDev: boolean;
  isMobile: boolean;
  version: string;
  platform: WizPlatform;
  os: string;
  appPath: string;
  localhostPort: number;
  getResourcesPath?: () => string;
  windowManager: unknown;
  settings: unknown;
  utils: unknown;
  crypto: unknown;
}

export function getWizApp(): WizAppBridge | undefined {
  return (unsafeWindow as unknown as { wizApp?: WizAppBridge }).wizApp;
}
