/**
 * 中止（取消）用的小工具。
 *
 * 约定：**中止 = 抛 `AbortError`** —— 和浏览器 `fetch` 接到被中止的 `signal` 时的行为一致，
 * 这样“请求被掐掉”和“我们自己决定不等了”对上层是同一种事件，一个 catch 就能收口。
 *
 * 导出流程的取消通道是一个 `AbortSignal`（见 `src/export/session.ts` 的 `activeAbort`）：
 * 在飞的请求由它直接作废，而点不出中断的等待（如协作笔记的 WebSocket 同步）用
 * `raceAbort()` 让它立刻结束。
 */

/** 造一个浏览器原生的 `AbortError` */
export function abortError(): DOMException {
  return new DOMException('已中止', 'AbortError');
}

/**
 * 让一个**不可中止**的 await 在 `signal` 中止时立刻结束。
 *
 * 底层 Promise 照跑到底（这类接口没有取消语义，例如应用的 `syncOfflineDoc` 只有超时），
 * 只是流程不再等它 —— 它稍后自己落定时结果被丢弃，也不会变成未处理的 rejection。
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    // 一条笔记里会有多次这样的等待，所以谁先落定都要把监听摘掉
    const settle = (): void => signal.removeEventListener('abort', onAbort);
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error) => {
        settle();
        reject(error);
      },
    );
  });
}
