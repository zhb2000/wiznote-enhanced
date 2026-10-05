import type { NoteRef } from './types';

/**
 * 笔记类型判定。
 *
 * ## 两层“类型”
 *
 * 1. **原始 `type` 字段** —— 服务端 / IndexedDB 里存的字符串，取值很杂：
 *    `''`（空，占多数）、`document`、`collaboration`、`outline`、`lite/markdown`，
 *    以及 web 端根本不认识的 `wholewebpage` / `tasklist` / `svgpainter` / `article`
 *    （这几个在 `renderer.dev.js` 和 `live-editor/index.js` 里都是 0 命中，
 *    由桌面端、移动端或服务端写入）。
 * 2. **应用归一化后的 `NoteType` 枚举** —— 只有 7 个值，
 *    由 renderer 里的 `getNoteType()` 把上面那一堆字符串收敛过来。
 *
 * 本文件复刻的是第 2 层：判定条件与 `getNoteType` /
 * `isCoEditNote` / `isLiteNote` / `isMarkdownNote` 一比一对应，
 * 保证“脚本认为的类型”和“应用菜单显示的条件”始终一致。
 * 应用改版时只需要改这个文件。
 *
 * 详细的类型清单与各自的处理方式见 `docs/note-types.md`。
 */
export type NoteType =
  | 'LiteMarkdown'
  | 'NormalMarkdown'
  | 'Outline'
  | 'Collaboration'
  | 'MathJax'
  | 'Handwriting'
  | 'Normal';

/**
 * 界面显示名。这套称呼刻意区分了两种“Markdown 笔记”，因为它们的来历完全不同：
 *
 * - `NormalMarkdown`（旧版 Markdown 笔记）：**本质上就是普通笔记**
 *   （富文本 / HTML 存储）。老版 WizNote 只看文件名里有没有 `.md` 来决定渲染路径；
 *   带 `.md` 时，它会把富文本内容**当作 markdown 纯文本**、再按 markdown 语法
 *   渲染成富文本。这是一种很别扭的约定 —— 内容既不是 markdown 源码，
 *   也不能算是规规矩矩的富文本。
 * - `LiteMarkdown`（Lite Markdown 笔记）：由当初的 **WizNote Lite 客户端**创建。
 *   Lite 原本是想取代上面那种别扭的做法，但这个客户端**已经被放弃**，
 *   它的替代品是**协作笔记**（`Collaboration`）。
 */
export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  NormalMarkdown: '旧版 Markdown 笔记',
  LiteMarkdown: 'Lite Markdown 笔记',
  Collaboration: '协作笔记',
  Normal: '普通笔记',
  Outline: '大纲笔记',
  MathJax: '旧版公式笔记',
  Handwriting: '手写笔记',
};

/** type 以 collaboration 开头的是协作笔记 */
export function isCoEditNote(type?: string): boolean {
  return !!type && type.startsWith('collaboration');
}

/** type 为 lite 或 lite/xxx 的是 Lite 客户端的轻笔记 */
export function isLiteNote(type?: string): boolean {
  return !!type && (type === 'lite' || type.startsWith('lite/'));
}

export function isOutlineNote(type?: string): boolean {
  return !!type && type === 'outline';
}

/**
 * 标题里带 .md 的笔记 —— 这就是老版 WizNote 判定“要按 markdown 渲染”的依据，
 * 跟内容无关。`.md ` / `.md@` 是历史上为了塞下同名笔记搞出来的变体。
 */
export function isMarkdownNoteTitle(title: string): boolean {
  const t = (title || '').toLowerCase();
  return t.endsWith('.md') || t.indexOf('.md ') > 0 || t.indexOf('.md@') > 0;
}

/** type 后缀像 markdown，或者标题带 .md，都算 markdown 笔记 */
export function isMarkdownNote(note: NoteRef): boolean {
  const type = note.type;
  if (isCoEditNote(type)) return false;
  return (
    !!type?.endsWith('/markdown') ||
    !!type?.endsWith('/md') ||
    !!type?.endsWith('/ma') ||
    isMarkdownNoteTitle(note.title ?? '')
  );
}

export function getNoteType(note: NoteRef): NoteType {
  if (isCoEditNote(note.type)) return 'Collaboration';
  if (isMarkdownNote(note)) return isLiteNote(note.type) ? 'LiteMarkdown' : 'NormalMarkdown';
  if (note.type === 'handwriting') return 'Handwriting';
  if (note.type?.toLowerCase() === 'outline') return 'Outline';
  return /\.mj(\s|@|$)/gi.test(note.title ?? '') ? 'MathJax' : 'Normal';
}

/**
 * 目前能转 Markdown 的类型。
 * Handwriting / MathJax 仍走“导出原始 HTML”兜底（TODO: 后续研究这两类的结构）。
 *
 * 注意 `Normal` 也在这条路上：web 端不认识的 `wholewebpage` / `tasklist` /
 * `svgpainter` / `article` 以及占一半以上的空 type 都会落到这里。
 */
export function isMarkdownExportable(type: NoteType): boolean {
  return (
    type === 'Outline' ||
    type === 'Collaboration' ||
    type === 'LiteMarkdown' ||
    type === 'NormalMarkdown' ||
    type === 'Normal'
  );
}

/** 去掉标题里的 .md 后缀，用于生成文件名 */
export function extractNoteTitle(title: string): string {
  if (!isMarkdownNoteTitle(title)) return title;
  const t = title.toLowerCase();
  if (t.endsWith('.md')) return title.slice(0, title.length - 3);
  const space = t.indexOf('.md ');
  if (space > 0) return title.slice(0, space);
  const at = t.indexOf('.md@');
  if (at > 0) return title.slice(0, at);
  return title;
}
