import { logger } from '../utils/log';
import { fetchNoteComments, getLiveEditor } from './app-bridge';
import type { NoteRef } from './types';

const log = logger('comments');

/**
 * 一条待导出的评论。
 *
 * 为知的评论有两套完全不同的存储，这里收敛成同一种形态：
 *
 * - **协作笔记（锚定型）**：评论在笔记自己的 doc JSON 里，通过
 *   `text[].attributes['comment-<id>con']` 锚定到一段文字上，`abstract` 就是被选中的原文。
 * - **旧版笔记（评论区）**：评论跟正文毫无关联，是独立接口返回的一条条记录，
 *   只有作者 / 时间 / 正文。
 */
export interface ExportComment {
  author: string;
  /** 毫秒时间戳 */
  created: number;
  /** 被评论的原文；只有锚定型评论有 */
  quote?: string;
  /** 评论正文的 markdown */
  body: string;
}

/** 收集结果：**“没有评论”和“取不到评论”必须分开**，后者要能让用户看见 */
export type CommentCollection =
  | { ok: true; comments: ExportComment[] }
  | { ok: false; detail: string };

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 固定成 `YYYY-MM-DD HH:mm`。
 * 不用 `toLocaleString`：导出产物不该跟着系统语言 / 时区显示格式变。
 */
export function formatCommentTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 被引用的原文可能跨行，逐行加引用前缀 */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

/**
 * 渲染文末的评论章节。没有评论时返回空串（不产生空章节）。
 *
 * 版式（2026-10-04 定稿）：
 *
 * ```md
 * ---
 *
 * # 评论（2 条）
 *
 * **张三** · 2026-10-03 22:53
 *
 * > 被评论的原文
 *
 * 评论正文
 *
 * **李四** · 2026-10-03 23:10
 *
 * 这是回复（同一串的回复平铺，不缩进）
 * ```
 *
 * 引用块（`>`）**专门用来引用原文** —— 这是 markdown 引用语法的本意。
 * 作者 / 时间走普通加粗行，不再占用引用块。
 */
export function renderCommentSection(comments: ExportComment[]): string {
  if (comments.length === 0) return '';

  const blocks = comments.map((comment) => {
    const parts = [`**${comment.author}** · ${formatCommentTime(comment.created)}`];
    if (comment.quote) parts.push(quoteLines(comment.quote));
    const body = comment.body.trim();
    if (body) parts.push(body);
    return parts.join('\n\n');
  });

  return ['---', '', `# 评论（${comments.length} 条）`, '', blocks.join('\n\n'), ''].join('\n');
}

/**
 * 只导出 HTML 的笔记类型（大纲 / 手写 / 公式）用的：评论单独落一个 `.md`。
 *
 * 这类笔记的正文只能导出成 HTML，评论区没地方挂，所以另起一个同名 `.md`
 * 专门承载评论 —— 文件名和 `.html` 成对，放在一起不会走散。
 * 第一行是 HTML 注释：渲染时不显示，但看原文能知道正文在隔壁。
 */
export function renderCommentOnlyMarkdown(baseName: string, comments: ExportComment[]): string {
  return [
    `<!-- 正文见同目录的 ${baseName}.html：该笔记类型只能导出 HTML，本文件只承载评论。 -->`,
    '',
    renderCommentSection(comments),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 来源一：协作笔记（doc JSON 里的锚定型评论）                          */
/* ------------------------------------------------------------------ */

interface DocTextRun {
  text?: string;
  attributes?: Record<string, unknown>;
}

interface DocBlock {
  type?: string;
  text?: DocTextRun[];
  /** 块级评论：直接挂在块上的评论 id */
  comments?: string[];
  children?: unknown[];
}

interface DocComment {
  id?: string;
  groupId?: string;
  displayName?: string;
  created?: number;
  /** 被评论选中的原文 */
  abstract?: string;
  blocks?: unknown[];
}

interface CollabDoc {
  blocks?: DocBlock[];
  comments?: Record<string, DocComment>;
  [key: string]: unknown;
}

function isBlockLike(value: unknown): value is DocBlock {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 按应用自己的顺序收集被引用到的评论 id：
 * 先块级（`block.comments`），再行内锚点（`text[].attributes` 里的 `comment-*`），
 * 边收边去重。**没有挂到任何锚点上的评论（孤儿）不导出** —— 应用自己也不渲染它们。
 */
function collectCommentIds(doc: CollabDoc): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (id: unknown): void => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };

  const walkText = (block: DocBlock): void => {
    for (const run of block.text ?? []) {
      for (const [key, value] of Object.entries(run.attributes ?? {})) {
        if (key.startsWith('comment-')) push(value);
      }
    }
  };

  const walkBlocks = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const item of blocks) {
      if (!isBlockLike(item)) continue;
      for (const id of item.comments ?? []) push(id);
      walkText(item);
      for (const child of item.children ?? []) {
        // children 要么是块对象，要么是 doc 上的数字键（指向一组块，见应用的 walker）
        if (isBlockLike(child)) {
          for (const id of child.comments ?? []) push(id);
          walkText(child);
        } else if (typeof child === 'number') {
          const group = doc[child];
          if (Array.isArray(group)) group.forEach((entry) => isBlockLike(entry) && (entry.comments ?? []).forEach(push));
        }
      }
    }
  };

  walkBlocks(doc.blocks);
  return ordered;
}

