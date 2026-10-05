import { logger } from '../utils/log';
import { saveBlob } from './app-bridge';
import { inspectNote, summarizePlans, type NotePlan } from './note-content';
import { exportNotes, type ExportOutcome, type PackagingProgress } from './task';
import type { ExportOptions, ExportProgress, NoteExportResult, NoteRef } from './types';

const log = logger('session');

/**
 * 导出任务的**会话层**：任务队列 + 每个任务的完整状态。
 *
 * 为什么要独立于对话框存在：对话框随时可能被关掉或最小化，而导出本身要继续跑。
 * 所以“任务”必须活在视图之外 —— 这里就是它的家：
 *
 * - 任务**串行**执行（同一时刻只跑一个）：请求节流本身是串行假设下的（见 app-bridge 的
 *   `requestPacer`），并发只会把请求量叠上去，把站点打得更狠；
 * - 进度 / 逐篇结果 / 产出文件 / 选项都挂在任务上，视图只读它，改它一律走这里；
 * - **中止**（`cancelTask`）：跑着的那一刻 abort 掉 `activeAbort`（在飞的请求与当前那一篇
 *   立刻作废），之后把已经导出的部分打包给用户 —— 打包是纯 CPU 活，进度与让出主线程见
 *   `archive.ts` 的 `buildZip()`；
 * - 任务在排队或运行中时挂 `beforeunload`，关页面要用户二次确认（浏览器原生弹窗）。
 *
 * 视图有两个，都只是订阅者：
 * - `src/ui/export-dialog.ts` —— 完整对话框（配置 / 进度 / 结果）；
 * - `src/ui/export-tasks.ts` —— 最小化之后的悬浮任务条。
 */

/** 任务阶段：草稿两态（scanning / ready）→ 队列（queued）→ 运行（running）→ 结束（done） */
export type TaskPhase = 'scanning' | 'ready' | 'queued' | 'running' | 'done';

/** 左栏当前页 */
export type TaskTab = 'all' | 'issues';

/** 列表里一行笔记的运行时状态：导出前 / 导出中 / 导出后都落在这一行上 */
export interface TaskRow {
  note: NoteRef;
  /** 笔记类型中文名 */
  noteTypeLabel: string;
  /** 输出扩展名 */
  outputExt: string;
  /** pending 尚未处理，running 导出中，其余为导出后的结果 */
  status: 'pending' | 'running' | 'ok' | 'skipped' | 'failed';
  /** 状态配色后缀（local / remote / fallback-html / running / ok / skipped / failed / pending） */
  tone: string;
  /** 副行状态文案 */
  state: string;
  /** 导出中的附加进度，例如“图片 3/10” */
  progress?: string;
  /** 需要单独列进“问题”页的说明 */
  problems: string[];
}

export interface ExportTask {
  readonly id: number;
  readonly notes: NoteRef[];
  /** 右键来源（“笔记列表” / “阅读界面”），只用于展示 */
  readonly trigger?: string;
  phase: TaskPhase;
  /** 导出选项：草稿期就可改，开始导出后冻结（界面置灰） */
  options: ExportOptions;
  /** 预检结果，下标与 notes / rows 对齐 */
  plans: (NotePlan | undefined)[];
  rows: TaskRow[];
  /** 预检已完成几篇（scanning 阶段的进度） */
  scannedCount: number;
  /** 左栏当前页 */
  tab: TaskTab;
  /**
   * 左栏**每个页签各自**的滚动位置（px）。
   *
   * 它必须活在任务上，不能只留在对话框里：收起（或被下一个任务顶掉）时整棵对话框 DOM 会被
   * 摘掉，下次从悬浮条点进来是重新建的，位置只留在视图里就等于“每次重开都回到第一行”。
   * 和 `tab` 一样，它描述的是“这个任务看到哪儿了”，不是某个 DOM 节点的属性。
   * 视图侧只在两个地方写它：列表重建前、以及对话框关闭前（见 `ui/export-dialog.ts`）。
   */
  listScroll: Record<TaskTab, number>;
  /** 结果汇总（done 之后） */
  summary: string;
  /** 底部进度百分比 */
  progress: number;
  /** 底部进度文案 */
  progressText: string;
  /** 下载按钮文案；空字符串表示隐藏 */
  downloadLabel: string;
  /** 产出的文件；任务被丢弃时随之释放 */
  file?: { blob: Blob; filename: string };
  /** 产出这份文件时用的选项指纹，用来判断当前选项是否还和它对得上 */
  usedOptions?: string;
  /** 上一次导出被中止 */
  cancelled: boolean;
  /** 结果里有需要提醒的笔记（失败 / 跳过 / 取图失败…） */
  hasProblems: boolean;
  /** 对话框已收起，改由悬浮条接管 */
  minimized: boolean;
  /** 任务已作废（被替换 / 被关闭），异步流程见到它就自行收尾 */
  discarded: boolean;
}

