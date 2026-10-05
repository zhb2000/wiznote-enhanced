import { invariant } from '../utils/invariant';
import { logger } from '../utils/log';
import { createYielder } from '../utils/yield';
import { fetchAttachment, fetchNoteAttachment, fetchResource } from './app-bridge';
import { buildZip, bytesToBlob, mimeOf, type ZipProgress } from './archive';
import { createNameAllocator, toDiskName } from './naming';
import { renderNote } from './note-content';
import type { ArchiveEntry, ExportOptions, ExportProgress, NoteExportResult, NoteRef } from './types';

const log = logger('export');

/** 打包进度：`cancelled` 表示这是“被中止之后把已完成的部分打出来” */
export interface PackagingProgress extends ZipProgress {
  cancelled: boolean;
}

export interface ExportHooks {
  onProgress?: (progress: ExportProgress) => void;
  /**
   * 一篇**刚刚结束**（成功 / 失败 / 跳过都算）时的结果。
   *
   * 逐篇报而不是等整批结束再一次性给：结果在这一篇结束的那一刻就有了，而上层要拿它
   * 把那一行从“导出中…”换成真正的结论。攒到最后才给的话，已经导完的行会一直挂在
   * “导出中…”，几十上百篇时列表看着像卡住（见 session.ts 的 `applyNoteDone()`）。
   *
   * ⚠️ 被中止打断的那一篇**不会**走到这里 —— 它什么都还没落进产物，由上层记成“未处理”。
   */
  onNoteDone?: (result: NoteExportResult) => void;
  /**
   * 本次导出的取消通道（见 `utils/abort.ts`）。
   *
   * 中途中止时循环在**下一个检查点**退出：下载中的请求由它直接作废，正在渲染的那一篇
   * 整个作废（既不算失败也不算跳过 —— 那一篇什么都没落进产物）。
   */
  signal?: AbortSignal;
  /**
   * 收尾打包的进度。
   *
   * 打包是纯 CPU 的同步活，几百篇时能占住主线程好几秒 —— 没有它，那几秒在界面上
   * 就是“点了中止之后卡住不动”。见 `archive.ts` 的 `buildZip()`。
   */
  onPackaging?: (progress: PackagingProgress) => void;
}

