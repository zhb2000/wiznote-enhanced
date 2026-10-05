export function onDomReady(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
  } else {
    fn();
  }
}

export function $(selector: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector);
}

export function $$(selector: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; textContent?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.className) el.className = options.className;
  if (options.textContent) el.textContent = options.textContent;
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * 等待元素出现，SPA 页面推荐用它替代轮询。
 */
export function waitForElement<T extends Element = HTMLElement>(
  selector: string,
  options: { root?: ParentNode & Node; timeout?: number } = {},
): Promise<T> {
  const { root = document, timeout = 10_000 } = options;

  const existed = root.querySelector<T>(selector);
  if (existed) return Promise.resolve(existed);

  return new Promise<T>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const el = root.querySelector<T>(selector);
      if (!el) return;
      cleanup();
      resolve(el);
    });

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`waitForElement 超时: ${selector}`));
    }, timeout);

    function cleanup(): void {
      observer.disconnect();
      window.clearTimeout(timer);
    }

    observer.observe(root, { childList: true, subtree: true });
  });
}
