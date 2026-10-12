/** 一篇笔记的最小标识，取自应用内部的 note 对象（字段名沿用应用） */
export interface NoteRef {
  kbGuid: string;
  docGuid: string;
  title: string;
  type?: string;
  category?: string;
  tags?: string;
  protected?: number;
  [key: string]: unknown;
}

/** 元数据的落盘形态 */
export type MetadataFormat = 'yaml' | 'json';

/**
 * 一篇笔记**在本次产物里**的落点（由 `task.ts` 在渲染前预分配）。
 *
 * 只服务一件事：正文里的笔记内链 / 双链要改写成 wikilink，而 wikilink 的名字里不允许
 * 出现 `[` `]` `#` `^` `%%`（宿主没有转义机制）。名字里带这些字符时，**只有目标也在这一批里**
 * 才能退化成标准 markdown 链接（我们得知道它的相对路径）；不在这一批里就只能退化成纯文本。
 * 见 `note-content.ts` 的 `rewriteInternalLinks()` 与 docs/export-pipeline.md §9.3。
 */
export interface BatchNotePath {
  /** zip 内的相对路径，例如 `标题/标题.md`（单篇导出时是 `标题.md`） */
  path: string;
  /** 产物里的名字（不含目录与 `.md`）—— wikilink 写的就是它 */
  name: string;
}

/** 本次批次：`docGuid`（小写）→ 落点 */
export type BatchPathIndex = Map<string, BatchNotePath>;

/** 导出选项，来自对话框 */
export interface ExportOptions {
  /** 把图片下载成文件并放进 zip 的 images/ 目录 */
  includeImages: boolean;
  /**
   * 把附件下载成文件并放进 zip 的 attachments/ 目录。
   *
   * “附件”指笔记里上传的**文件**，三条路都已支持：
   * - 协作笔记：doc JSON 里的 `type: 'embed'` 块（`embedData.src` / `fileName`），见 export-pipeline.md §4.4；
   * - 普通笔记（导出 markdown）：本地 `attachments` 表（不够用时联网补清单）+ 正文里的
   *   `wiz://open_attachment` 引用，见 §4.5；
   * - 只导 HTML 的那几类（大纲 / 手写 / 旧版公式）：同一套清单，把正文里**已经存在**的附件链接
   *   指向 `attachments/`（不新增段落），见 §4.6。
   */
  includeAttachments: boolean;
  /**
   * 把笔记评论导出成文末的“评论”章节（见 docs/export-pipeline.md §3.3）。
   *
   * 两种笔记的评论来源完全不同，产出的章节格式统一：
   * - 协作笔记（锚定型）：评论在 doc JSON 里，被评论的原文以引用块给出；
   * - 旧版笔记（评论区）：走 `/ks/note/comments` 接口现取，没有"原文"可引用。
   */
  keepComments: boolean;
  /** 本地没有内容时，允许联网把笔记拉下来 */
  allowNetworkFetch: boolean;
  /** 导出笔记元数据（创建/修改时间、分类、标签、来源链接 等） */
  exportMetadata: boolean;
  /** 元数据形态：写进正文的 YAML front matter，还是同名 .meta.json */
  metadataFormat: MetadataFormat;
  /** 元数据里附带 WizNote 原始字段（供排查） */
  metadataRaw: boolean;
  /**
   * 同时导出原始 HTML。
   *
   * 只对**走“HTML → doc → markdown”这条有损路径**的笔记生效 ——
   * HTML 在这里的价值就是给有损转换做保真备份。所以：
   * - 普通笔记 / 旧版 Markdown 笔记 → 有
   * - Lite Markdown 笔记 → 无（md 是从 `<pre>` 直接取的原文，已经无损）
   * - 协作笔记 → 无（源是 doc JSON，且它的 index.html 只有占位页）
   * - 大纲 / 手写 / 公式 → 产物本身就是 html，不重复产出
   */
  exportHtml: boolean;
}

/** 单篇导出结果 */
export interface NoteExportResult {
  note: NoteRef;
  status: 'ok' | 'skipped' | 'failed';
  /** 跳过/失败的原因，会展示给用户 */
  detail?: string;
  /** 笔记类型的中文名 */
  noteTypeLabel: string;
  /** Markdown 里引用的本地图片数量 */
  imageRefs?: number;
  /** 成功写进产物的图片数量 */
  imagesSaved?: number;
  /** 图片下载失败数量 */
  imagesFailed?: number;
  /**
   * 上面那批失败里，**只在 HTML 产物 / 另附 HTML 里用到**的数量（含内联样式表的 `url()`）。
   *
   * 和它的差值就是“Markdown 正文明明引用了、但没取到”的数量 —— 提示文案要分开写：
   * 正文缺图是真缺图，而只为 HTML 服务的站点皮肤 / 背景图缺了并不影响正文可读性。
   */
  imagesFailedInHtml?: number;
  /** 笔记里引用的附件数量（要落盘到 attachments/ 的） */
  attachmentRefs?: number;
  /** 成功写进产物的附件数量 */
  attachmentsSaved?: number;
  /** 附件下载失败数量 */
  attachmentsFailed?: number;
  /** 检测到的手写批注层数（覆盖式批注，Markdown 承载不了，只做降级保留） */
  annotations?: number;
  /** 写进文末“评论”章节的评论条数 */
  comments?: number;
  /** 勾了“包含评论”但取不到时的原因（结果区要提示，不静默略过） */
  commentsError?: string;
  /** 评论落在同名的另一个 `.md` 里（只导出 HTML 的笔记类型） */
  commentsSidecar?: boolean;
  /**
   * 这篇笔记的其他问题（如外链样式表取不到被移除）。
   * 和“图片没取到”一样渲染进“问题”页。
   */
  problems?: string[];
  /** 元数据落成了同名 .meta.json（JSON 模式，或 HTML 笔记无法承载 YAML 时的降级） */
  metadataSidecar?: boolean;
  /** 另附了原始 HTML（针对有损转换的保真备份） */
  htmlSidecar?: boolean;
}

/** 进度回调 */
export interface ExportProgress {
  /** 当前处理到第几篇（从 1 开始） */
  index: number;
  total: number;
  title: string;
  /**
   * **这一篇内部**已经完成的比例（0..1）。
   *
   * 一篇笔记的工作量算作“正文处理 1 步 + 要下载的图片数 + 要下载的附件数”，
   * 这个值只在真正干完一步之后才往上走。
   *
   * ⚠️ 整体进度**不能**写成 `index / total`：那样一开始处理最后一篇，进度条就已经满了
   * （`index` 是"正在处理第几篇"，不是"处理完几篇"）。正确算法见
   * `session.ts` 的 `applyProgress()` 与 docs/export-pipeline.md §1.5。
   */
  noteProgress?: number;
  /**
   * 这篇笔记内的图片下载进度。
   * 只有正在下载图片时才带，其余阶段为空。
   */
  resourceDone?: number;
  resourceTotal?: number;
  /**
   * 这篇笔记内的附件下载进度。
   * 图片下完才开始下附件，所以同一时刻只有一组计数有值。
   */
  attachmentDone?: number;
  attachmentTotal?: number;
}

/** 打包用的文件条目 */
export interface ArchiveEntry {
  /** zip 内的相对路径，例如 `images/xxx.png` */
  path: string;
  data: Uint8Array;
}
