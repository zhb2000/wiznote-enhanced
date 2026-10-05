/**
 * 让出主线程的原语。
 *
 * 导出链路上有两段**同步 CPU 活**会占住主线程：收尾打包（deflate / CRC）与单篇的
 * 格式转换 + 全篇字符串处理（`html2Doc` / `doc2markdown` / 一遍遍 regex / `TextEncoder`）。
 * 占住期间浏览器不派发事件、不重绘 —— 用户看到的就是“整页不动了”。所以这两段都要
 * 边干边把主线程让出去（见 docs/export-pipeline.md §1.8）。
 */

/**
 * 让出主线程一帧。
 *
 * 用 `MessageChannel` 而不是 `setTimeout(0)` / `requestAnimationFrame`：后两者在**后台标签页**
 * 会被节流压到 1s 一次（藏久了更狠），`requestAnimationFrame` 干脆不触发 —— 那时候让出
 * 等于把流程挂住。message 事件不受定时器节流影响（React 的 scheduler 降级时也是这么做的）。
 *
 * 通道**按次建**：全局一个虽然够用（会真的并发让出的地方还没有），但那是条只在“没人并发
 * 让出”时才成立的隐藏前提 —— 一旦并发，`onmessage` 会被后一个覆盖，前一个永远等下去。
 */
export function yieldToMain(): Promise<void> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** 一段同步活最多占主线程多久就让一帧（16ms ≈ 一帧） */
export const YIELD_BUDGET_MS = 16;

/**
 * 造一个“到点才让出”的让出器。
 *
 * 为什么不干脆每次 `await yieldToMain()`：让一次要等一个 macrotask，而绝大多数笔记只有
 * 几百 KB —— 每篇都无条件让几次，几百篇就是白付的开销。它只在**真的连续占用了主线程
 * 这么久**之后才让：小笔记一次都不让，几十 MB 的剪藏则每 ~16ms 停一下，界面照样画得出来。
 *
 * 计时是**每个让出器一份**：一次批量导出、一篇笔记各建一个，串起来用（不要在模块级共用，
 * 那会把上一位的计时带进来）。
 */
export function createYielder(budgetMs: number = YIELD_BUDGET_MS): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budgetMs) return;
    await yieldToMain();
    last = performance.now();
  };
}
