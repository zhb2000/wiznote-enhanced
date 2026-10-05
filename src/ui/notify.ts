import { logger } from '../utils/log';

const log = logger('notify');

/**
 * 发一条**系统级**通知（导出在后台跑完时提醒用户）。
 *
 * 优先用油猴的 `GM_notification`：它不需要页面授权、不受“通知权限被拒”影响，
 * 在浏览器已经最小化时也能弹出来。退而求其次用页面自己的 Notification API
 * （需要用户此前已授权）。两条都不通就返回 `false`，由调用方降级成页面内 toast。
 *
 * 这里刻意不 import 任何 UI：它只负责“发得出去还是发不出去”。
 */
export function sendSystemNotification(title: string, body: string, onClick?: () => void): boolean {
  const activate = (): void => {
    try {
      window.focus();
    } catch {
      /* 部分环境不允许脚本抢焦点，忽略即可 */
    }
    onClick?.();
  };

  try {
    if (typeof GM_notification === 'function') {
      GM_notification({ title, text: body, timeout: 8000, onclick: activate });
      return true;
    }
  } catch (error) {
    log.warn('GM_notification 失败', error);
  }

  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const notification = new Notification(title, { body, tag: 'wze-export' });
      notification.onclick = activate;
      return true;
    }
  } catch (error) {
    log.warn('Notification 失败', error);
  }

  return false;
}
