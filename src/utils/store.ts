type StoreDefaults = Record<string, unknown>;

/**
 * 基于 GM_getValue / GM_setValue 的带默认值类型安全存储。
 */
export function createStore<T extends StoreDefaults>(defaults: T) {
  type Key = keyof T & string;

  const keys = Object.keys(defaults) as Key[];

  function get<K extends Key>(key: K): T[K] {
    const stored = GM_getValue(key);
    return (stored === undefined ? defaults[key] : stored) as T[K];
  }

  function set<K extends Key>(key: K, value: T[K]): void {
    GM_setValue(key, value);
  }

  function remove<K extends Key>(key: K): void {
    GM_deleteValue(key);
  }

  function reset(): void {
    for (const key of keys) GM_deleteValue(key);
  }

  function all(): T {
    const result: Record<string, unknown> = { ...defaults };
    for (const key of keys) {
      const stored = GM_getValue(key);
      if (stored !== undefined) result[key] = stored;
    }
    return result as T;
  }

  return { get, set, remove, reset, all };
}