/* ------------------------------------------------------------------ */
/* 注册表与订阅                                                        */
/* ------------------------------------------------------------------ */

const tasks: ExportTask[] = [];
const listeners = new Set<() => void>();
const finishedListeners = new Set<(task: ExportTask) => void>();
let nextId = 1;
/** 当前正在跑的任务 id；串行调度靠它保证同一时刻只有一个 */
let activeId: number | undefined;
/**
 * 正在跑的那个任务的**取消通道**。
 *
 * 中止就是 abort 它：下载中的请求当场作废，导出循环在下一个检查点退出 —
 * 不必再等某一次请求自己超时，也不必等一篇文章渲染完（见 `utils/abort.ts`）。
 * 生命周期跟着 `activeId`：`runTask()` 挂上，`finish()` 摘掉。
 */
let activeAbort: AbortController | undefined;

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 任务走到 done 时回调一次（用于“最小化后发通知”这类副作用） */
export function onTaskFinished(listener: (task: ExportTask) => void): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

export function notifyTasks(): void {
  listeners.forEach((listener) => listener());
}

/** 任务是否已经进入队列（草稿不算） */
export function isStarted(task: ExportTask): boolean {
  return task.phase === 'queued' || task.phase === 'running' || task.phase === 'done';
}

/** 需要出现在悬浮条上的任务：已开始 + 对话框没收着它 */
export function barTasks(): ExportTask[] {
  return tasks.filter((task) => task.minimized && isStarted(task));
}

export function patchTask(task: ExportTask, patch: Partial<ExportTask>): void {
  Object.assign(task, patch);
  notifyTasks();
}

/**
 * 关页面时的二次确认。
 *
 * 只在真有排队 / 运行中的任务时拦截 —— 导出全在页面里跑，刷新或关掉就全没了。
 * 文案由浏览器的原生弹窗给，我们只能决定“拦不拦”。
 */
window.addEventListener('beforeunload', (event) => {
  if (!tasks.some((task) => task.phase === 'queued' || task.phase === 'running')) return;
  event.preventDefault();
  // 部分浏览器（含 Chrome）仍然要求写 returnValue 才会弹
  event.returnValue = '';
});

/* ------------------------------------------------------------------ */
/* 任务生命周期                                                        */
/* ------------------------------------------------------------------ */

/** 新建一个任务（草稿态）。预检由调用方随后用 `scanTask()` 启动 */
export function createTask(notes: NoteRef[], trigger: string | undefined, options: ExportOptions): ExportTask {
  const task: ExportTask = {
    id: nextId++,
    notes,
    trigger,
    phase: 'scanning',
    options,
    plans: notes.map(() => undefined),
    rows: notes.map((note) => ({
      note,
      noteTypeLabel: '',
      outputExt: '.md',
      status: 'pending',
      tone: 'pending',
      state: '检查中…',
      problems: [],
    })),
    scannedCount: 0,
    tab: 'all',
    listScroll: { all: 0, issues: 0 },
    summary: '',
    progress: 0,
    progressText: '',
    downloadLabel: '',
    cancelled: false,
    hasProblems: false,
    minimized: false,
    discarded: false,
  };
  tasks.push(task);
  notifyTasks();
  return task;
}

