import { config } from '../config';
import { motionMs } from './kit/morph';
import { getOverlayRoot } from './panel/host';

let host: HTMLElement | undefined;

function ensureHost(): HTMLElement {
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.className = `${config.prefix}-toast-host`;
  getOverlayRoot().append(host);
  return host;
}

/** 页面内的轻量提示，和面板共用 Shadow DOM 宿主，不受宿主页面样式影响 */
export function showToast(message: string, type: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `${config.prefix}-toast ${config.prefix}-toast-${type}`;
  el.textContent = message;
  ensureHost().appendChild(el);

  window.setTimeout(() => {
    el.classList.add(`${config.prefix}-toast-out`);
    // 摘节点的延迟必须等于 `.wze-toast` 那条 `opacity` 过渡的时长（`--wze-dur-normal`），
    // 所以从同一个 token 读，而不是在这里写死 200 —— 归零时（reduced-motion）也会立刻摘掉
    window.setTimeout(() => el.remove(), motionMs('normal'));
  }, type === 'error' ? 5000 : 2800);
}
