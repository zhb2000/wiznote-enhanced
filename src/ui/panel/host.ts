import { config } from '../../config';
import panelCss from './panel.css?inline';

let root: ShadowRoot | undefined;

/** 导出对话框开着的监听者（见 `setExportDialogOpen`） */
const dialogListeners = new Set<(open: boolean) => void>();

/**
 * 取（必要时创建）脚本 UI 的 Shadow DOM 宿主。
 *
 * 面板和 toast 共用这一个宿主：宿主元素只负责铺满视口与层级，
 * 所有样式都锁在 shadow 内（见 panel.css），既不污染宿主页面，
 * 也不会被宿主的 MUI 全局样式影响。
 */
export function getOverlayRoot(): ShadowRoot {
  if (root?.host?.isConnected) return root;

  const host = document.createElement('div');
  host.id = `${config.prefix}-overlay`;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.append(style);

  (document.body ?? document.documentElement).appendChild(host);
  root = shadow;
  return shadow;
}

/** 在面板区域内查询元素（shadow 内部的东西用 document.querySelector 查不到） */
export function queryOverlay<T extends Element = HTMLElement>(selector: string): T | null {
  return root?.querySelector<T>(selector) ?? null;
}

/**
 * 导出对话框开 / 关 —— 挂 class 让**悬浮条整个藏起来**（样式在 panel.css 的
 * `:host(.wze-dialog-open) .wze-taskbar`，见 docs/export-pipeline.md §1.5）。
 *
 * 判据是“对话框在不在”，所以它由对话框一侧随挂载 / 卸载调用，宿主只负责落 class 和广播；
 * 显示隐藏交给 CSS，省掉“开 / 关各通知一遍”的时序问题（`notifyTasks()` 的先后顺序
 * 在那些路径里并不都好使）。
 *
 * **广播是给悬浮条的**：它只是被 CSS 藏起来，没有任何通知；可它需要在对话框收完的那一刻
 * 在原处冒出来（见 `ui/export-tasks.ts` 的出场补间）。先落 class 再广播 —— 监听者要能立刻
 * 量到自己的盒子。
 */
export function setExportDialogOpen(open: boolean): void {
  getOverlayRoot().host.classList.toggle(`${config.prefix}-dialog-open`, open);
  for (const listener of dialogListeners) listener(open);
}

/** 订阅导出对话框的开关（生命周期与页面一致，不提供退订） */
export function onExportDialogOpenChange(listener: (open: boolean) => void): void {
  dialogListeners.add(listener);
}