/** 丢弃任务：草稿被替换、排队中被取消、结束后被关闭都走这里 */
export function discardTask(task: ExportTask): void {
  const index = tasks.indexOf(task);
  if (index === -1) return;
  task.discarded = true;
  task.file = undefined;
  tasks.splice(index, 1);
  notifyTasks();
}

/**
 * 取消任务。
 * 排队中的直接移出队列；运行中的 abort 掉取消通道 —— 在飞的请求当场作废、
 * 当前那一篇立刻作废，循环随即退出（不再等任何一次请求或一篇渲染跑完）。
 */
export function cancelTask(task: ExportTask): void {
  if (task.phase === 'running') {
    if (activeId === task.id) activeAbort?.abort();
    // 那一行的文案还停在“导出中…”（行状态只在逐篇结果里改），这里先把话说明白
    for (const row of task.rows) {
      if (row.status === 'running') row.state = '正在中止…';
    }
    patchTask(task, { progressText: '正在中止…' });
    return;
  }
  discardTask(task);
}

/** 预检：只读本地，不发请求。结果直接落到任务的 plans / rows 上 */
export function scanTask(task: ExportTask): void {
  void (async () => {
    for (const [index, note] of task.notes.entries()) {
      if (task.discarded) return;
      task.scannedCount = index;
      notifyTasks();
      try {
        task.plans[index] = await inspectNote(note);
      } catch (error) {
        log.warn('预检失败', note.docGuid, error);
        task.plans[index] = {
          note,
          noteType: 'Normal',
          noteTypeLabel: '未知类型',
          outputExt: '.md',
          source: 'remote',
        };
      }
      applyPlan(task, task.rows[index], task.plans[index]!);
      notifyTasks();
    }
    if (task.discarded) return;
    task.scannedCount = task.notes.length;
    // 只在还没被别的流程推着往前走时才落回 ready —— 预检是异步的，别把已经开跑的任务拽回来
    if (task.phase === 'scanning') patchTask(task, { phase: 'ready' });
  })();
}

/** 把任务放进队列。空闲时立刻开跑，否则等前面的任务结束 */
export function startTask(task: ExportTask): void {
  const phase = task.phase;
  if (phase === 'scanning' || phase === 'queued' || phase === 'running') return;

  task.cancelled = false;
  task.hasProblems = false;
  task.file = undefined;
  task.usedOptions = optionsKey(task.options);
  // 复位上一轮的行状态（“再次导出”会走到这里）
  task.rows.forEach((row, index) => {
    row.status = 'pending';
    row.progress = undefined;
    row.problems = [];
    const plan = task.plans[index];
    if (plan) applyPlan(task, row, plan);
  });

  patchTask(task, {
    phase: 'queued',
    tab: 'all',
    progress: 0,
    progressText: '排队中…',
    downloadLabel: '',
  });
  pump();
}

/** 串行调度：同时只跑一个任务 */
function pump(): void {
  if (activeId !== undefined) return;
  const next = tasks.find((task) => task.phase === 'queued');
  if (!next) return;
  activeId = next.id;
  void runTask(next);
}

