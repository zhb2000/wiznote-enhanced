const TAG = '[wiznote-enhanced]';

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function logger(scope: string) {
  const prefix = `${TAG}[${scope}]`;
  return {
    debug: (...args: unknown[]): void => {
      if (debugEnabled) console.log(prefix, ...args);
    },
    log: (...args: unknown[]): void => console.log(prefix, ...args),
    info: (...args: unknown[]): void => console.info(prefix, ...args),
    warn: (...args: unknown[]): void => console.warn(prefix, ...args),
    error: (...args: unknown[]): void => console.error(prefix, ...args),
  };
}

export type Logger = ReturnType<typeof logger>;