/** 评论 id 在属性值 / map 键里的**大小写并不一致**，两边都要能命中 */
function lookupComment(map: Record<string, DocComment>, id: string): DocComment | undefined {
  if (map[id]) return map[id];
  const lower = id.toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return key ? map[key] : undefined;
}

/** 用应用自己的渲染器把评论正文转成 markdown（评论的 blocks 就是一份小 doc） */
function renderCommentBody(blocks: unknown[]): string {
  const liveEditor = getLiveEditor();
  if (!liveEditor || blocks.length === 0) return '';
  try {
    return liveEditor
      .doc2markdown(
        { blocks, comments: {} },
        {
          keepImageSize: false,
          keepComments: false,
          // 资源名原样输出，交给后面的 rewriteImageTargets 统一改写 / 下载
          buildResourceUrl: (name: string) => name,
        },
      )
      .trim();
  } catch (error) {
    log.warn('评论正文转 markdown 失败', error);
    return '';
  }
}

/**
 * 协作笔记：评论就在本地 doc JSON 里，**零请求**。
 * 按 `created` 升序输出，让文末章节的顺序稳定。
 */
export function collectDocComments(doc: unknown): ExportComment[] {
  const source = doc as CollabDoc;
  const map = source.comments;
  if (!map) return [];

  const comments: ExportComment[] = [];
  for (const id of collectCommentIds(source)) {
    const raw = lookupComment(map, id);
    if (!raw) continue;
    const body = renderCommentBody(Array.isArray(raw.blocks) ? raw.blocks : []);
    // 应用对没有可渲染内容的评论是直接丢掉的，这里保持一致
    if (!body) continue;
    comments.push({
      author: raw.displayName || '匿名',
      created: typeof raw.created === 'number' ? raw.created : 0,
      quote: typeof raw.abstract === 'string' && raw.abstract.trim() ? raw.abstract.trim() : undefined,
      body,
    });
  }

  comments.sort((a, b) => a.created - b.created);
  log.debug('协作笔记评论', { count: comments.length });
  return comments;
}

/* ------------------------------------------------------------------ */
/* 来源二：旧版笔记（独立接口返回的评论区）                             */
/* ------------------------------------------------------------------ */

/**
 * 旧版笔记的评论**不在笔记内容里**（`index.html` 和 `html2Doc` 产物都拿不到），
 * 只能走 `/ks/note/comments` 接口现取，每篇 1 次请求。
 */
export async function collectRemoteComments(note: NoteRef, signal?: AbortSignal): Promise<CommentCollection> {
  const result = await fetchNoteComments(note, signal);
  if (!result.ok) return { ok: false, detail: result.detail };

  const comments = result.comments
    .map((raw) => ({
      author: raw.userName || '匿名',
      created: raw.created,
      body: (raw.body ?? '').trim(),
    }))
    // 没有正文的评论（例如只有一张图）在纯文本接口里等于空，跳过
    .filter((comment) => comment.body)
    .sort((a, b) => a.created - b.created);

  log.debug('旧版笔记评论', { docGuid: note.docGuid, count: comments.length });
  return { ok: true, comments };
}