async function runTask(task: ExportTask): Promise<void> {
  const abort = new AbortController();
  activeAbort = abort;
  patchTask(task, {
    phase: 'running',
    progress: 0,
    progressText: '准备中…',
    downloadLabel: '',
    cancelled: false,
  });

  let outcome: ExportOutcome;
  try {
    outcome = await exportNotes(task.notes, task.options, {
      signal: abort.signal,
      onProgress: (progress) => applyProgress(task, progress),
      onNoteDone: (result) => applyNoteDone(task, result),
      onPackaging: (progress) => applyPackaging(task, progress),
    });
  } catch (error) {
    log.error('导出失败', error);
    task.summary = `导出失败：${(error as Error).message}`;
    patchTask(task, { phase: 'done', progressText: `导出失败：${(error as Error).message}` });
    finish(task);
    return;
  }

  applyOutcome(task, outcome);
  // 自动下载只在正常完成时发生；中止时交回给用户点按钮，避免“喊停还弹下载”
  if (outcome.blob && !outcome.cancelled) saveBlob(outcome.blob, outcome.filename);
  patchTask(task, { phase: 'done' });
  finish(task);
}

function finish(task: ExportTask): void {
  if (activeId === task.id) {
    activeId = undefined;
    activeAbort = undefined;
  }
  finishedListeners.forEach((listener) => {
    try {
      listener(task);
    } catch (error) {
      log.warn('任务结束回调异常', error);
    }
  });
  pump();
}

/* ------------------------------------------------------------------ */
/* 行状态                                                              */
/* ------------------------------------------------------------------ */

/** 判断某篇是否属于“遇到问题”（失败 / 跳过 / 取图失败等） */
export function isProblem(row: TaskRow): boolean {
  return row.status === 'failed' || row.status === 'skipped' || row.problems.length > 0;
}

function applyPlan(task: ExportTask, row: TaskRow, plan: NotePlan): void {
  row.noteTypeLabel = plan.noteTypeLabel;
  row.outputExt = plan.outputExt;
  const allowNetworkFetch = task.options.allowNetworkFetch;
  switch (plan.source) {
    case 'local':
      row.state = '本地有数据';
      row.tone = 'local';
      break;
    case 'fallback-html':
      row.state = '转为原始 HTML';
      row.tone = 'fallback-html';
      break;
    default:
      row.state = allowNetworkFetch ? '本地无数据' : '本地无数据，跳过';
      row.tone = allowNetworkFetch ? 'remote' : 'skipped';
  }
}

/** 选项（尤其是“允许联网补全”）变了之后，用预检结果重算每行的状态文案 */
export function refreshPlanStates(task: ExportTask): void {
  task.rows.forEach((row, index) => {
    const plan = task.plans[index];
    if (plan) applyPlan(task, row, plan);
  });
}

function applyProgress(task: ExportTask, progress: ExportProgress): void {
  const { index, total, title, resourceDone, resourceTotal, attachmentDone, attachmentTotal, noteProgress } = progress;
  const row = task.rows[index - 1];
  if (row) {
    if (row.status !== 'running') {
      /*
       * 换篇了：把还挂着“导出中…”的行收回“待处理”。
       *
       * 逐篇结果现在是**结束即落地**的（`applyNoteDone`），所以正常情况下上一篇早就不是
       * running 了，这里只是兜底 —— 兜底时连文案一起收回，免得留一行永远写着“导出中…”。
       */
      for (const item of task.rows) {
        if (item.status === 'running') {
          item.status = 'pending';
          item.progress = undefined;
          item.tone = 'pending';
          item.state = '待处理';
        }
      }
      row.status = 'running';
      row.tone = 'running';
      row.state = '导出中…';
    }
    // 图片下完才下附件，同一时刻只有一组计数有值
    if (attachmentTotal) row.progress = `附件 ${attachmentDone ?? 0}/${attachmentTotal}`;
    else if (resourceTotal) row.progress = `图片 ${resourceDone ?? 0}/${resourceTotal}`;
    else row.progress = undefined;
  }

  /*
   * 整体进度 = “已经处理完的篇数 + 当前这一篇内部的比例”÷ 总篇数。
   *
   * 不能写成 `index / total`：`index` 是"正在处理第几篇"，最后一篇刚开头它就已经是
   * total/total，进度条提前满格（违背直觉）。而 `noteProgress` 是**干完一步才涨**的，
   * 所以这个值只会在真正推进时前进。
   * 99% 是刻意的上限：满格留给任务真的结束那一刻（见 `applyOutcome`）。
   */
  task.progress = overallProgress(index, total, noteProgress ?? 0);
  task.progressText = `正在处理 ${index}/${total} · ${title}`;
  notifyTasks();
}

