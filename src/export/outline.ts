import { logger } from '../utils/log';
import { getLiveEditor } from './app-bridge';

const log = logger('outline');

/**
 * 每层缩进 3 个空格 —— 实测 `doc2markdown` 输出无序列表就是这个缩进、`*` 作项目符号，
 * 大纲跟着用同一套，产物里的列表长得和其它笔记一致。
 */
const INDENT = '   ';

/** 空节点不能只写一个 `*`：那在 markdown 里是分隔线，得给个占位内容 */
const EMPTY_PLACEHOLDER = '&nbsp;';

/** 按 class 找直接子元素（不用 `:scope`，避免选择器兼容问题，读起来也更直白） */
function childByClass(parent: Element, className: string): Element | undefined {
  for (const child of Array.from(parent.children)) {
    if (child.classList.contains(className)) return child;
  }
  return undefined;
}

/**
 * 大纲笔记（`type: 'outline'`）的 HTML → markdown 嵌套列表。
 *
 * 它的正文是**一棵纯 div 树**（实测 2026-10-04，xapp 0.1.107，9 篇样本结构一致）：
 *
 * ```html
 * <body class="wiz-editor-body" data-wiz-document-type="outline">
 *   <div class="outline-container">
 *     <div class="node">
 *       <div class="row">
 *         <div class="operator-container">…折叠箭头 / 圆点…</div>   ← 纯装饰，丢掉
 *         <div class="content">节点文本</div>
 *       </div>
 *       <div class="child children">                               ← 子节点容器；叶子没有它
 *         <div class="node">…</div>
 *       </div>
 *     </div>
 *   </div>
 * </body>
 * ```
 *
 * **为什么不走 `html2Doc → doc2markdown`**：那条路的 HTML→doc 是 Turndown + marked，
 * 实测会把整棵树**抹平**成一串平级文字（76 个节点 → 55 行扁平的 `* 文本`，还夹着 `\*` 转义垃圾）。
 * 而 `doc2markdown` 自己渲染嵌套列表是**正确的**，所以这里自己遍历树、直接产出与它同款的
 * 嵌套列表 markdown（每层 3 空格缩进 + `*`）。
 *
 * 几条实测结论：
 *
 * - **节点文本是纯文本**：9 篇共 1057 个节点的 `content` 里没有任何子元素（连 `<br>` 都没有），
 *   所以直接取 `textContent` 即可；
 * - **转义交给应用自己的 `escapeMarkdownText()`**，让节点文本按字面渲染 —— 大纲里写什么就是什么；
 * - **折叠状态不影响解析，也不用管**。它是纯编辑器的界面状态：**不持久化**（关掉笔记再打开就恢复展开，
 *   实测 2026-10-04），也不改动笔记内容（那篇 `dataModified` 仍是 2020-06-15）。根因是**导出不读编辑器的
 *   实时 DOM**，读的是本地数据服务渲染的 `/ks/note/view/…/index.html` —— 那份 HTML 里父节点全是
 *   `switch.active`、子节点齐全。实测笔记开着、且节点已折叠时导出，**内容依然完整**；
 * - 图片 / 附件 / 批注在大纲笔记里不存在（HTML 里没有 `<img>`、没有 `wiz://`、没有批注层），
 *   但下游的改写步骤照旧会跑，不影响正确性。
 *
 * 返回 `undefined` 表示这份 HTML 里没有大纲结构（调用方据此报"无法转换"）。
 *
 * `breathe` 是篇内的让出器（见 `utils/yield.ts`）：整篇 HTML 解析与逐节点遍历都是同步活，
 * 一份很大的大纲能在主线程上待上一阵，中间歇几帧界面才画得出来。
 */
export async function outlineHtmlToMarkdown(
  html: string,
  breathe?: () => Promise<void>,
): Promise<string | undefined> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // 解析是这一步里最重的一下（整篇 HTML 建 DOM）
  await breathe?.();
  const root = parsed.body?.querySelector('.outline-container');
  if (!root) return undefined;

  const escape = getLiveEditor()?.escapeMarkdownText;
  const lines: string[] = [];
  let nodes = 0;
  let maxDepth = 0;

  const walk = async (container: Element, depth: number): Promise<void> => {
    for (const child of Array.from(container.children)) {
      if (child.nodeType !== 1 || !child.classList.contains('node')) continue;
      nodes += 1;
      maxDepth = Math.max(maxDepth, depth);

      const row = childByClass(child, 'row');
      const content = row ? childByClass(row, 'content') : undefined;
      // 换行只是 HTML 的排版，折成空格；行内连续空格保持原样（可能是用户刻意对齐）
      const raw = (content?.textContent ?? '').replace(/\s*\n\s*/g, ' ').trim();
      const text = raw ? (escape ? escape(raw) : raw) : EMPTY_PLACEHOLDER;
      lines.push(`${INDENT.repeat(depth - 1)}* ${text}`);

      // 每 500 个节点一个让出点：每个节点都要走一次 escapeMarkdownText，节点多了也是可观的量
      if (nodes % 500 === 0) await breathe?.();

      const kids = childByClass(child, 'child');
      if (kids) await walk(kids, depth + 1);
    }
  };

  await walk(root, 1);
  if (nodes === 0) return undefined;

  log.debug('大纲已转成嵌套列表', { nodes, maxDepth });
  return lines.join('\n');
}
