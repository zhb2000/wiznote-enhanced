import { raceAbort } from '../utils/abort';
import { logger } from '../utils/log';
import { createYielder } from '../utils/yield';
import {
  fetchKbServer,
  fetchResourceText,
  fetchNoteAttachmentName,
  fetchText,
  getLiveEditor,
  isLocalDataServiceReady,
  isNoteStoredLocally,
  listNoteAttachments,
  noteViewPath,
  readNoteTags,
  rememberResourceSource,
  resolveKsUrl,
  resolveTagPaths,
  syncCollabDoc,
  triggerRemoteDocFetch,
} from './app-bridge';
import {
  collectDocComments,
  collectRemoteComments,
  renderCommentOnlyMarkdown,
  renderCommentSection,
} from './comments';
import {
  collectMetadata,
  type NoteMetadata,
  nowIso,
  renderFrontMatter,
  renderMetadataJson,
} from './metadata';
import {
  EXTERNAL_URL,
  IMAGE_EXT,
  linkTargetParts,
  replaceInlineLinks,
  rewriteImageTargets,
  unescapeMarkdown,
} from './markdown-inline';
import { convertToValidFilename, createNameAllocator, portableName, toDiskName } from './naming';
import {
  extractNoteTitle,
  getNoteType,
  isMarkdownExportable,
  NOTE_TYPE_LABEL,
  type NoteType,
} from './note-type';
import { outlineHtmlToMarkdown } from './outline';
import type { ExportOptions, MetadataFormat, NoteRef } from './types';

const log = logger('export');

/** 资源落盘的子目录：图片进 `images/`，附件进 `attachments/` */
export type ResourceDir = 'images' | 'attachments';

/** 取数通道 */
export type ResourceChannel =
  /** 按资源名走 `/resources/`：图片、协作笔记的 office 附件 */
  | 'resource'
  /** 普通笔记的附件：按 attGuid 走 `/ks/attachment/download/` */
  | 'attachment';

/**
 * 一个资源**被哪份产物引用**。
 *
 * - `markdown`：Markdown 正文明明引用了它（`![](images/x.png)`）—— 取不到就是“正文缺图”；
 * - `html`：只有 HTML 产物 / 另附的 HTML 里用到（含内联样式表的 `url()`）—— 取不到时
 *   正文其实是完整的，提示不该吓唬用户。
 *
 * ⚠️ 语义是“**至少**出现在 markdown 里”：同一份资源被两边同时引用时按**先登记**的那次算，
 * 而调用顺序保证了 markdown 先于 HTML（见 renderNote 里 `rewriteImageTargets` 与
 * `localizeHtmlResources` 的先后），所以共享图片会被记成 `markdown`（正文确实引用了它）。
 */
export type ResourceReference = 'markdown' | 'html';

export interface ResourceRef {
  /**
   * 取数用的键：`resource` 通道是资源名，`attachment` 通道是 **attGuid**。
   *
   * 资源名保持原样不要改写：老笔记是 `index_files/xxx.png`，协作笔记是不带前缀的
   * 哈希 `xxx.png`，两者的访问路径完全不同（见 app-bridge 的 resourcePaths）。
   */
  name: string;
  /** 放进 zip 时用的文件名 */
  basename: string;
  /** 落盘子目录 */
  dir: ResourceDir;
  /** 怎么把它取回来 */
  channel: ResourceChannel;
  /** 被哪份产物引用（只影响“没取到”那句提示怎么写） */
  referencedBy: ResourceReference;
}

/** 从笔记里抽出来的额外文件（如批注图层），直接写进产物，不需要下载 */
export interface ExtractedFile {
  /** 相对笔记目录的路径，例如 `images/annotation-1.svg` */
  path: string;
  data: Uint8Array;
}

export interface RenderedNote {
  fileName: string;
  noteType: NoteType;
  noteTypeLabel: string;
  /** markdown 正文；走 HTML 兜底时为空 */
  markdown?: string;
  /** 原始 HTML，仅用于不支持的类型兜底 */
  html?: string;
  resources: ResourceRef[];
  /** markdown 里引用的本地图片数量，用于判断该不该打包 */
  imageRefs: number;
  /** 笔记里引用的附件数量（落盘到 `attachments/`），同样参与“要不要打包”的判断 */
  attachmentRefs: number;
  /** 检测到的手写批注层数（覆盖式批注，markdown 承载不了，只做降级保留） */
  annotations: number;
  /** 写进文末“评论”章节的评论条数 */
  comments: number;
  /** 勾了“包含评论”但取不到时的原因，交给结果区提示，不静默略过 */
  commentsError?: string;
  /**
   * 评论落在**另一个 `.md` 文件**里（只导出 HTML 的笔记类型才这样，
   * 因为 HTML 承载不了 markdown 章节）
   */
  commentsSidecar?: boolean;
  /**
   * 这篇笔记导出过程中遇到的、需要让用户知道的问题。
   * 例如外链样式表取不到被移除 —— 和“图片没取到”一样，进结果页的“问题”列表。
   */
  problems?: string[];
  /** 批注图层文件，已生成好，直接写进产物 */
  extractedFiles: ExtractedFile[];
  /** 元数据落成了同名 .meta.json（JSON 模式，或 HTML 笔记装不下 YAML 时的降级） */
  metadataSidecar: boolean;
  /** 另附了原始 HTML（针对有损转换的保真备份） */
  htmlSidecar: boolean;
}

export type RenderOutcome = { ok: true; data: RenderedNote } | { ok: false; detail: string };

/**
 * 从 Lite Markdown 笔记的 HTML 里抠出 markdown 原文。
 * 复刻应用自己的 getMarkdownFromHtml：markdown 被塞在
 * <pre><!--wiznote-lite-markdown--></pre> 里。
 */