/**
 * 收尾打包的进度。
 *
 * 这一段正是以前“点了中止之后卡住不动”的那几秒（正常完成时也要走）：打包是纯 CPU 活，
 * 现在由 `task.ts` / `archive.ts` 边打边报，界面至少说得出自己在干什么。
 *
 * **进度条不动**：整体进度最多 99%、被中止的停在原地，满格只留给任务真正结束的那一刻 ——
 * 所以这里只改文案，不碰 `task.progress`。
 */
function applyPackaging(task: ExportTask, progress: PackagingProgress): void {
  const { done, total, cancelled } = progress;
  const label = cancelled ? '正在打包已完成的部分' : '正在打包';
  patchTask(task, {
    progressText: done > 0 && done < total ? `${label} ${done}/${total}…` : `${label}…`,
  });
}

/**
 * 整体进度（0..100）。
 *
 * 纯函数、与 DOM 无关，单独拎出来是因为这条算法很容易被"顺手改回 `index / total`"：
 * 那样一开始处理最后一篇进度条就满了。跑的过程中**最多 99%**，满格只留给任务真的结束。
 *
 * @param index 正在处理第几篇（从 1 开始）
 * @param total 总篇数
 * @param noteProgress 这一篇内部已完成的比例（0..1，见 `ExportProgress.noteProgress`）
 */
export function overallProgress(index: number, total: number, noteProgress: number): number {
  const within = Math.min(1, Math.max(0, noteProgress));
  const ratio = (index - 1 + within) / Math.max(1, total);
  return Math.min(99, Math.round(ratio * 100));
}

/**
 * 一篇导出结束时立刻落到它那一行上（`task.ts` 的 `onNoteDone`）。
 *
 * 为什么不等收尾再统一刷：这一篇的结论在它结束那一刻就已经有了（`task.ts` 是逐篇 push 的），
 * 拖到整批结束才写，会让**已经导完的那几行一直停在“导出中…”** —— 几百篇时列表看着像卡住了
 * （而且是两行同时写着“导出中…”，根本分不清哪篇在跑）。落地的姿势与收尾完全一致，
 * 因为两边走的是同一个 `applyResultToRow()`。
 */
function applyNoteDone(task: ExportTask, result: NoteExportResult): void {
  const row = task.rows.find((item) => item.note === result.note);
  if (row) applyResultToRow(task, row, result);
  // “有问题”是任务级的展示值（悬浮条配色、问题页计数），跟着逐篇结果实时更新
  task.hasProblems = task.rows.some(isProblem);
  notifyTasks();
}

/**
 * 把**一篇**的结果写进它那一行：状态、配色、文案、问题清单。
 *
 * 逐篇落地（`applyNoteDone`）与收尾（`applyOutcome`）共用它 —— 两处各写一遍迟早会
 * 文案不一致（或漏掉某个新字段）。所以这里每次都先清空 `problems` 再按结果重建，
 * 同一个结果应用两次是幂等的（收尾那一次不会把问题清单写成双份）。
 */
