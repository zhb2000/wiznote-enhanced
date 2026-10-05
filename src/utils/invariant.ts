import { logger } from './log';

const log = logger('invariant');

/**
 * 断言“理论上不该发生”的不变量。
 *
 * - **开发模式**：直接抛错 —— 回归在开发期就暴露，而不是等用户丢文件；
 * - **生产构建**：只 `log.error`、继续往下走 —— 导出是几分钟的长流程（要拉图、拉附件），
 *   抛错会让 `export-dialog` 的 catch 把**整份成果**作废，代价与收益完全不匹配。
 *
 * 也就是：“不该发生”的事情只有**一种**处理姿势 —— dev 炸、prod 记日志。
 * 别在各处再手写一套 `if (...) throw` 或静默忽略。
 *
 * 用途：zip 内路径重复、正文路径重复这类**只可能由代码 bug 导致**的情况。
 */
export function invariant(condition: unknown, message: string, details?: unknown): boolean {
  if (condition) return true;
  log.error(`不变量被破坏：${message}`, details);
  if (import.meta.env.DEV) throw new Error(`[wiznote-enhanced] 不变量被破坏：${message}`);
  return false;
}