function extractMarkdownFromLiteHtml(html: string): string {
  const start = html.indexOf('<pre>');
  const end = html.lastIndexOf('</pre>');
  if (start === -1 || end === -1 || start > end) return '';
  return html
    .slice(start + 5, end)
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/*
 * 图片 / 链接目标的解析（`replaceInlineLinks`、`splitImageTitle`、`rewriteImageTargets`
 * 等）已挪进 `./markdown-inline.ts`：那一层刻意零依赖，好让 `npm run check:markdown`
 * 能把脏字符串直接喂进来测（配对括号那个坑就是这么钉住的）。`EXTERNAL_URL` 与
 * `IMAGE_EXT` 也从那里来。
 */

/**
 * 协作笔记的**双向链接**（wiki-link）：`[[<名称> id=<guid>]]` → `[[<名称>]]`。
 *
 * 它在 doc 里是**行内文本属性** `{ type: 'wiki-link', name, linkId }`，
 * `doc2markdown` 把它序列化成应用自家方言 `[[<name> id=<linkId>]]`。那段 `id=<guid>`
 * 让主流渲染器（Obsidian / 思源 / Logseq）**解析不出来，只能当纯文本显示**；
 * 去掉它就成了通用的 wikilink，离线也能点开。
 *
 * 代价（刻意的取舍）：丢掉 `linkId` 这个**稳定锚点**，从此按标题匹配 ——
 * 目标笔记改名后就指不准了（`name` 还是创建链接时的快照）。
 *
 * 几条边界：
 * - **只作用在协作笔记上**（调用方判断类型）。Lite Markdown 笔记的正文是用户手写的
 *   markdown，里面的 `[[…]]` 是原文，绝不能动 —— 和 §六 的反转义是同一条约定；
 * - 只认“带 `id=<36 位 guid>`”的形态，普通 `[[名称]]` 原样不动；
 * - 名称里不允许有 `[` `]`（否则边界无法确定），所以用户**手打在双链外面**的那对方括号
 *   会被保留：`[` + `[[名称 id=guid]]` + `]` → `[[[名称]]]`（那对方括号本来就是正文）。
 */
const WIKI_LINK = /\[\[([^[\]\n]{1,200}?)\s+id=[0-9a-fA-F-]{36}\]\]/g;

function rewriteWikiLinks(markdown: string): string {
  let count = 0;
  const next = markdown.replace(WIKI_LINK, (_whole, name: string) => {
    count += 1;
    return `[[${name}]]`;
  });
  if (count > 0) log.debug('双链已去掉 id（[[名称 id=guid]] → [[名称]]）', { count });
  return next;
}

/**
 * 资源名 → 落盘路径的分配器。
 *
 * markdown 正文、评论、HTML 里的图片、附件、以及批注图层**共用同一个分配器**：
 * 同一个资源名必须映射到同一个文件，否则会各自指向不同的文件（甚至重复下载）。
 *
 * 去重按**子目录 + 文件名**算（`images/a.png` 与 `attachments/a.png` 互不冲突），
 * 撞名加 ` (2)` 后缀 —— 与 zip 里其他文件的规则**完全一致**，见 `naming.ts`。
 */
interface ResourceNamerOptions {
  /** “希望用的文件名”（附件用它上传时的原始文件名） */
  preferred?: string;
  /** 怎么把它取回来（缺省 `resource`） */
  channel?: ResourceChannel;
  /** 被哪份产物引用（缺省 `markdown`） */
  referencedBy?: ResourceReference;
}

interface ResourceNamer {
  /**
   * 资源名 → 落盘用的文件名（不含目录），同一目录内不重名。
   *
   * `preferred` 是“希望用的文件名”（附件用它上传时的原始文件名）；
   * 图片不传，沿用资源名（哈希 / `index_files` 名），行为保持不变。
   */
  basename(name: string, dir: ResourceDir, options?: ResourceNamerOptions): string;
  /** 资源名 → 产物内的相对路径（如 `images/xxx.png` / `attachments/文档.pdf`） */
  path(name: string, dir: ResourceDir, options?: ResourceNamerOptions): string;
  /**
   * 认领一个**内容已生成、不需要下载**的文件名（批注图层）。
   *
   * 和 `basename` 共用同一个命名空间，所以不会和真实图片撞名；撞了就同样加 ` (2)`。
   * 调用方必须拿返回的名字去写链接，这样链接与落盘永远一致 —— 批注图层只走这一个入口。
   */
  claim(desired: string, dir: ResourceDir): string;
  /** 目前收集到的、去重后的下载清单 */
  list(): ResourceRef[];
}

function createResourceNamer(): ResourceNamer {
  const resources: ResourceRef[] = [];
  /** `${dir}\n${资源名}` → 分配到的 basename */
  const byName = new Map<string, string>();
  // 与 archive 级（task.ts）共用同一套“撞名加 ` (N)`”算法，见 naming.ts。
  // scope 取子目录名，所以 `images/a.png` 与 `attachments/a.png` 天然不冲突。
  const names = createNameAllocator();

  const assignBasename = (
    name: string,
    dir: ResourceDir,
    options: ResourceNamerOptions = {},
  ): string => {
    const key = `${dir}\n${name}`;
    const cached = byName.get(key);
    // 同一个资源先被 markdown 登记过就一直是 markdown：语义是“至少出现在正文里”
    // （见 ResourceReference 的说明），所以命中缓存时不要覆盖 referencedBy。
    if (cached) return cached;

    const { preferred, channel = 'resource', referencedBy = 'markdown' } = options;
    const lastSegment = name.split('/').pop() ?? name;
    const fallback = lastSegment.split('?')[0].split('#')[0] || lastSegment;
    // 名字来自两处，都要走“对齐上游 + 落盘加固”（见 naming.ts）：
    // - `preferred`：附件上传时的原始文件名（用户数据，可能带 `/`、控制字符、超长）；
    // - 资源名最后一段：图片名来自笔记 HTML / URL（同样可能非法或超长）。
    // 清洗掉路径分隔符是硬要求 —— 否则会在 zip 里造出目录，甚至路径穿越（`..`）。
    const fromPreferred = preferred ? convertToValidFilename(preferred).replace(/\s+/g, ' ') : '';
    const hardened = portableName(fromPreferred || convertToValidFilename(fallback));
    // 加固后为空（原文只剩控制字符 / 点号）时退回通用名，撞名交给分配器
    const basename = names.allocate(hardened || '未命名文件', { scope: dir });
    resources.push({ name, basename, dir, channel, referencedBy });
    byName.set(key, basename);
    return basename;
  };

  return {
    basename: assignBasename,
    path(name: string, dir: ResourceDir, options?: ResourceNamerOptions): string {
      return `${dir}/${assignBasename(name, dir, options)}`;
    },
    claim(desired: string, dir: ResourceDir): string {
      return names.allocate(desired, { scope: dir });
    },
    list(): ResourceRef[] {
      const unique = new Map<string, ResourceRef>();
      for (const item of resources) unique.set(`${item.dir}\n${item.name}`, item);
      return [...unique.values()];
    },
  };
}

/**
 * 把资源清单拆成“图片数 / 附件数”。
 *
 * 报告里的 `图片 成功/总数` 与 `附件 成功/总数` 都是**本次要落盘的文件数**，
 * 不是引用次数（同一份资源被引用多次只下载一次），所以两个计数必须各自独立。
 */
function resourceCounts(resources: ResourceRef[]): { imageRefs: number; attachmentRefs: number } {
  let imageRefs = 0;
  let attachmentRefs = 0;
  for (const resource of resources) {
    if (resource.dir === 'images') imageRefs += 1;
    else attachmentRefs += 1;
  }
  return { imageRefs, attachmentRefs };
}

/*
 * 图片引用（`![alt](目标)`）的改写是 `rewriteImageTargets()`，在 `./markdown-inline.ts`：
 * 保留原始资源名（下载路径要靠它推导），`rewrite: false` 时只计数、不动链接 —— 否则会留下
 * 指向不存在文件的 `images/...` 引用。这里不再包一层，调用处直接用那个名字。
 */

/* ------------------------------------------------------------------ */
/* 附件（协作笔记的 embed 块）                                         */
/* ------------------------------------------------------------------ */

/**
 * 一篇笔记里的一个附件（上传的非图片文件）。
 *
 * 实测（2026-10-04，xapp 0.1.107）：协作笔记的附件是 doc 里的一个
 * `type: 'embed'` 块，`embedData` 形如：
 *
 * ```json
 * {
 *   "src": "qj-….pdf",                  // 资源名，也是 markdown 链接的目标
 *   "fileName": "论文标题.pdf",
 *   "fileSize": 123456,
 *   "fileType": "application/pdf",
 *   "previewType": "card"
 * }
 * ```
 *
 * 应用自己的 `doc2markdown` 把它渲染成 `[office](qj-….pdf)` ——
 * 链接文案用的是 **embedType**（`office` / `drawio`），不是原始文件名。
 */
export interface AttachmentRef {
  /** doc 里的资源名（markdown 链接的目标） */
  name: string;
  /** 上传时的原始文件名，落盘与链接文案都用它 */
  fileName: string;
  /** 应用给出的 embedType（`office` / `drawio` 等），用来识别通用链接文案 */
  embedType: string;
}

/**
 * 从 doc 里收集附件。
 *
 * ⚠️ 只收**非图片**的 embed：
 * - `image` 类型的 embed 由 `doc2markdown` 渲染成 `![…](…)`，走图片那条路（`images/`）；
 * - `webpage` 的 `src` 是 `http(s):` 外链，会被外部地址判断挡掉；
 * - `math` 的 `src` 是 `data:`，同样挡掉。
 *
 * 其余（`office` 上传的文档、`drawio` 图 等）都当附件处理。
 */
function collectAttachments(doc: unknown): AttachmentRef[] {
  const found: AttachmentRef[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    if (record.type === 'embed') {
      const embedType = typeof record.embedType === 'string' ? record.embedType : '';
      const data = record.embedData as Record<string, unknown> | undefined;
      const src = typeof data?.src === 'string' ? data.src : '';
      if (src && embedType !== 'image' && !EXTERNAL_URL.test(src) && !seen.has(src)) {
        seen.add(src);
        const fileName = typeof data?.fileName === 'string' && data.fileName ? data.fileName : src;
        found.push({ name: src, fileName, embedType });
      }
    }

    for (const value of Object.values(record)) visit(value);
  };

  visit(doc);
  return found;
}

/**
 * 把 markdown 里指向附件的链接改写成 `attachments/<文件名>`，并把附件记进下载清单。
 *
 * 应用把每个 embed 都渲染成 `[<embedType>](<资源名>)`，例如 `[office](qj-….pdf)`。
 * 这里：
 * - 链接目标是本笔记的附件资源名 → 改成 `attachments/<文件名>`；
 * - 链接文案正好等于 embedType（应用生成的通用文案）→ 换成真实文件名，
 *   用户自己写的文案（含空文案）保持原样。
 *
 * `rewrite: false`（用户关掉了“下载附件”）时**不做任何改写** ——
 * 否则会留下指向不存在文件的 `attachments/…` 引用。这和 `rewriteImageTargets` 的策略一致。
 */
function rewriteAttachments(
  markdown: string,
  options: { rewrite: boolean; namer: ResourceNamer; attachments: Map<string, AttachmentRef> },
): string {
  if (options.attachments.size === 0) return markdown;

  return replaceInlineLinks(markdown, (link) => {
    if (link.image) return undefined;

    const { target, rest } = linkTargetParts(link.raw);
    const attachment = options.attachments.get(target);
    if (!attachment) return undefined;
    if (!options.rewrite) return undefined;

    // 落盘用原始文件名（可读），链接里对文件名做百分号编码（空格 / `#` / `(` 等才不会破坏语法）
    const basename = options.namer.basename(attachment.name, 'attachments', {
      preferred: attachment.fileName,
    });
    const href = `attachments/${encodeAttachmentName(basename)}`;
    const label =
      link.label === '' || link.label.toLowerCase() === attachment.embedType
        ? attachment.fileName
        : link.label;
    return `[${label}](${href}${rest})`;
  });
}

/**
 * 附件名的 URL 编码。
 *
 * `encodeURIComponent` 会保留 `(` `)` `'` —— 它们在 markdown 链接目标里要么破坏括号配对、
 * 要么在部分渲染器里需要转义，这里一并编码。文件名本身（zip 里的名字）不做编码。
 */
function encodeAttachmentName(name: string): string {
  return encodeURIComponent(name).replace(/[()']/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/* ------------------------------------------------------------------ */
/* 附件（普通笔记：正文里的 wiz:// 引用 + 本地 attachments 表）        */
/* ------------------------------------------------------------------ */

/** 正文里引用附件的写法（实测 2026-10-04）：`<a href="wiz://open_attachment?guid=…">` */
const ATTACHMENT_LINK = /wiz:\/\/open_attachment\?guid=([0-9a-fA-F-]{36})/g;

/** 附件的**预览图**资源名：`index_files/{attGuid}_image.png` */
const ATTACHMENT_PREVIEW = /(?:^|\/)index_files\/([0-9a-fA-F-]{36})[._-]/;

interface PlannedAttachment {
  /** 小写 attGuid：用来认出 markdown 里那张对应它的预览图、以及 HTML 里的 `wiz://` 链接 */
  key: string;
  /** 产物内的相对路径 `attachments/<百分号编码后的文件名>`，HTML 改写 href 时用它 */
  href: string;
  /** 生成好的 markdown 链接 `[文件名](attachments/…)` */
  link: string;
}

interface NoteAttachmentPlan {
  /** 小写 attGuid → 计划（给 markdown 改写用） */
  byGuid: Map<string, PlannedAttachment>;
  /** 全部附件（正文引用的 + 表里游离的），文末章节按这个顺序列 */
  all: PlannedAttachment[];
}

/**
 * 规划普通笔记的附件导出。
 *
 * 信息来源必须**合起来看**：
 * - 清单（本地 `attachments` 表；看着不完整时联网补 `/ks/note/attachments/…`）→ “有哪些附件”，
 *   也只有它带**原始文件名**；
 * - 正文 HTML 的 `wiz://open_attachment?guid=…` → “正文哪里引用了它”。
 *
 * 结果服务两条产物路径，差别只在“拿到之后怎么用”：
 * - markdown（§4.5）：把正文里那张预览图换成附件链接；
 * - 只导 HTML 的那几类（§4.6）：把正文里**已经存在**的附件链接指向 `attachments/`。
 *
 * 实测（2026-10-04，xapp 0.1.107）两个坑：
 * 1. `html2Doc → doc2markdown` **会把整个 `<a wiz://…>` 丢掉**，只留里面那张预览图
 *    （`![](index_files/{attGuid}_image.png)`）—— 所以今天导出的其实是服务端重编码过的
 *    预览图，原始文件和文件名全丢（实测预览图经过重编码，字节数与原始文件并不一致）。
 * 2. 附件**可能完全不出现在正文里**（老式“附件面板”式笔记，实测有笔记挂了多个附件、
 *    正文 HTML 里却一个字都没有）。这类只能靠清单发现，没有位置可言 ——
 *    markdown 产物把它们列到文末的“附件”章节，HTML 产物只落盘、不在页面里露面。
 * 3. 那张表**可能根本没有这篇笔记的行**（附件元数据没同步下来）。这不是死路：清单能联网从
 *    `/ks/note/attachments/…` 补回来；正文引用到的即使清单也拿不到，还能按 attGuid 单独问
 *    `/ks/attachment/info/…` 要文件名。只有**联网也拿不到清单**时才会少导出 —— 那时由调用方
 *    记进 `problems`，不能静默漏掉。
 */
async function planNoteAttachments(
  note: NoteRef,
  html: string,
  namer: ResourceNamer,
  allowNetwork: boolean,
  signal?: AbortSignal,
): Promise<NoteAttachmentPlan> {
  // 清单：本地索引优先，看着不完整时按需联网补一次（见 app-bridge 的 listNoteAttachments）
  const rows = await listNoteAttachments(
    note,
    {
      allowNetwork,
      declared: declaredAttachmentCount(note),
    },
    signal,
  );
  const tableByKey = new Map(rows.map((row) => [row.attGuid.toLowerCase(), row]));

  const byGuid = new Map<string, PlannedAttachment>();
  const all: PlannedAttachment[] = [];

  const plan = (attGuid: string, name: string): void => {
    const key = attGuid.toLowerCase();
    if (byGuid.has(key)) return;
    const basename = namer.basename(attGuid, 'attachments', { preferred: name, channel: 'attachment' });
    // 编码规则必须和协作笔记那条路一致（encodeAttachmentName）：文件名来自用户上传，
    // 里面的 `(` `)` `'` 会让 markdown 链接语法出错
    const href = `attachments/${encodeAttachmentName(basename)}`;
    const item: PlannedAttachment = { key, href, link: `[${name}](${href})` };
    byGuid.set(key, item);
    all.push(item);
  };

  // 1) 正文引用到的，顺序按 HTML 里出现的先后
  const referenced = new Set<string>();
  const referencedGuids: string[] = [];
  for (const match of html.matchAll(ATTACHMENT_LINK)) {
    const key = match[1].toLowerCase();
    if (referenced.has(key)) continue;
    referenced.add(key);
    referencedGuids.push(match[1]);
  }

  for (const guid of referencedGuids) {
    const row = tableByKey.get(guid.toLowerCase());
    if (row) {
      plan(row.attGuid, row.name);
      continue;
    }
    // 本地表里没有这一行（元数据没同步下来）：问一次服务端要原始文件名。
    // 拿不到就只能用 attGuid 兜底 —— 那样落盘的文件连扩展名都没有，所以值得多花一次请求。
    const name = allowNetwork ? await fetchNoteAttachmentName(note, guid, signal) : undefined;
    if (!name) log.debug('拿不到附件原始文件名，用 guid 兜底', guid);
    plan(guid, name ?? guid);
  }

  // 2) 表里有、正文没引用的（老式附件面板）
  for (const row of rows) {
    if (!referenced.has(row.attGuid.toLowerCase())) plan(row.attGuid, row.name);
  }

  log.debug('笔记附件', { docGuid: note.docGuid, referenced: referenced.size, total: all.length });
  return { byGuid, all };
}

/**
 * 把正文里附件的那张**预览图**换成附件链接。
 *
 * 必须在 `rewriteImageTargets` **之前**做：换掉之后那张 `index_files/{guid}_image.png`
 * 就不再是图片引用，也就不会被当成要下载的图片（预览图 ≠ 附件，别把它写进 `images/`）。
 */
function rewriteNoteAttachments(
  markdown: string,
  byGuid: Map<string, PlannedAttachment>,
): { markdown: string; used: Set<string> } {
  const used = new Set<string>();
  if (byGuid.size === 0) return { markdown, used };

  const next = replaceInlineLinks(markdown, (link) => {
    if (!link.image) return undefined;

    const hit = ATTACHMENT_PREVIEW.exec(link.raw.trim());
    if (!hit) return undefined;
    const item = byGuid.get(hit[1].toLowerCase());
    if (!item) return undefined;
    used.add(item.key);
    return item.link;
  });

  return { markdown: next, used };
}

/**
 * 笔记对象自带的附件数（应用同步下来的）。
 *
 * ⚠️ 只用来**提醒**“可能有附件没导出来”，不做断言：它是上次同步时的快照，
 * 之后服务端删掉附件它也不会变，所以不能拿它当“应该有这么多”的事实。
 */
function declaredAttachmentCount(note: NoteRef): number {
  const value = note.attachmentCount;
  return typeof value === 'number' && value > 0 ? value : 0;
}

/**
 * 附件少导出的提示（markdown 与 HTML 两条产物路径共用）。
 *
 * 正常情况下清单来自本地表或服务端，数量应该对得上；对不上只有一个原因：
 * 两边都没拿到完整清单。这时必须让用户看见，不能只显示“附件 0 个”。
 */
function attachmentProblemList(note: NoteRef, plan: NoteAttachmentPlan | undefined): string[] {
  if (!plan) return [];
  const declared = declaredAttachmentCount(note);
  const planned = plan.all.length;
  if (declared <= planned) return [];
  return [
    planned === 0
      ? `这篇笔记有 ${declared} 个附件，但没能拿到它们的清单（本地没有、联网也没取到），一个都没导出`
      : `这篇笔记有 ${declared} 个附件，只找到 ${planned} 个的清单，另外 ${declared - planned} 个没能导出`,
  ];
}

/** 文末的“附件”章节：正文里没引用到的附件只能这样让用户看见 */
function renderAttachmentSection(links: string[]): string {
  if (links.length === 0) return '';
  return ['---', '', `# 附件（${links.length} 个）`, '', ...links.map((link) => `- ${link}`), ''].join(
    '\n',
  );
}

/** HTML 里正文引用的附件：外层 `<a href="wiz://open_attachment?guid=…">` 包着一张预览图 */
const HTML_ATTACHMENT_ANCHOR =
  /<a\b[^>]*\bhref\s*=\s*(["'])wiz:\/\/open_attachment\?guid=([0-9a-fA-F-]{36})\1[^>]*>/gi;

/**
 * HTML 产物里的附件：把**正文里已经存在的**附件链接指向 `attachments/<文件名>`。
 *
 * 为什么必须改：`wiz://` 是宿主（桌面端壳）自己的协议，导出的静态文件里点不开 ——
 * 而且那个地址只带附件 guid、没有 kb/doc 上下文，脱离宿主也定位不到附件。
 * 改成相对路径后，双击 HTML 就能点开 zip 里 `attachments/` 下那份原始文件。
 *
 * 两条边界：
 * - **只改这一个 href，不新增任何原文没有的段落**（HTML 是保真备份，页面结构必须和编辑器里一致）；
 *   正文里没引用的附件就只落进 `attachments/`，不在页面里露面；
 * - 里层那张预览图不动（仍由 `localizeHtmlResources()` 收进 `images/`），
 *   所以页面观感与编辑器里一致，只是"点击"从宿主打开变成了打开本地文件。
 */
function rewriteHtmlAttachments(html: string, byGuid: Map<string, PlannedAttachment>): string {
  if (byGuid.size === 0) return html;

  return html.replace(HTML_ATTACHMENT_ANCHOR, (whole, quote: string, guid: string) => {
    const item = byGuid.get(guid.toLowerCase());
    if (!item) return whole;
    // 只替换 href 那一段，其余属性（class / style / target…）原样保留
    return whole.replace(
      /href\s*=\s*(["'])wiz:\/\/open_attachment\?guid=[0-9a-fA-F-]{36}\1/i,
      `href=${quote}${item.href}${quote}`,
    );
  });
}

/* ------------------------------------------------------------------ */
/* HTML 里的资源引用本地化                                             */
/* ------------------------------------------------------------------ */

/** `<img src=…>`；只看开标签，避免把后面的内容吞进来 */
const HTML_IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
/** `<img srcset=…>`：逗号分隔，每项是“地址 + 可选描述符” */
const HTML_IMG_SRCSET = /(<img\b[^>]*?\bsrcset\s*=\s*)(["'])([^"']+)\2/gi;
/** CSS 里的 `url(…)`（含内联 style 与 `<style>` 块） */
const CSS_URL = /(url\(\s*)(["']?)([^"')]+)\2(\s*\))/gi;

/**
 * 内联 style 里的引号常常被转义成 HTML 实体，例如
 * `style="background-image:url(&quot;index_files/a.jpg&quot;)"`。
 * 这层实体引号会被正则当成地址的一部分，先剥掉再解析、改写后原样装回去。
 */
const ENTITY_QUOTE_LEAD = /^(&quot;|&#34;|&apos;|&#39;)/i;
const ENTITY_QUOTE_TAIL = /(&quot;|&#34;|&apos;|&#39;)$/i;

/**
 * 从 HTML 里的地址反推**资源名**，对齐 doc 里 `buildResourceUrl` 给出的那种名字，
 * 这样它和 markdown 那条路能落到同一个文件名上。
 *
 * - `http(s):` / `data:` / `blob:` / `file:` → 外链，返回 undefined（保持原样）
 * - `…/index_files/x.png` → `index_files/x.png`
 * - `…/resources/x.png` → `x.png`（协作笔记的裸资源名）
 * - 相对地址（应用渲染出来的就是这种）→ 整段就是资源名
 * - 其它绝对 / 协议相对地址（`/…`、`//wiznote-desktop/…`）→ 退化成最后一段
 */
function resourceNameFromUrl(url: string): string | undefined {
  const clean = url.split('#')[0].split('?')[0].trim();
  if (!clean) return undefined;
  if (EXTERNAL_URL.test(clean)) return undefined;

  const indexFiles = clean.match(/\/?(index_files\/[^/]+)$/i);
  if (indexFiles) return indexFiles[1];

  const resources = clean.match(/\/resources\/([^/]+)$/i);
  if (resources) return resources[1];

  if (!/^(\/\/|\/)/.test(clean)) return clean;
  return clean.split('/').filter(Boolean).pop() ?? undefined;
}

/** `<link …>` 标签 */
const HTML_LINK_TAG = /<link\b[^>]*>/gi;
/** 标签上的 `href` */
const HTML_LINK_HREF = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** 标签上的 `rel` */
const HTML_LINK_REL = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** 取出属性值（属性可能用双引号 / 单引号 / 完全不加引号） */
function attrValue(match: RegExpMatchArray | null): string {
  return match ? match[2] ?? match[3] ?? match[4] ?? '' : '';
}

/** 资源名所在的目录（CSS 里的相对 `url()` 以它为准） */
function dirOf(name: string): string {
  const index = name.lastIndexOf('/');
  return index > 0 ? name.slice(0, index) : '';
}

/** 把 `base/index_files` + `../x.png` 这类相对地址规范化成资源名 */
function normalizeResourceName(base: string, relative: string): string {
  const segments = `${base ? `${base}/` : ''}${relative}`.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * 把指向笔记本地资源的 `<link rel="stylesheet">` 内联成 `<style>`。
 *
 * 导出的目录里没有 `index_files/`，外链样式表原样留着只会让控制台报
 * `ERR_FILE_NOT_FOUND`；而它承载的往往是这类“保存的网页”笔记的**全部站点样式**。
 * 内联之后单文件就能正确显示，也不再依赖任何外部文件。
 *
 * - 取不到就**把它删掉**（留着只会稳定报错），并记一条 problem。
 * - 真·外链 CSS（`http(s):`）保持原样，联网时仍然有效。
 * - CSS 里的相对 `url()` 以**样式表自己的目录**为基准（`index_files/share.css`
 *   里的 `url(bg.png)` 指的是 `index_files/bg.png`），所以要先补上目录再交给统一下载清单。
 */
async function inlineStylesheets(
  html: string,
  options: {
    note: NoteRef;
    mapUrl: (raw: string, onlyImages?: boolean, base?: string) => string;
    problems: string[];
    signal?: AbortSignal;
  },
): Promise<string> {
  const targets = [...html.matchAll(HTML_LINK_TAG)].filter((match) =>
    /(^|[^a-z-])stylesheet([^a-z-]|$)/i.test(attrValue(match[0].match(HTML_LINK_REL))),
  );
  if (targets.length === 0) return html;

  /** key 是 match 的**序号**（对应 `targets`），不是标签文本 —— 见下面重建那段的说明 */
  const replacements = new Map<number, string>();
  for (const [index, target] of targets.entries()) {
    const tag = target[0];
    const href = attrValue(tag.match(HTML_LINK_HREF));
    const name = href ? resourceNameFromUrl(href) : undefined;
    // 外链 CSS / 没有 href：保持原样
    if (!name) continue;

    const css = await fetchResourceText(options.note, name, options.signal);
    if (css === undefined) {
      options.problems.push(`外链样式表 ${name} 没取到，已从 HTML 里移除`);
      replacements.set(index, '');
      continue;
    }

    const dir = dirOf(name);
    const rewritten = css.replace(CSS_URL, (_w, head: string, quote: string, url: string, tail: string) => {
      return `${head}${quote}${options.mapUrl(url, true, dir)}${quote}${tail}`;
    });
    replacements.set(index, `<style data-wz-source="${name}">\n${rewritten}\n</style>`);
  }

  /*
   * 替换**一趟做完**，不要 `for (const [tag, text] of replacements) html = html.replace(tag, text)`
   * —— 那样每个外链样式表都要把整篇 HTML 扫一遍并复制一份（N 个样式表 = N 遍全篇），
   * 剪藏类笔记动辄几个 MB × 十几个样式表，全在主线程上。这里按 match 的**位置**一次重建。
   *
   * 用位置而不是标签文本当 key，还顺带修掉了旧写法的两个隐患：同一段 `<link>` 出现两次时
   * `replace(tag, …)` 只会改第一处；而 Map 以标签文本为 key 时，两处还会互相覆盖。
   */
  const edits = targets
    .map((target, index) => ({
      start: target.index ?? 0,
      end: (target.index ?? 0) + target[0].length,
      text: replacements.get(index),
    }))
    .filter((edit): edit is { start: number; end: number; text: string } => edit.text !== undefined);
  if (edits.length === 0) return html;

  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    pieces.push(html.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(html.slice(cursor));
  return pieces.join('');
}

/**
 * 把 HTML 里指向笔记本地资源的引用改写成 `images/<文件名>`，并记进下载清单。
 *
 * 为什么必须改写：导出目录里只有 `images/`，而 HTML 里保留的是应用的原始地址 ——
 * 相对地址（`index_files/x.svg`）在 `file://` 下本来还能显示，但协议相对
 * （`//wiznote-desktop/…`）会变成 `file://wiznote-desktop/…`、根相对（`/ks/…`）
 * 会解析到文件系统根，**必然坏掉**。统一改成相对 `images/` 后，html 与 md 共用同一份图，
 * 双击就能看。
 *
 * 顺带把外链样式表内联进来（见 `inlineStylesheets`）。
 *
 * `rewrite: false`（用户关掉了“把图片下载到 images/”）时不做任何改写 ——
 * 否则会留下指向不存在文件的引用。
 */
async function localizeHtmlResources(
  html: string,
  options: {
    rewrite: boolean;
    namer: ResourceNamer;
    note: NoteRef;
    signal?: AbortSignal;
    /** 篇内的让出器（见 renderNote 与 utils/yield.ts）：下面几趟全篇替换之间歇一帧 */
    breathe?: () => Promise<void>;
  },
): Promise<{ html: string; imageRefs: number; problems: string[] }> {
  if (!options.rewrite) return { html, imageRefs: 0, problems: [] };

  let imageRefs = 0;
  const problems: string[] = [];
  /**
   * `onlyImages` 用于 CSS `url()`：那里的地址还可能是字体 / 脚本之类，
   * 不去动它们，免得把 note 的样式资源也当成待下载图片（下载失败会变成噪音）。
   * `base` 只在处理样式表内部时给（相对地址以样式表所在目录为基准）。
   */
  const mapUrl = (raw: string, onlyImages = false, base = ''): string => {
    const lead = raw.match(ENTITY_QUOTE_LEAD)?.[0] ?? '';
    const rest = raw.slice(lead.length);
    const tail = rest.match(ENTITY_QUOTE_TAIL)?.[0] ?? '';
    let url = rest.slice(0, rest.length - tail.length).trim();

    // 已经是本地路径就不再处理，也避免内联样式表被二次计数
    if (/^images\//.test(url)) return raw;
    if (base && url && !EXTERNAL_URL.test(url) && !/^[#?]/.test(url) && !/^(\/\/|\/)/.test(url)) {
      url = normalizeResourceName(base, url);
    }

    const name = resourceNameFromUrl(url);
    if (!name) return raw;
    if (onlyImages && !IMAGE_EXT.test(name)) return raw;

    imageRefs += 1;
    return `${lead}${options.namer.path(name, 'images', { referencedBy: 'html' })}${tail}`;
  };

  // 先内联样式表：它内部的 url() 引用的图片也要进下载清单
  const withStyles = await inlineStylesheets(html, {
    note: options.note,
    mapUrl,
    problems,
    signal: options.signal,
  });

  // 三趟都是**整篇**替换（各自扫一遍、复制一份），所以每趟之间歇一帧：
  // 剪藏类笔记的 HTML 动辄几个 MB，串在一起就是主线程上的一大段
  await options.breathe?.();
  const withSrc = withStyles.replace(
    HTML_IMG_SRC,
    (_w, head: string, quote: string, url: string) => `${head}${quote}${mapUrl(url)}${quote}`,
  );
  await options.breathe?.();
  const withSrcset = withSrc.replace(HTML_IMG_SRCSET, (_w, head: string, quote: string, value: string) => {
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const [url, ...descriptors] = trimmed.split(/\s+/);
        return [mapUrl(url), ...descriptors].join(' ');
      })
      .join(', ');
    return `${head}${quote}${rewritten}${quote}`;
  });
  await options.breathe?.();
  const next = withSrcset.replace(CSS_URL, (_w, head: string, quote: string, url: string, tail: string) => {
    return `${head}${quote}${mapUrl(url, true)}${quote}${tail}`;
  });

  return { html: next, imageRefs, problems };
}

/**
 * 剥掉应用注入的“编辑器脚手架”，让导出的 HTML 能离线打开。
 *
 * 笔记 HTML 里夹着一批应用自己加的元素，用 `wiz_style="unsave"` /
 * `name="wiz_unsave_style"` 标记（应用的保存逻辑本来就会跳过它们，是官方约定）：
 *
 * - `<script src="/wizDocument/index.js">` 之类 —— 绝对路径，离线打开必然 404；
 * - `<style id="note-loading" name="wiz_unsave_style">body { opacity: 0 }</style>`
 *   —— **这条最致命**：正文其实都在文件里，但整个 body 是透明的，
 *   要靠编辑器 JS 加载后才恢复。离线时 JS 404，打开就是一片空白。
 *
 * 实测（2026-10-03，大纲笔记）导出文件里共有 3 个 `wiz_style="unsave"`
 * 与 3 个 `wiz_unsave_style`，剥掉后即可正常打开。
 */
function sanitizeNoteHtml(html: string): string {
  const UNSAVE_ATTR = /\bwiz_style\s*=\s*["']?unsave["']?/i;
  const UNSAVE_NAME = /\bname\s*=\s*["']?wiz_unsave_style["']?/i;

  // 只看开标签是否带标记。script / style 不能互相嵌套，所以这个匹配是安全的。
  const shouldDrop = (block: string): boolean => {
    const openTag = block.slice(0, block.indexOf('>') + 1);
    return UNSAVE_ATTR.test(openTag) || UNSAVE_NAME.test(openTag);
  };

  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block: string) => (shouldDrop(block) ? '' : block))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block: string) => (shouldDrop(block) ? '' : block));
}

/* ------------------------------------------------------------------ */
/* 手写批注层（覆盖式）                                                */
/* ------------------------------------------------------------------ */

// wiz_marker 是自定义元素、不会嵌套，所以配到闭合标签是可靠的
const PAINTER_MARKER = /<wiz_marker\b[^>]*>[\s\S]*?<\/wiz_marker>/gi;
const PAINTER_SVG = /<svg\b[^>]*\bclass="[^"]*\bwiz-svg-base\b[^"]*"[^>]*>[\s\S]*?<\/svg>/i;

/**
 * 把内联的批注 SVG 整理成能独立打开的 `.svg` 文件。
 *
 * 三个必须处理的地方：
 *
 * 1. HTML 里属性名是小写 `viewbox`，而独立 `.svg` 是 XML、**区分大小写**，
 *    必须是 `viewBox`，否则尺寸解析不出来；
 * 2. 去掉 `class` / `id` —— 它们原本依赖页面样式，独立成文件后没意义，
 *    `id` 还可能和别的文件撞；
 * 3. 补一个白底矩形：原本是叠在白纸上的透明层，加白底后在深色主题里也能看清。
 */
function toStandaloneSvg(inline: string): string {
  let svg = inline
    .replace(/\sclass="[^"]*"/i, '')
    .replace(/\bid="[^"]*"/i, '')
    .replace(/\bviewbox=/i, 'viewBox=');

  if (!/\bxmlns=/.test(svg)) {
    svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const viewBox = svg.match(/\bviewBox="([^"]+)"/)?.[1].split(/[\s,]+/);
  const width = viewBox?.length === 4 ? viewBox[2] : '100%';
  const height = viewBox?.length === 4 ? viewBox[3] : '100%';
  svg = svg.replace(
    /(<svg[^>]*>)/i,
    `$1<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`;
}

/**
 * 从笔记 HTML 里抠出手写批注层。
 *
 * 批注在 HTML 里的形态（`wiz_marker` 不是内容模型里的块类型，
 * `html2Doc` 会**整层丢掉**，所以必须在 HTML 这一层先捞出来）：
 *
 * ```html
 * <wiz_marker id="wiz-painter-root">
 *   <div id="sketchpad"><div class="wiz-svg-page"><div class="wiz-svg-container">
 *     <svg class="wiz-svg-base" viewbox="0 0 393 361">
 *       <path wiz-type="curve" wiz-data="…" d="M…"/>
 * ```
 *
 * 样式表里它是 `position:absolute; z-index:1000` 的一层透明覆盖层，
 * 笔画坐标**相对笔记版面**（viewBox 与正文宽度一致），所以脱离原版面就没有意义。
 * 这决定了它只能原样导成图片 + 加说明，没法真正"转"成 markdown。
 */
function extractAnnotations(html: string): string[] {
  const svgs: string[] = [];
  for (const marker of html.match(PAINTER_MARKER) ?? []) {
    const svg = marker.match(PAINTER_SVG)?.[0];
    if (svg) svgs.push(toStandaloneSvg(svg));
  }
  return svgs;
}

/**
 * 在 markdown 末尾追加批注章节。
 *
 * 只做“不丢数据”的降级：批注层单独导出成图片挂在这里，
 * 但必须说清楚它原本是叠在正文上的 —— 否则读者会把它当成一张独立的插图。
 */
function appendAnnotationSection(markdown: string, names: string[]): string {
  const items = names.map((name, index) => `![手写批注 ${index + 1}](${name})`).join('\n\n');
  return [
    markdown.trimEnd(),
    '',
    '---',
    '',
    `# 手写批注（${names.length} 层）`,
    '',
    '> ⚠️ 原笔记在正文版面上叠加了**手写批注层**（覆盖式绘制）。',
    '> Markdown 没有版面概念，承载不了这种批注，所以下面按原始比例单独导出成图片。',
    '> 批注原本压在哪些文字上，需要对照原笔记查看。',
    '',
    items,
    '',
  ].join('\n');
}

/**
 * HTML 接口拿回来的可能是“当前客户端版本较低，无法编辑协作笔记”的占位页。
 * 这种页面转换出来是一份看起来正常的假文档，必须拦掉，否则会产出误导性的导出结果。
 */
function isUnsupportedPlaceholder(html: string): boolean {
  return html.includes('无法编辑协作笔记') || /too low to edit collaborative notes/i.test(html);
}

type HtmlResult = { ok: true; html: string } | { ok: false; detail: string };

/**
 * 本地存在性检查 + 取 HTML。
 * `allowNetworkFetch=false` 时不会去拉本地没有的笔记，并且会把跳过原因一并带出来。
 * `signal` 中止时这次请求直接作废，返回的“取不到”由调用方按中止处理（见 task.ts）。
 */
async function fetchNoteHtml(note: NoteRef, options: ExportOptions, signal?: AbortSignal): Promise<HtmlResult> {
  if (!options.allowNetworkFetch) {
    const local = await isNoteStoredLocally(note.kbGuid, note.docGuid);
    if (local === 'no' || local === 'unknown') {
      log.debug('笔记不在本地，跳过', note.docGuid, local);
      return { ok: false, detail: '本地没有这篇笔记的内容，已跳过（可开启联网补全）' };
    }
  }

  const html = await fetchText(noteViewPath(note.kbGuid, note.docGuid, 'index.html'), signal);
  if (!html) {
    // 本地“虚拟域”数据服务没就绪时，这类请求会集体失败，表现和“真的没有正文”一模一样。
    // 差别出来，否则用户会以为笔记没同步，其实是刷新一次页面就好。
    const hint = isLocalDataServiceReady() ? '' : '；本地离线服务没接管页面，刷新一次再试';
    return { ok: false, detail: `取不到这篇笔记的正文内容（联网补全也没成功）${hint}` };
  }
  if (isUnsupportedPlaceholder(html)) {
    log.warn('接口返回的是“不支持协作笔记”的占位页，判为无内容', note.docGuid);
    return {
      ok: false,
      detail: '服务端只返回了“客户端版本过低”的占位页，拿不到正文；请先在应用里打开这篇协作笔记',
    };
  }
  return { ok: true, html };
}

/**
 * 把 markdown 与批注层收口成最终产物。
 *
 * 批注在“不下载图片”时不追加章节（免得留下指向不存在文件的引用），
 * 但**计数照旧上报** —— 结果区仍会提示这篇笔记有批注没导出来。
 */
/**
 * 元数据用的标签原文（`guid1*guid2`）。
 *
 * 优先用笔记对象上的；**从列表右键导出**那条路拿到的 DTO 上 `tags` 实测是空串
 * （同一篇的本地 `docs` 行里却有两个 guid），这时回落到 `docs` 行 —— 仍然零网络，
 * 只是一次 IndexedDB 读。不兜底的话标签会**静默消失**：front matter 里连 `tags` 键都没有。
 */
async function noteTagText(note: NoteRef): Promise<string | undefined> {
  const onObject = typeof note.tags === 'string' ? note.tags.trim() : '';
  return onObject || (await readNoteTags(note));
}

/**
 * 元数据落盘。
 *
 * - YAML 模式 + markdown → 写成正文开头的 front matter；
 * - JSON 模式 → 落成同名 `.meta.json`；
 * - **HTML 一律落成 json** —— YAML front matter 是 markdown 的专有约定，
 *   HTML 没地方放（硬塞只能改成注释块或 `<meta>`，那是另一套字段命名），
 *   所以这里统一降级，保持“一套字段结构、两种容器”。
 */
function applyMetadata(params: {
  fileName: string;
  markdown?: string;
  metadata?: NoteMetadata;
  format: MetadataFormat;
  extractedFiles: ExtractedFile[];
}): { markdown?: string; sidecar: boolean } {
  const { metadata } = params;
  if (!metadata) return { markdown: params.markdown, sidecar: false };

  const empty = metadata.fields.length === 0 && metadata.raw.length === 0;
  if (empty) return { markdown: params.markdown, sidecar: false };

  // 有 markdown 才有 front matter 可写；HTML 只能走 json
  const asJson = params.format === 'json' || params.markdown === undefined;

  if (!asJson) {
    const frontMatter = renderFrontMatter(metadata);
    if (!frontMatter) return { markdown: params.markdown, sidecar: false };
    return { markdown: `${frontMatter}${params.markdown ?? ''}`, sidecar: false };
  }

  params.extractedFiles.push({
    path: `${params.fileName.replace(/\.[^.]+$/, '')}.meta.json`,
    data: new TextEncoder().encode(
      renderMetadataJson(metadata, { file: params.fileName, exportedAt: nowIso() }),
    ),
  });
  return { markdown: params.markdown, sidecar: true };
}

function buildMarkdownResult(params: {
  baseName: string;
  /** 每篇笔记的资源命名器：批注图层要借它避让真实图片（见 ResourceNamer.claim） */
  namer: ResourceNamer;
  noteType: NoteType;
  noteTypeLabel: string;
  markdown: string;
  resources: ResourceRef[];
  imageRefs: number;
  /** 笔记里引用的附件数量（落盘到 `attachments/`） */
  attachmentRefs: number;
  annotationSvgs: string[];
  includeImages: boolean;
  metadata?: NoteMetadata;
  metadataFormat: MetadataFormat;
  /** “同时导出 HTML”时，走有损路径的笔记留下的原件（已 sanitize） */
  sourceHtml?: string;
  /** 写进文末“评论”章节的评论条数 */
  comments?: number;
  /** 取评论失败的原因 */
  commentsError?: string;
  /** 其他需要让用户知道的问题（如外链样式表取不到） */
  problems?: string[];
}): RenderOutcome {
  const fileName = `${params.baseName}.md`;
  const extractedFiles: ExtractedFile[] = [];
  let markdown = params.markdown;

  // HTML 只对有损转换有意义：md 是从 HTML 反推出来的，HTML 是保真备份
  let htmlSidecar = false;
  if (params.sourceHtml) {
    extractedFiles.push({
      path: `${params.baseName}.html`,
      data: new TextEncoder().encode(params.sourceHtml),
    });
    htmlSidecar = true;
  }

  if (params.annotationSvgs.length > 0 && params.includeImages) {
    // 批注图层与真实图片共用同一个分配器：图片先占位，撞名就加 ` (2)`。
    // 链接必须用最终名字，否则会像“漏登记”那样指向一个不存在的文件。
    const names = params.annotationSvgs.map(
      (_, index) => `images/${params.namer.claim(`annotation-${index + 1}.svg`, 'images')}`,
    );
    const encoder = new TextEncoder();
    names.forEach((path, index) => {
      extractedFiles.push({ path, data: encoder.encode(params.annotationSvgs[index]) });
    });
    markdown = appendAnnotationSection(markdown, names);
  }

  // front matter 要在最前面，所以放在批注章节追加之后
  const applied = applyMetadata({
    fileName,
    markdown,
    metadata: params.metadata,
    format: params.metadataFormat,
    extractedFiles,
  });

  return {
    ok: true,
    data: {
      fileName,
      noteType: params.noteType,
      noteTypeLabel: params.noteTypeLabel,
      markdown: applied.markdown,
      resources: params.resources,
      imageRefs: params.imageRefs,
      attachmentRefs: params.attachmentRefs,
      annotations: params.annotationSvgs.length,
      comments: params.comments ?? 0,
      commentsError: params.commentsError,
      problems: params.problems,
      extractedFiles,
      metadataSidecar: applied.sidecar,
      htmlSidecar,
    },
  };
}

/**
 * 取评论并渲染成文末章节。
 *
 * 两种笔记的评论来源完全不同（见 comments.ts），但产出的章节格式统一：
 * - 协作笔记：评论在本地 doc JSON 里，零请求；
 * - 其余笔记：走 `/ks/note/comments` 接口，每篇 1 次请求。
 *
 * 取不到时**不静默** —— 把原因带回去，由结果区提示。
 */
async function resolveCommentSection(
  note: NoteRef,
  noteType: NoteType,
  doc: unknown,
  signal?: AbortSignal,
): Promise<{ section: string; count: number; error?: string }> {
  if (noteType === 'Collaboration') {
    const comments = collectDocComments(doc);
    return { section: renderCommentSection(comments), count: comments.length };
  }

  const collected = await collectRemoteComments(note, signal);
  if (!collected.ok) return { section: '', count: 0, error: collected.detail };
  return { section: renderCommentSection(collected.comments), count: collected.comments.length };
}

/**
 * 把一篇笔记的**原始 HTML** 收口成产物（`.html` + 资源清单）。
 *
 * 两条路共用它：
 * - 不支持转 Markdown 的类型（手写 / 旧版公式）—— 它们的产物**本来就是** HTML；
 * - 普通笔记解析失败时的兜底（见 `renderNote` 里 `html2Doc` 那一段）—— 只有用户勾了
 *   “同时导出原始 HTML”才会走到这里；没勾时宁可跳过，也不产出用户没要的 HTML。
 *
 * 两者的差别只有 `problems`：兜底那一路要额外说明“为什么只剩 HTML”。
 */
async function buildHtmlOnlyResult(params: {
  note: NoteRef;
  options: ExportOptions;
  baseName: string;
  noteType: NoteType;
  noteTypeLabel: string;
  metadata?: NoteMetadata;
  resourceNamer: ResourceNamer;
  breathe: () => Promise<void>;
  signal?: AbortSignal;
  /** 取回来的正文 HTML（净化前） */
  html: string;
  /** 额外写进“问题”页的说明 */
  problems?: string[];
}): Promise<RenderOutcome> {
  const { note, options, baseName, noteType, noteTypeLabel, resourceNamer, breathe, signal } = params;
  const fileName = `${baseName}.html`;
  const extractedFiles: ExtractedFile[] = [];
  // HTML 装不下 YAML front matter，元数据一律降级成同名 .meta.json
  const applied = applyMetadata({
    fileName,
    metadata: params.metadata,
    format: options.metadataFormat,
    extractedFiles,
  });

  // 这类笔记的正文只能导出 HTML，评论区没地方挂 —— 有评论时**另起一个同名 .md**
  // 专门装评论（不产生空文件：没评论就不落盘）。
  let commentsCount = 0;
  let commentsError: string | undefined;
  if (options.keepComments) {
    const collected = await collectRemoteComments(note, signal);
    if (!collected.ok) {
      commentsError = collected.detail;
    } else if (collected.comments.length > 0) {
      commentsCount = collected.comments.length;
      extractedFiles.push({
        path: `${baseName}.md`,
        data: new TextEncoder().encode(renderCommentOnlyMarkdown(baseName, collected.comments)),
      });
    }
  }

  // 附件：清单、命名、计数与 markdown 那条路共用同一套；这里只做一件事 ——
  // 把正文里**已经存在**的 `wiz://open_attachment` 链接指向 `attachments/<文件名>`，
  // 不新增任何原文没有的段落（见 rewriteHtmlAttachments）。
  const htmlAttachmentPlan = options.includeAttachments
    ? await planNoteAttachments(note, params.html, resourceNamer, options.allowNetworkFetch, signal)
    : undefined;
  // sanitize 与附件改写各自都是整篇扫一遍，中间歇一帧（剪藏的 HTML 有几个 MB）
  const sanitizedHtml = sanitizeNoteHtml(params.html);
  await breathe();
  const attachedHtml = rewriteHtmlAttachments(sanitizedHtml, htmlAttachmentPlan?.byGuid ?? new Map());
  await breathe();

  // HTML 里的图片引用本地化：换成 `images/<文件名>` 并把资源记进下载清单，
  // 否则双击打开时引用的还是应用的原始地址（相对 / 协议相对 / 根相对），必然缺图。
  // 顺带把外链样式表内联进来，避免 `index_files/*.css` 稳定报 ERR_FILE_NOT_FOUND。
  const localized = await localizeHtmlResources(attachedHtml, {
    rewrite: options.includeImages,
    namer: resourceNamer,
    note,
    signal,
    breathe,
  });

  const resources = resourceNamer.list();
  const counts = resourceCounts(resources);
  return {
    ok: true,
    data: {
      fileName,
      noteType,
      noteTypeLabel,
      imageRefs: counts.imageRefs,
      attachmentRefs: counts.attachmentRefs,
      html: localized.html,
      resources,
      problems: [
        ...(params.problems ?? []),
        ...localized.problems,
        ...attachmentProblemList(note, htmlAttachmentPlan),
      ],
      // 导 HTML 是原样保留，批注层本来就在里面（wiz_marker + 内联 SVG），无需另存
      annotations: 0,
      comments: commentsCount,
      commentsError,
      commentsSidecar: commentsCount > 0,
      extractedFiles,
      metadataSidecar: applied.sidecar,
      // 产物本身就是 HTML，不重复产出
      htmlSidecar: false,
    },
  };
}

/**
 * 摘掉**没有任何单元格**的 `<table>`。
 *
 * 宿主的 `html2Doc` 遇到这种表会**整篇解析失败**（返回 `undefined`，实测 2026-10-07，xapp 0.1.107）：
 * `<table></table>`、`<table><tbody></tbody></table>`、`<table><tbody><tr></tr></tbody></table>`
 * 三种都复现，带 `<td>` 的正常。这类表按定义没有内容，摘掉是无损的 ——
 * 实测一篇保存网页（正文里正是一个没有单元格的空表，是它让整篇“解析不出来”）摘掉后可正常
 * 产出 markdown。
 *
 * 只在**第一次解析失败后**才走它（见 `renderNote`）：绝大多数笔记不需要，
 * 也免得每次都为一次“重新序列化整篇 HTML”付代价。
 */
function stripCellLessTables(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = [...doc.querySelectorAll('table')].filter((table) => !table.querySelector('td, th'));
    if (tables.length === 0) return html;
    for (const table of tables) table.remove();
    return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
  } catch (error) {
    log.warn('摘除无单元格的 table 失败，按原文重试', error);
    return html;
  }
}

/**
 * 单篇笔记 → markdown（或 HTML 兜底） + 资源清单。
 *
 * 所有能转 Markdown 的类型最终都收口到 LiveEditor.doc2markdown，
 * 保证公式/图片/表格/代码块的处理规则与应用自身完全一致。
 *
 * `signal` 是本次导出的取消通道（见 `utils/abort.ts`）：它中止时这篇可以直接作废
 * ——要么抛 `AbortError`（不可中止的等待用 `raceAbort()`），要么返回一个“取不到”的结果。
 * **不要在这里把中止翻译成失败**：调用方认得出这两种形态，会整篇按“未处理”收编。
 *
 * 篇内是**一串同步 CPU 活**（宿主转换 + 一遍遍全篇 regex + 编码），中间靠 `breathe()`
 * 让出主线程（`utils/yield.ts`，按时间预算，小笔记一次都不让）。所以这里刻意保持
 * “一步一让”的写法：**别把相邻几步合并成一行**——合并就把让出点吃掉了，
 * 一份几十 MB 的剪藏又会在主线程上连成一大段。
 */
export async function renderNote(
  note: NoteRef,
  options: ExportOptions,
  signal?: AbortSignal,
): Promise<RenderOutcome> {
  const liveEditor = getLiveEditor();
  const noteType = getNoteType(note);
  const noteTypeLabel = NOTE_TYPE_LABEL[noteType];
  // 先剥掉标题里的 .md 后缀，再走标准两道工序：对齐上游清洗 → 落盘加固（见 naming.ts）
  const baseName = toDiskName(extractNoteTitle(note.title || ''), '未命名笔记');
  // markdown 正文和 HTML 里的图片共用它分配文件名，保证两边指向同一份图
  const resourceNamer = createResourceNamer();
  /** 篇内让出器：这一篇的同步活最多连续占主线程 ~16ms（见 utils/yield.ts） */
  const breathe = createYielder();

  // 元数据默认开启。除标签要查一次主库（结果按知识库缓存）外，
  // 其余字段都直接来自已经在手的笔记对象，零网络请求。
  const metadata = options.exportMetadata
    ? collectMetadata(note, await resolveTagPaths(note.kbGuid), options.metadataRaw, await noteTagText(note))
    : undefined;

  // 1) 不支持的类型：导出原始 HTML 兜底
  if (!isMarkdownExportable(noteType)) {
    const res = await fetchNoteHtml(note, options, signal);
    if (!res.ok) {
      return { ok: false, detail: `${noteTypeLabel}：${res.detail}` };
    }
    return buildHtmlOnlyResult({
      note,
      options,
      baseName,
      noteType,
      noteTypeLabel,
      metadata,
      resourceNamer,
      breathe,
      signal,
      html: res.html,
    });
  }

  if (!liveEditor) {
    return { ok: false, detail: '未找到编辑器 SDK（window.LiveEditor），可能是应用尚未加载完成' };
  }

  // 批注层只在 HTML 里，且 html2Doc 会整层丢掉，所以拿到 HTML 就先捞出来
  let annotationSvgs: string[] = [];
  /** “同时导出 HTML”时留下的原件；只有走 HTML→doc→markdown 的笔记才会有 */
  let sourceHtml: string | undefined;
  /** 普通笔记的附件计划；只有在 HTML→doc 这条路上才有（见 planNoteAttachments） */
  let attachmentPlan: NoteAttachmentPlan | undefined;
  /** 大纲笔记的 markdown：自己遍历 `.node` 树生成，不走 doc2markdown（见 outline.ts） */
  let outlineMarkdown: string | undefined;
  /** 取回来的正文 HTML（只有 HTML → doc 这条路上才有；解析不出来时用它做兜底产物） */
  let noteHtml: string | undefined;

  // 2) Lite Markdown 笔记：markdown 原文就在 HTML 的 <pre> 里，直取最保真
  if (noteType === 'LiteMarkdown') {
    const res = await fetchNoteHtml(note, options, signal);
    if (!res.ok) return { ok: false, detail: res.detail };
    const raw = extractMarkdownFromLiteHtml(res.html);
    if (raw.trim()) {
      await breathe();
      const comments = options.keepComments
        ? await resolveCommentSection(note, noteType, undefined, signal)
        : undefined;
      const rewritten = rewriteImageTargets(raw, { rewrite: options.includeImages, namer: resourceNamer });
      await breathe();
      // 旧版评论区的正文是纯文本，没有资源要改写，所以放在 rewriteImageTargets 之后拼
      const markdown = comments?.section
        ? `${rewritten.markdown.trimEnd()}\n\n${comments.section}`
        : rewritten.markdown;
      const liteResources = resourceNamer.list();
      const liteCounts = resourceCounts(liteResources);
      return buildMarkdownResult({
        baseName,
        noteType,
        noteTypeLabel,
        markdown,
        namer: resourceNamer,
        resources: liteResources,
        imageRefs: liteCounts.imageRefs,
        attachmentRefs: liteCounts.attachmentRefs,
        annotationSvgs: extractAnnotations(res.html),
        includeImages: options.includeImages,
        metadata,
        metadataFormat: options.metadataFormat,
        comments: comments?.count,
        commentsError: comments?.error,
      });
    }
    // 空的 lite 笔记退回 HTML → doc 的通用路径
  }

  // 3) 协作笔记：只能读本地 doc JSON（必要时先联网同步一次）
  //
  // ⚠️ 这里不能用 /ks/note/view/.../index.html 兜底：那是旧版笔记的渲染接口，
  // 对协作笔记只会返回“当前客户端版本较低，无法编辑协作笔记”的占位页，
  // 转换出来是一份看起来很正常的假文档（曾经因此产出过 300 多字节的假 .md）。
  let doc: unknown;
  if (noteType === 'Collaboration') {
    const read = (): Promise<unknown> => liveEditor.getOfflineDocData(note.kbGuid, note.docGuid);
    doc = await read();

    if (!doc && options.allowNetworkFetch) {
      // 路径 1：查到知识库服务器后，开一条只读 WebSocket 把整篇文档同步下来。
      // 协作笔记的正文只存在 OT 服务器上，这是唯一能拿到正文的途径。
      const ksUrl = resolveKsUrl(note) ?? (await fetchKbServer(note.kbGuid));
      if (ksUrl) {
        // 同一个地址也是图片的源站，顺手记下来让资源下载直连
        rememberResourceSource(ksUrl, undefined);
        // 应用只给了超时、没有取消接口（默认 8s），所以拿 raceAbort 兜：中止时不再等它，
        // 那条只读同步让它自己在后台跑完（写的是本地缓存，没有副作用）
        await raceAbort(syncCollabDoc(ksUrl, note.kbGuid, note.docGuid), signal);
        doc = await read();
      }

      // 路径 2：请 Service Worker 帮忙。请求 index.html 会让它先跑 getDoc。
      // 实测协作笔记只靠这条拿不到正文（拿到的只是元数据），留作兜底。
      if (!doc) {
        await triggerRemoteDocFetch(note, signal);
        doc = await read();
      }
    }

    if (!doc) {
      return {
        ok: false,
        detail: options.allowNetworkFetch
          ? '联网状态下也没能拿到这篇协作笔记，请先在应用里打开它一次再导出'
          : '本地没有这篇协作笔记的内容，已跳过（可开启联网补全）',
      };
    }
  } else {
    // 4) 老笔记：HTML → doc
    const res = await fetchNoteHtml(note, options, signal);
    if (!res.ok) return { ok: false, detail: res.detail };
    noteHtml = res.html;
    annotationSvgs = extractAnnotations(res.html);
    await breathe();
    // “同时导出 HTML”时留一份原件：这条路径是 HTML 反推 markdown，HTML 才是保真的
    if (options.exportHtml) sourceHtml = sanitizeNoteHtml(res.html);
    await breathe();
    // 附件必须从**原始 HTML** 里认：`wiz://open_attachment` 链接会被 html2Doc 整个丢掉，
    // 转出来的 doc / markdown 里只剩一张预览图，看不出它是个附件
    if (options.includeAttachments) {
      attachmentPlan = await planNoteAttachments(
        note,
        res.html,
        resourceNamer,
        options.allowNetworkFetch,
        signal,
      );
    }
    if (noteType === 'Outline') {
      // 大纲笔记不走 html2Doc：那是 Turndown，会把 .node 树整个抹平（见 outline.ts）
      outlineMarkdown = await outlineHtmlToMarkdown(res.html, breathe);
      if (outlineMarkdown === undefined) {
        return { ok: false, detail: '页面里没有找到大纲结构，无法转换为 Markdown' };
      }
    } else {
      // 宿主自己的 HTML → doc（Turndown 系），整篇同步，可能是这一篇里最重的一步
      doc = liveEditor.html2Doc(res.html);
      await breathe();
      // 实测（2026-10-07）：正文里只要有**没有单元格的 `<table>`**，html2Doc 就会返回
      // undefined，整篇变成“解析不出来”。这种表本身没有内容（摘掉无损），所以失败时
      // 预处理一遍再试 —— 只有这一次失败才付“重新序列化整篇 HTML”的代价。
      if (!doc && /<table/i.test(res.html)) {
        doc = liveEditor.html2Doc(stripCellLessTables(res.html));
        log.info('摘掉无单元格的 table 后重新解析', { docGuid: note.docGuid, parsed: Boolean(doc) });
        await breathe();
      }
    }
  }

  if (!doc && outlineMarkdown === undefined) {
    // 走到这里说明**正文取到了、但宿主解析不出来**（典型诱因就是上面那个空表格）。
    // 用户勾了“同时导出原始 HTML”时至少把原文保住，别让整篇凭空消失；
    // 没勾就跳过 —— 但要说清怎么把这篇捞回来，不能只丢一句“无法解析笔记内容”。
    if (noteHtml && options.exportHtml) {
      log.warn('HTML 解析失败，改为只导出原始 HTML', note.docGuid);
      return buildHtmlOnlyResult({
        note,
        options,
        baseName,
        noteType,
        noteTypeLabel,
        metadata,
        resourceNamer,
        breathe,
        signal,
        html: noteHtml,
        problems: ['应用的 HTML 解析器处理不了这篇的正文，没能转成 Markdown，已改为只导出原始 HTML'],
      });
    }
    return {
      ok: false,
      detail: noteHtml
        ? '应用的 HTML 解析器处理不了这篇的正文，没能转成 Markdown；勾选“同时导出原始 HTML”可以至少保住原文'
        : '无法解析笔记内容',
    };
  }

  // 编辑器产出的 doc 上带着资源源站信息，记下来供下载图片时直连。
  // 大纲笔记没有 doc（正文是我们自己从 HTML 树拼的），这里自然跳过。
  const meta = (doc as { meta?: { apiServer?: unknown; token?: unknown } } | undefined)?.meta;
  rememberResourceSource(meta?.apiServer, meta?.token);

  // 附件只存在于协作笔记的 doc JSON 里（`type: 'embed'` 块）。
  // 普通笔记的 doc 是 HTML 反推出来的，不会有这类块，收集结果自然为空。
  const attachments = options.includeAttachments ? collectAttachments(doc) : [];
  const attachmentByName = new Map(attachments.map((item) => [item.name, item]));
  await breathe();

  let markdown: string;
  if (outlineMarkdown !== undefined) {
    // 大纲笔记的 markdown 在 outline.ts 里就拼好了，不经过 doc2markdown
    markdown = outlineMarkdown;
  } else {
    try {
      markdown = liveEditor.doc2markdown(doc, {
        keepImageSize: false,
        // 评论**不交给应用渲染**：它只吐“作者 时间 + 正文”，既不输出被引用的原文，
        // 也不区分锚点，格式还不受我们控制。我们关掉它，自己拼文末章节（见 comments.ts）。
        keepComments: false,
        // 先原样输出资源名，之后统一改写成 images/ 相对路径
        buildResourceUrl: (name: string) => name,
      });
    } catch (error) {
      log.error('doc2markdown 失败', error);
      return { ok: false, detail: `转换失败：${(error as Error).message}` };
    }
  }

  // 正文为空**不是**问题：空笔记也是正常笔记（标题、时间、分类都在元数据里），照常导出 ——
  // 产物就是 front matter（有评论 / 附件时再拼上相应章节）。
  // 早先这里会 `return { ok: false, detail: '笔记内容为空，已跳过' }`，那会让用户以为丢了一篇。
  // doc2markdown 是宿主自己的整篇转换，和 html2Doc 一样可能在主线程上待很久
  await breathe();

  // 反转义只作用在**笔记正文**上：那是 doc2markdown 为了编辑器显示而转义的渲染产物。
  // 评论区不加这一步 —— 旧版评论的 body 是用户手写的 markdown，`\_` 可能是故意写的。
  // 大纲笔记也不加：它的 `\*` 是**故意**加的（节点文本按纯文本处理，见 outline.ts）。
  const body = outlineMarkdown === undefined ? unescapeMarkdown(markdown) : markdown;
  await breathe();

  // 评论章节要在 rewriteImageTargets **之前**拼：评论正文里也可能有图片，
  // 需要一起被改写并下载（批注章节则相反，见下）。
  const comments = options.keepComments
    ? await resolveCommentSection(note, noteType, doc, signal)
    : undefined;
  // 正文为空时**也要**把评论章节拼上：否则结果区报“评论 3 条”，产物里却一句话都没有
  //（空笔记现在照常导出，这条路径真的会走到 —— 见下面正文为空那段说明）。
  const withComments = comments?.section
    ? body.trim()
      ? `${body.trimEnd()}\n\n${comments.section}`
      : comments.section
    : body;

  // 顺序有讲究：
  //   1. 先把普通笔记附件的预览图换成附件链接 —— 必须在 rewriteImageTargets 之前，
  //      否则那张 index_files/{attGuid}_image.png 会被当成图片下载进 images/；
  //   2. 再改写 / 收集图片；
  //   3. 最后处理协作笔记的 embed 附件链接。
  // 协作笔记的双链：`[[名称 id=guid]]` → `[[名称]]`。放在附件改写之前，
  // 和它们没有语法交集，只是让"改写正文"的几步排在一起更好读。
  const withWikiLinks = noteType === 'Collaboration' ? rewriteWikiLinks(withComments) : withComments;
  await breathe();
  const attached = rewriteNoteAttachments(withWikiLinks, attachmentPlan?.byGuid ?? new Map());
  await breathe();
  const rewritten = rewriteImageTargets(attached.markdown, { rewrite: options.includeImages, namer: resourceNamer });
  await breathe();
  const withAttachments = rewriteAttachments(rewritten.markdown, {
    rewrite: options.includeAttachments,
    namer: resourceNamer,
    attachments: attachmentByName,
  });
  // 正文里引用不到（或那张预览图没出现在 markdown 里）的附件，列到文末；
  // 否则它们会被下载进 zip，却没有任何地方引用 —— 用户根本找不到
  const attachmentSection = renderAttachmentSection(
    (attachmentPlan?.all ?? [])
      .filter((item) => !attached.used.has(item.key))
      .map((item) => item.link),
  );
  // 同上：正文为空（空笔记）时附件章节正是产物里唯一的内容，更不能因为“正文是空的”丢掉它 ——
  // 丢了就成了“附件进了 zip、却没有任何地方引用”。
  const finalMarkdown = attachmentSection
    ? withAttachments.trim()
      ? `${withAttachments.trimEnd()}\n\n${attachmentSection}`
      : attachmentSection
    : withAttachments;

  // “同时导出 HTML”的 sidecar 同样要本地化图片引用 + 内联外链样式表，
  // 否则离线打开还是缺图、缺样式。和 markdown 共用同一个分配器，所以两边指向同一份 images/。
  // 附件链接也一样要指向 `attachments/`（§4.6 的同一条规则，凡是产物里的 HTML 都适用）。
  const localizedSource = sourceHtml
    ? await localizeHtmlResources(
        rewriteHtmlAttachments(sourceHtml, attachmentPlan?.byGuid ?? new Map()),
        { rewrite: options.includeImages, namer: resourceNamer, note, signal, breathe },
      )
    : undefined;
  // 附件少导出不能是静默的：清单两边都没拿到时用户只会看到“附件 0 个”，
  // 却不知道笔记里其实挂着附件，所以对照 attachmentCount 提醒一句（规则见 attachmentProblemList）
  const problems = [
    ...(localizedSource?.problems ?? []),
    ...attachmentProblemList(note, attachmentPlan),
  ];
  // 注意顺序：批注章节要在 rewriteImageTargets 之后追加，
  // 否则它自己注入的 images/annotation-N.svg 会被当成待下载资源。
  const resources = resourceNamer.list();
  const counts = resourceCounts(resources);
  return buildMarkdownResult({
    baseName,
    namer: resourceNamer,
    noteType,
    noteTypeLabel,
    markdown: finalMarkdown,
    resources,
    // 统一成“本次要落盘的文件数”而不是“引用次数”：
    // 同一份资源被引用多次只会下载一次，报告里 `图片 成功/总数` 才自洽
    imageRefs: counts.imageRefs,
    attachmentRefs: counts.attachmentRefs,
    annotationSvgs,
    includeImages: options.includeImages,
    metadata,
    metadataFormat: options.metadataFormat,
    sourceHtml: localizedSource?.html,
    problems,
    comments: comments?.count,
    commentsError: comments?.error,
  });
}

/* ------------------------------------------------------------------ */
/* 导出前的预检（纯本地，不发任何请求）                                 */
/* ------------------------------------------------------------------ */

/** 内容来源 */
export type PlanSource = 'local' | 'remote' | 'fallback-html';

export interface NotePlan {
  note: NoteRef;
  noteType: NoteType;
  noteTypeLabel: string;
  /** 输出文件扩展名 */
  outputExt: '.md' | '.html';
  /**
   * local        本地已有内容，直接读
   * remote       本地没有，需要联网补全（联网关闭时会被跳过）
   * fallback-html 不支持转 Markdown，导出原始 HTML
   */
  source: PlanSource;
}

/**
 * 预检单篇笔记：判断导出形式、内容是否在本地。
 * 只做本地读取（IndexedDB / 本地 doc 数据），不会产生任何网络请求。
 */
export async function inspectNote(note: NoteRef): Promise<NotePlan> {
  const noteType = getNoteType(note);
  const noteTypeLabel = NOTE_TYPE_LABEL[noteType];

  if (!isMarkdownExportable(noteType)) {
    return { note, noteType, noteTypeLabel, outputExt: '.html', source: 'fallback-html' };
  }

  if (noteType === 'Collaboration') {
    let hasLocal = false;
    try {
      hasLocal = Boolean(await getLiveEditor()?.getOfflineDocData(note.kbGuid, note.docGuid));
    } catch (error) {
      log.debug('预检协作笔记失败', note.docGuid, error);
    }
    return { note, noteType, noteTypeLabel, outputExt: '.md', source: hasLocal ? 'local' : 'remote' };
  }

  const stored = await isNoteStoredLocally(note.kbGuid, note.docGuid);
  return { note, noteType, noteTypeLabel, outputExt: '.md', source: stored === 'yes' ? 'local' : 'remote' };
}

/** 按选项把预检结果折算成“会导出几篇 / 会跳过几篇” */
export function summarizePlans(
  plans: NotePlan[],
  options: { allowNetworkFetch: boolean },
): { willExport: number; willSkip: number; htmlCount: number } {
  let willExport = 0;
  let willSkip = 0;
  let htmlCount = 0;

  for (const plan of plans) {
    if (plan.source === 'fallback-html') htmlCount += 1;
    if (plan.source === 'remote' && !options.allowNetworkFetch) willSkip += 1;
    else willExport += 1;
  }

  return { willExport, willSkip, htmlCount };
}