export interface ExportOutcome {
  blob?: Blob;
  filename: string;
  results: NoteExportResult[];
  cancelled: boolean;
  /** Markdown 里引用的本地图片总数 */
  imageRefs: number;
  /** 成功写进产物的图片数 */
  imagesSaved: number;
  /** 图片下载失败的条数，用于结果提示 */
  missingResources: number;
  /** 笔记里引用的附件总数 */
  attachmentRefs: number;
  /** 成功写进产物的附件数 */
  attachmentsSaved: number;
  /** 附件下载失败的条数 */
  missingAttachments: number;
  /** 检测到的手写批注层总数 */
  annotations: number;
  /** 写进文末“评论”章节的评论总数 */
  comments: number;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 导出多篇（或单篇带图片）。
 *
 * 单篇且没有图片时直接给 `.md` / `.html` 文件；否则打包 zip。
 * 多篇时每篇分配一个与标题同名的文件夹，避免不同笔记的 `images/` 互相覆盖；
 * **同标题的笔记靠文件夹加 ` (2)` 后缀区分**，正文文件名保持等于标题（不改名）。
 */
export async function exportNotes(
  notes: NoteRef[],
  options: ExportOptions,
  hooks: ExportHooks = {},
): Promise<ExportOutcome> {
  const results: NoteExportResult[] = [];
  const entries: ArchiveEntry[] = [];
  const archiveNames = createNameAllocator();
  const grouped = notes.length > 1;
  let missingResources = 0;
  let imageRefs = 0;
  let imagesSaved = 0;
  let attachmentRefs = 0;
  let attachmentsSaved = 0;
  let missingAttachments = 0;
  let annotations = 0;
  let comments = 0;
  let cancelled = false;

  /** 记一篇的结论，并**立刻**报给上层（上层靠它把那一行从“导出中…”换成真正的结论） */
  const reportResult = (result: NoteExportResult): void => {
    results.push(result);
    hooks.onNoteDone?.(result);
  };

  /**
   * 篇间的让出器（见 `utils/yield.ts`）：`renderNote` 内部已有自己的让出点，
   * 这里是它管不到的那几笔 —— 正文编码成字节、以及每篇之间的收尾。
   */
  const breathe = createYielder();

  for (const [index, note] of notes.entries()) {
    if (hooks.signal?.aborted) {
      cancelled = true;
      break;
    }

    const title = note.title || '未命名笔记';
    hooks.onProgress?.({ index: index + 1, total: notes.length, title, noteProgress: 0 });

    let outcome;
    try {
      outcome = await renderNote(note, options, hooks.signal);
    } catch (error) {
      // 中止不是失败：这一篇还什么都没落进产物，整个作废（由 applyOutcome 记成“未处理”）
      if (hooks.signal?.aborted) {
        cancelled = true;
        break;
      }
      log.error('导出笔记异常', note.docGuid, error);
      reportResult({ note, status: 'failed', detail: (error as Error).message, noteTypeLabel: '' });
      continue;
    }

    // 中止也可能落在这一篇的某一步上：那一步的“取不到正文/取不到评论”只是中止的副作用，
    // 照样整篇作废 —— 不能把它当成本篇自己的结论（那会凭空多出几条“跳过”）
    if (hooks.signal?.aborted) {
      cancelled = true;
      break;
    }

    if (!outcome.ok) {
      reportResult({ note, status: 'skipped', detail: outcome.detail, noteTypeLabel: '' });
      continue;
    }

    const { data } = outcome;
    // 目录名要按“目录”规则消歧（`v1.0` → `v1.0 (2)`，而不是 `v1 (2).0`）。
    // 后缀也必须落在斜杠**之前**，所以先分配不带斜杠的目录名，再拼 `/`。
    const noteDirName = grouped
      ? archiveNames.allocate(toDiskName(data.fileName.replace(/\.[^.]+$/, ''), '未命名笔记'), { kind: 'dir' })
      : '';
    const noteDir = noteDirName ? `${noteDirName}/` : '';

    // 正文文件名恒等于笔记标题，只登记占位、不参与改名（消歧只落在文件夹上）。
    const bodyPath = `${noteDir}${data.fileName}`;
    invariant(archiveNames.reserve(bodyPath), '笔记路径重复，zip 内会互相覆盖', { path: bodyPath });
    // 正文编码成字节也是**整篇一遍**（几十 MB 的剪藏要十几毫秒），和篇内那几趟改写一样
    // 放在让出点两侧：上一段（格式转换）刚干完，正好在这里把那一帧还回去
    await breathe();
    entries.push({ path: bodyPath, data: new TextEncoder().encode(data.markdown ?? data.html ?? '') });
    await breathe();

    // 批注图层 / sidecar 是从笔记里直接抽出来的，内容已经生成好，不需要下载；
    // 名字在渲染期就定好了（批注图层还与真实图片共用同一个分配器），这里只登记。
    for (const file of data.extractedFiles) {
      const path = `${noteDir}${file.path}`;
      invariant(archiveNames.reserve(path), '附加文件路径重复，zip 内会互相覆盖', { path });
      entries.push({ path, data: file.data });
    }
    annotations += data.annotations;
    comments += data.comments;

    imageRefs += data.imageRefs;
    attachmentRefs += data.attachmentRefs;
    const imageResources = data.resources.filter((resource) => resource.dir === 'images');
    const attachmentResources = data.resources.filter((resource) => resource.dir === 'attachments');
    let savedForNote = 0;
    let failedForNote = 0;
    /** 失败里“只在 HTML 产物 / 另附 HTML 里用到”的那部分（正文其实不缺图，提示要分开写） */
    let failedInHtmlForNote = 0;
    let savedAttachments = 0;
    let failedAttachments = 0;

    /*
     * 这一篇的工作量按“步”算：正文处理 1 步 + 真正要下载的图片 + 真正要下载的附件。
     * 逐步骤上报 `noteProgress`，让上层能把整体进度算成“已完成篇数 + 当前篇的比例”，
     * 而不是“正在处理第几篇”—— 后者一进最后一篇就满了（见 types.ts 的说明）。
     */
    const imageSteps = options.includeImages ? imageResources.length : 0;
    const attachmentSteps = options.includeAttachments ? attachmentResources.length : 0;
    const steps = 1 + imageSteps + attachmentSteps;
    const reportNote = (
      done: number,
      extra?: {
        resourceDone?: number;
        resourceTotal?: number;
        attachmentDone?: number;
        attachmentTotal?: number;
      },
    ): void => {
      hooks.onProgress?.({
        index: index + 1,
        total: notes.length,
        title,
        noteProgress: done / steps,
        ...extra,
      });
    };
    // 正文（读内容 / 转 markdown / 抽资源清单）已经做完了
    reportNote(1);

    /**
     * 落一个资源文件（图片 / 附件）。
     *
     * 路径唯一性本来由渲染期的 ResourceNamer 保证（`images/`、`attachments/` 各自
     * 按文件名去重，重名加 ` (2)` 后缀），这里再过一遍 `allocate` 纯粹是兜底，
     * 确保 zip 里不出现两个同名 entry。
     *
     * ⚠️ 兜底真被触发就说明分配器有 bug，而改名会让 Markdown 里的链接指向不存在的文件，
     * 所以必须留日志，不能静默处理。
     */
    const pushResource = (dir: string, basename: string, bytes: Uint8Array): void => {
      const path = `${noteDir}${dir}/${basename}`;
      const allocated = archiveNames.allocate(path);
      invariant(allocated === path, '资源路径重名，已自动改名（Markdown 链接可能失效）', { path, allocated });
      entries.push({ path: allocated, data: bytes });
    };

    // 图片与附件分两段串行下载：校验方式不同（图片认魔数，附件认任意文件），
    // 进度文案也分开（`图片 a/b`、`附件 c/d`），同一时刻只有一组有值。
    //
    // ⚠️ 这里**不要**再加“歇一下”式的 sleep：请求节流（网络请求之间至少隔 60ms、
    // 本地命中不占名额）统一在 `app-bridge` 的 `pacedFetch()` 里做，
    // 加在这儿会变成两层限流、并且对本地命中的图白等一遍（见 docs/export-pipeline.md §十）。
    if (options.includeImages) {
      for (const [resourceIndex, resource] of imageResources.entries()) {
        if (hooks.signal?.aborted) {
          cancelled = true;
          break;
        }
        const bytes = await fetchResource(note, resource.name, hooks.signal);
        // 中止是发生在这一次请求上的：它注定拿不到东西，别把它记成“图片没取到”
        if (hooks.signal?.aborted) {
          cancelled = true;
          break;
        }
        if (bytes) {
          pushResource(resource.dir, resource.basename, bytes);
          savedForNote += 1;
        } else {
          failedForNote += 1;
          missingResources += 1;
          if (resource.referencedBy === 'html') failedInHtmlForNote += 1;
          log.warn('图片下载失败', { name: resource.name, referencedBy: resource.referencedBy });
        }
        reportNote(1 + resourceIndex + 1, {
          resourceDone: resourceIndex + 1,
          resourceTotal: imageResources.length,
        });
      }
    }

    if (!cancelled && options.includeAttachments) {
      for (const [resourceIndex, resource] of attachmentResources.entries()) {
        if (hooks.signal?.aborted) {
          cancelled = true;
          break;
        }
        // 两个通道的附件取法完全不同：协作笔记的 office 附件当资源名取，
        // 普通笔记的附件得按 attGuid 走 /ks/attachment/download（见 app-bridge）
        const bytes =
          resource.channel === 'attachment'
            ? await fetchNoteAttachment(note, resource.name, hooks.signal)
            : await fetchAttachment(note, resource.name, hooks.signal);
        // 同上：中止打断的那一次不算“附件没取到”
        if (hooks.signal?.aborted) {
          cancelled = true;
          break;
        }
        if (bytes) {
          pushResource(resource.dir, resource.basename, bytes);
          savedAttachments += 1;
        } else {
          failedAttachments += 1;
          missingAttachments += 1;
          log.warn('附件下载失败', { key: resource.name, file: resource.basename });
        }
        reportNote(1 + imageSteps + resourceIndex + 1, {
          attachmentDone: resourceIndex + 1,
          attachmentTotal: attachmentResources.length,
        });
      }
    }

    imagesSaved += savedForNote;
    attachmentsSaved += savedAttachments;

    reportResult({
      note,
      status: 'ok',
      noteTypeLabel: data.noteTypeLabel,
      imageRefs: data.imageRefs,
      imagesSaved: savedForNote,
      imagesFailed: failedForNote,
      imagesFailedInHtml: failedInHtmlForNote,
      attachmentRefs: data.attachmentRefs,
      attachmentsSaved: savedAttachments,
      attachmentsFailed: failedAttachments,
      annotations: data.annotations,
      comments: data.comments,
      commentsError: data.commentsError,
      commentsSidecar: data.commentsSidecar,
      problems: data.problems,
      metadataSidecar: data.metadataSidecar,
      htmlSidecar: data.htmlSidecar,
      // markdown 为空说明走了 HTML 兜底
      detail: data.markdown === undefined ? `${data.noteTypeLabel}暂不支持转 Markdown，已导出原始 HTML` : undefined,
    });

    if (cancelled) break;
  }

  /** 三个出口都要带上的计数，收口成一个对象，避免新增字段时漏掉某个分支 */
  const totals = {
    results,
    cancelled,
    missingResources,
    imageRefs,
    imagesSaved,
    attachmentRefs,
    attachmentsSaved,
    missingAttachments,
    annotations,
    comments,
  };

  if (entries.length === 0) {
    return { filename: '', ...totals };
  }

  // 只要产物里还引用着本地资源（图片或附件）、且用户选择了下载，就必须打包：
  // 即使一个都没下下来，也不能退化成一个引用着不存在的 images/ 的裸 .md。
  const needArchive =
    grouped ||
    entries.length > 1 ||
    (options.includeImages && imageRefs > 0) ||
    (options.includeAttachments && attachmentRefs > 0);

  if (!needArchive && entries.length === 1) {
    const only = entries[0];
    return {
      blob: bytesToBlob(only.data, mimeOf(only.path)),
      filename: only.path,
      ...totals,
    };
  }

  const baseName = notes.length === 1 ? notes[0].title || '未命名笔记' : `笔记导出-${timestamp()}`;
  // 先把“开始打包”报出去（done 0）：打包本身可能要好几秒，界面得在这之前就有交代
  hooks.onPackaging?.({ done: 0, total: entries.length, cancelled });
  const blob = await buildZip(entries, {
    onProgress: ({ done, total }) => hooks.onPackaging?.({ done, total, cancelled }),
  });
  return {
    blob,
    filename: `${toDiskName(baseName, '未命名笔记')}.zip`,
    ...totals,
  };
}