function applyResultToRow(task: ExportTask, row: TaskRow, result: NoteExportResult): void {
  row.progress = undefined;
  row.problems = [];
  if (result.noteTypeLabel) row.noteTypeLabel = result.noteTypeLabel;

  if (result.status === 'failed') {
    row.status = 'failed';
    row.tone = 'failed';
    row.state = '导出失败';
    row.problems.push(result.detail || '未知错误');
    return;
  }
  if (result.status === 'skipped') {
    row.status = 'skipped';
    row.tone = 'skipped';
    row.state = '已跳过';
    row.problems.push(result.detail || '未说明原因');
    return;
  }

  row.status = 'ok';
  row.tone = 'ok';
  const bits = ['已导出'];
  if (result.imageRefs) bits.push(`图片 ${result.imagesSaved ?? 0}/${result.imageRefs}`);
  if (result.attachmentRefs) bits.push(`附件 ${result.attachmentsSaved ?? 0}/${result.attachmentRefs}`);
  if (result.comments) bits.push(`评论 ${result.comments} 条${result.commentsSidecar ? '（单独 .md）' : ''}`);
  if (result.htmlSidecar) bits.push('另附 HTML');
  if (result.metadataSidecar) bits.push('.meta.json');
  row.state = bits.join(' · ');

  // 图片失败分两笔写：正文缺图是真缺图；只为 HTML（另附 HTML / 产物本身就是 HTML）服务的
  // 站点皮肤、CSS 背景、字体缺了并不影响正文可读性 —— 混成一句会让用户对着完好的 .md 找破图。
  const failedInHtml = result.imagesFailedInHtml ?? 0;
  const failedInBody = (result.imagesFailed ?? 0) - failedInHtml;
  if (failedInBody > 0) {
    row.problems.push(`${failedInBody} 张图片没取到，Markdown 里的图片会显示不出来`);
  }
  if (failedInHtml > 0) {
    row.problems.push(
      result.htmlSidecar
        ? `${failedInHtml} 张图片只在另附的 HTML 里用到，没取到（Markdown 正文不受影响）`
        : `${failedInHtml} 张图片没取到，导出的 HTML 页面里会缺图`,
    );
  }
  if ((result.attachmentsFailed ?? 0) > 0) {
    row.problems.push(`${result.attachmentsFailed} 个附件没取到，Markdown 里的附件链接会指向不存在的文件`);
  }
  if (result.commentsError) {
    row.problems.push(`评论没能导出：${result.commentsError}`);
  }
  // 导出内核报上来的其他问题（如外链样式表取不到被移除）
  for (const problem of result.problems ?? []) row.problems.push(problem);
  if ((result.annotations ?? 0) > 0) {
    row.problems.push(
      `含 ${result.annotations} 层手写批注，Markdown 没有版面概念，承载不了` +
      (task.options.includeImages
        ? '（已按原始比例单独导出成 images/annotation-*.svg）'
        : '（本次选择了不导出图片，没有同时导出）'),
    );
  }
}

/** 把导出结果落到行上，并算出下载按钮与汇总文案 */
function applyOutcome(task: ExportTask, outcome: ExportOutcome): void {
  const resultByNote = new Map<NoteRef, NoteExportResult>();
  for (const result of outcome.results) resultByNote.set(result.note, result);

  for (const row of task.rows) {
    const result = resultByNote.get(row.note);
    if (!result) {
      row.progress = undefined;
      row.status = 'pending';
      row.tone = 'pending';
      row.state = outcome.cancelled ? '已中止，未处理' : '未处理';
      continue;
    }
    // 逐篇那会儿已经落过一次也没关系：同一个结果应用两次是幂等的（见 applyResultToRow）
    applyResultToRow(task, row, result);
  }

  const ok = outcome.results.filter((result) => result.status === 'ok').length;
  const skipped = outcome.results.filter((result) => result.status === 'skipped');
  const failed = outcome.results.filter((result) => result.status === 'failed');

  // 产出的 Blob 挂在任务上，随时可以再下一次（字节在浏览器的 blob storage 里，不在 JS 堆，
  // 口径见 docs/export-pipeline.md §1.9）；任务被关闭时连同它一起释放
  if (outcome.blob) task.file = { blob: outcome.blob, filename: outcome.filename };

  const parts = [`成功 ${ok} 篇`];
  if (skipped.length) parts.push(`跳过 ${skipped.length} 篇`);
  if (failed.length) parts.push(`失败 ${failed.length} 篇`);
  if (outcome.imageRefs > 0) parts.push(`图片 ${outcome.imagesSaved}/${outcome.imageRefs} 张`);
  if (outcome.attachmentRefs > 0) parts.push(`附件 ${outcome.attachmentsSaved}/${outcome.attachmentRefs} 个`);
  if (outcome.annotations > 0) parts.push(`手写批注 ${outcome.annotations} 层`);
  if (outcome.comments > 0) parts.push(`评论 ${outcome.comments} 条`);

  task.summary = parts.join(' · ');
  // 满格只在这一刻出现（跑的过程中最多 99%）；中止的话停下时到哪就是哪，那是有信息量的
  if (!outcome.cancelled) task.progress = 100;
  task.progressText = outcome.cancelled ? '已中止' : outcome.blob ? '已生成文件' : '没有可导出的内容';
  task.downloadLabel = outcome.blob ? (outcome.cancelled ? '下载已完成部分' : '重新下载') : '';
  task.cancelled = outcome.cancelled;
  task.hasProblems = task.rows.some(isProblem);
  // 有问题的笔记自动切到“问题”页
  task.tab = task.hasProblems ? 'issues' : 'all';
}

