import { getOverlayRoot } from '../panel/host';

/*
 * 两个问题：“焦点此刻在哪”与“哪些元素能 Tab 到”。之所以独立成一个模块，是因为有两个
 * 消费者问的是同一件事，而它们对答案的用法必须一致：
 *
 * - `ui/kit/modal.ts`：打开时接焦点、Tab 环绕、关闭后把焦点还回去；
 * - `ui/export-tasks.ts`：悬浮条被拆掉又重建之后，接着把焦点还给原来那一行。
 *
 * 判断“焦点算不算掉在空处”尤其只有一份 —— 两边各写一遍的话，慢慢就会一边把宿主元素当成
 * “有焦点”、另一边不认。
 */

/** 能被 Tab 到的元素。够用即可 —— 面板里只有按钮、复选框、下拉与外链这几种 */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * `scope` 里能 Tab 到的元素，按文档顺序。
 *
 * `aria-disabled` 的元素**要留着**：确认行待决期间它就是焦点的落点（见 `kit/confirm.ts`），
 * 滤掉会让 Tab 无处可去。`getClientRects()` 为空说明没有盒子（`hidden` / `display: none`），
 * 那些本来也 Tab 不到。
 */
export function focusablesIn(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0,
  );
}

/**
 * 焦点此刻落在哪个元素上；**没落在任何元素上**时给 `null`。
 *
 * ⚠️ 必须问 `ShadowRoot.activeElement`：焦点在 Shadow DOM 里时，`document.activeElement`
 * 只会给出宿主（`#wze-overlay`）。`body`、`documentElement` 与那个宿主本身都算“没落在任何
 * 元素上”——调用方正是拿这个判断“焦点是不是掉了、该不该接管”。
 */
export function focusedElement(): HTMLElement | null {
  const root = getOverlayRoot();
  const active = (root.activeElement as HTMLElement | null) ?? document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body || active === document.documentElement || active === root.host) return null;
  return active;
}