/* ------------------------------------------------------------------ */
/* 派生的展示值                                                        */
/* ------------------------------------------------------------------ */

/**
 * 当前选项的“指纹”。和产出文件时用的那份比对：
 * 不一致说明手上这份文件已经和界面上的选项对不上了，就不该再提供下载。
 */
export function optionsKey(options: ExportOptions): string {
  const metadata = options.exportMetadata;
  return [
    options.includeImages,
    options.includeAttachments,
    options.exportHtml,
    options.keepComments,
    options.allowNetworkFetch,
    metadata,
    // 元数据关掉时它下面两项不生效，不参与比对（同步界面上的置灰状态）
    metadata ? options.metadataFormat : '',
    metadata ? options.metadataRaw : '',
  ].join('|');
}

/**
 * 中止会丢掉什么：**还没处理完的篇数**。
 *
 * 中止后停在当前这一篇（它整个作废，见 §1.7），剩下的不再开始；已经导出的部分照旧打包
 * （§1.1，中止不自动下载）。所以那句后果里最要紧的就是“还有多少篇不会再处理”。
 *
 * 两个界面**共用这一句**：对话框底部的“中止”和悬浮条任务行上的“中止”是同一个动作，
 * 后果不因界面而异（与“关闭”那两句按界面分写的情况不同，那里说的是怎么移除）。
 */
export function abortConsequence(task: ExportTask): string {
  const left = task.rows.filter((row) => row.status === 'pending' || row.status === 'running').length;
  if (left <= 1) return '中止会丢掉正在导的这一篇；已经导出的部分会打包留给你下载。';
  return `中止后停在当前这一篇，另外 ${left - 1} 篇不会再处理；已经导出的部分会打包留给你下载。`;
}

/** 按选项把预检结果折算成“会导出几篇 / 会跳过几篇” */
export function describePlanSummary(task: ExportTask): string {
  if (task.notes.length === 1) return `共 1 篇 · 输出 ${task.rows[0]?.outputExt ?? '.md'}`;
  const plans = task.plans.filter((plan): plan is NotePlan => Boolean(plan));
  const counts = summarizePlans(plans, { allowNetworkFetch: task.options.allowNetworkFetch });
  const parts = [`共 ${task.notes.length} 篇`, `将导出 ${counts.willExport} 篇`];
  if (counts.willSkip > 0) parts.push(`将跳过 ${counts.willSkip} 篇`);
  if (counts.htmlCount > 0) parts.push(`${counts.htmlCount} 篇为原始 HTML`);
  return parts.join(' · ');
}
