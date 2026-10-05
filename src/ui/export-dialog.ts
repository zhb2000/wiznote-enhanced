import { config } from '../config';
import { saveBlob } from '../export/app-bridge';
import {
  abortConsequence,
  cancelTask,
  createTask,
  describePlanSummary,
  discardTask,
  isProblem,
  isStarted,
  notifyTasks,
  optionsKey,
  patchTask,
  refreshPlanStates,
  scanTask,
  startTask,
  subscribeTasks,
  type ExportTask,
  type TaskRow,
  type TaskTab,
} from '../export/session';
import type { ExportOptions, MetadataFormat, NoteRef } from '../export/types';
import { store } from '../store';
import { logger } from '../utils/log';
import { createConfirmRow } from './kit/confirm';
import { el } from './kit/el';
import { createModal, type ModalDismissSource } from './kit/modal';
import { getBarAnchor, type MorphRect } from './kit/morph';
import { setExportDialogOpen } from './panel/host';
import { showToast } from './toast';

const log = logger('dialog');

const P = config.prefix;

/**
 * 导出对话框 —— 一个**任务视图**。
 *
 * 任务本身（队列、进度、结果、产出文件）活在 `src/export/session.ts`，
 * 这里只负责把它画出来并接住交互。所以：
 *
 * - 对话框可以随时收起来（最小化），任务照跑，由悬浮条 `ui/export-tasks.ts` 接管；
 * - 同一时刻只开一个对话框 —— 新对话框出现时，旧的那个如果还是草稿就直接丢弃，
 *   已经开跑的就收起成悬浮条（这正是“上一个任务还在导出就能发起下一个”的实现方式）；
 * - 右上角的按钮对**所有已开始的任务**（排队 / 导出中 / 已结束）都是**最小化**：
 *   收起只是换个地方看，永远不会毁掉跑了几分钟的批量导出，也不会放掉产出的文件；
 * - 不可逆的动作只留给底部按钮（中止 / 关闭），而**它俩都要先过一次二次确认行** ——
 *   中止会丢掉还没处理的那几十篇，关闭会清掉这批导出记录与产出的文件（§1.1、§1.2）。
 *   确认行是共享控件（`ui/kit/confirm.ts`），挂在按钮行正上方而不是屏幕另一头，
 *   每个决策各占一条（一次只有一个是真的待决）。
 *
 * 它和悬浮条是**同一个任务的两个地方**，所以换地方要有交代（见 `kit/morph.ts`）：入场从
 * 悬浮条最后落位的地方长出来，最小化时收回去（销毁的路径不收回，见 `closeDialog`）。
 * 那几段补间只是动画，任务状态与关闭手势的裁决一点都不受影响。
 */

/** 全局唯一的对话框句柄 */
let active: { task: ExportTask; close: () => void } | undefined;

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 右键菜单入口：新建一个导出任务（草稿态），并打开它的对话框 */
export function openExportDialog(notes: NoteRef[], trigger?: string): void {
  if (notes.length === 0) {
    showToast('没有可导出的笔记', 'error');
    return;
  }
  closeActiveDialog();
  const task = createTask(notes, trigger, optionsFromStore());
  buildDialog(task);
  scanTask(task);
}

/** 从悬浮条点进来：重新打开某个已有任务的对话框 */
export function openTaskDialog(task: ExportTask): void {
  if (task.discarded) return;
  if (active?.task === task) return;
  closeActiveDialog();
  task.minimized = false;
  buildDialog(task);
  notifyTasks();
}

/** 把当前对话框收走（草稿丢弃；已开始的收成悬浮条），不动 DOM 之外的东西 */
function closeActiveDialog(): void {
  if (!active) return;
  const { task, close } = active;
  active = undefined;
  close();
  if (isStarted(task)) {
    task.minimized = true;
    notifyTasks();
  } else {
    discardTask(task);
  }
}

/** 选项的默认值来自持久化设置；任务开始后会把当前值写回去 */
function optionsFromStore(): ExportOptions {
  return {
    includeImages: store.get('exportIncludeImages'),
    includeAttachments: store.get('exportIncludeAttachments'),
    keepComments: store.get('exportKeepComments'),
    allowNetworkFetch: store.get('exportAllowNetworkFetch'),
    exportMetadata: store.get('exportMetadata'),
    metadataFormat: store.get('exportMetadataFormat'),
    metadataRaw: store.get('exportMetadataRaw'),
    exportHtml: store.get('exportHtml'),
  };
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

/** 行 DOM 的引用，用于就地更新（避免每次重绘重建整张列表） */
interface RowRefs {
  li: HTMLLIElement;
  title: HTMLElement;
  out: HTMLElement;
  type: HTMLElement;
  state: HTMLElement;
  progress: HTMLElement;
  problems: HTMLUListElement;
}

function buildDialog(task: ExportTask): void {
  const multi = task.notes.length > 1;
  let closed = false;

  /*
   * 外框（遮罩 / 头部 / × / Esc / 底部插槽）全部来自共享模态壳：
   * 关闭手势的裁决交给 `handleDismiss()` —— 已开始的任务一律最小化，草稿才真的丢掉。
   */
  const modal = createModal({
    title: multi ? `导出 ${task.notes.length} 篇笔记为 Markdown` : '导出为 Markdown',
    dialogClass: `${P}-export-dialog`,
    /*
     * 入场：从悬浮条最后落位的地方长出来（“它就是刚才那条悬浮条”）。
     * 悬浮条这会儿已经被藏起来了，量不到自己 —— 所以取的是它落位时报给 `kit/morph.ts`
     * 的锚点；没有悬浮条（第一次导出、上一轮任务早已收摊）时是 `null`，退化成原地淡入。
     */
    origin: getBarAnchor(),
    onDismiss: handleDismiss,
  });

  // 顶部横幅只放通知：提醒“右上角那个按钮现在已经是最小化了”
  const bannerText = el('span', `${P}-modal-banner-text`);
  modal.banner.append(bannerText);

  /*
   * 底部两个不可逆动作（中止 / 关闭）各有一条确认行，都是那个共享控件
   * （`ui/kit/confirm.ts`）：点的是底部按钮，反馈就出现在按钮行正上方，
   * 不用用户把视线挪到屏幕另一头。
   *
   * ⚠️ **一个决策一条**、别想着合并成一条复用的：两条的后果、执行按钮、不做按钮
   * 全都不一样（中止问的是“丢掉还没处理的那几十篇”，关闭问的是“清掉记录与文件”），
   * 复用得把控件改成“谁最后打开的算谁的”，那正是 §1.6 反对的隐性规则。
   * 好在两者天然互斥 —— 中止只在跑着时有意义、关闭只在结束之后（见 render 里的作废规则），
   * 所以屏幕上任何时刻最多只有一条露着头。
   *
   * 说明里都会随状态变（“有没有文件可下载”“还剩几篇”），所以开之前各重设一次文案。
   */
  const confirmClose = createConfirmRow({
    message: closeConsequence(false),
    confirmLabel: '确定关闭',
    cancelLabel: '继续查看',
    onConfirm: closeAndDiscard,
  });
  const confirmAbort = createConfirmRow({
    message: abortConsequence(task),
    confirmLabel: '确定中止',
    cancelLabel: '继续导出',
    onConfirm: () => cancelTask(task),
  });
  modal.notice.append(confirmClose.el, confirmAbort.el);

  /* 左栏：笔记列表 + “问题”页 */
  const paneList = el('div', `${P}-export-pane-list`);
  const tabBar = el('div', `${P}-export-tabs`);
  const tabAll = el('button', `${P}-export-tab`);
  const tabIssues = el('button', `${P}-export-tab`);
  tabAll.type = 'button';
  tabIssues.type = 'button';
  tabIssues.hidden = true;
  tabBar.append(tabAll, tabIssues);
  const listScroll = el('div', `${P}-export-list-scroll`);
  const listRows = el('ul', `${P}-export-rows`);
  listScroll.append(listRows);
  paneList.append(tabBar, listScroll);

  /* 右栏：摘要 + 选项 */
  const side = el('aside', `${P}-export-side`);
  const summaryEl = el('div', `${P}-export-summary`);
  side.append(summaryEl);
  if (task.trigger) side.append(el('div', `${P}-export-sub`, `来源：${task.trigger}`));
  side.append(el('div', `${P}-export-section`, '导出选项'));

  type BooleanOptionKey =
    | 'includeImages'
    | 'includeAttachments'
    | 'keepComments'
    | 'allowNetworkFetch'
    | 'exportMetadata'
    | 'metadataRaw'
    | 'exportHtml';

  const addOption = (label: string, key: BooleanOptionKey, hint?: string): HTMLInputElement => {
    const wrap = el('label', `${P}-export-option`);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = task.options[key];
    // 说明单独占一行：右栏只有 300 多 px，和标题挤在一行两边都会被压窄
    const text = el('span', `${P}-export-option-text`);
    text.append(el('span', undefined, label));
    if (hint) text.append(el('span', `${P}-export-option-hint`, hint));
    wrap.append(input, text);
    side.append(wrap);
    // 选项一变就重绘：导出结束后要据此决定还能不能“重新下载”
    input.addEventListener('change', () => {
      task.options[key] = input.checked;
      syncMetadataControls();
      notifyTasks();
    });
    return input;
  };

  const imageInput = addOption('把图片下载到 images/ 目录', 'includeImages', '关闭后 Markdown 里保留原始地址');
  const attachmentInput = addOption('把附件下载到 attachments/ 目录', 'includeAttachments', 'PDF / Office 文档等上传的文件；正文没引用的会列到文末');
  const commentInput = addOption('包含评论', 'keepComments', '在文末追加“评论”章节；协作笔记会引用被评论的原文');

  const metadataInput = addOption('导出笔记元数据', 'exportMetadata', '时间、分类、标签、来源链接');
  const formatRow = el('label', `${P}-export-option ${P}-export-option-nested`);
  formatRow.append(el('span', undefined, '元数据形态'));
  const formatSelect = document.createElement('select');
  for (const [value, text] of [
    ['yaml', 'YAML front matter'],
    ['json', '同名 .meta.json'],
  ] as [MetadataFormat, string][]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    formatSelect.append(option);
  }
  formatSelect.value = task.options.metadataFormat;
  formatSelect.addEventListener('change', () => {
    task.options.metadataFormat = formatSelect.value as MetadataFormat;
    notifyTasks();
  });
  formatRow.append(formatSelect);
  side.append(formatRow);

  const rawInput = addOption('附带 WizNote 原始字段', 'metadataRaw', '供排查');
  rawInput.parentElement?.classList.add(`${P}-export-option-nested`);

  // 元数据关掉时，下面两项跟着变灰，避免看起来还在生效
  function syncMetadataControls(): void {
    const on = task.options.exportMetadata;
    formatSelect.disabled = !on;
    rawInput.disabled = !on;
    formatRow.classList.toggle(`${P}-export-option-disabled`, !on);
    rawInput.parentElement?.classList.toggle(`${P}-export-option-disabled`, !on);
  }

  const networkInput = addOption('允许联网补全本地没有的笔记', 'allowNetworkFetch', '关闭后这些笔记会被跳过');
  const htmlInput = addOption('同时导出原始 HTML', 'exportHtml', '只对需要从 HTML 反推 Markdown 的笔记生效');
  networkInput.addEventListener('change', () => {
    refreshPlanStates(task);
    notifyTasks();
  });

  /* 主体：左列表 / 右选项 */
  const main = el('div', `${P}-export-main`);
  main.append(paneList, side);

  /* 底部：进度 + 操作 */
  const progress = el('div', `${P}-export-progress`);
  const barInner = el('i');
  const bar = el('div', `${P}-export-bar`);
  bar.append(barInner);
  const progressText = el('div', `${P}-export-progress-text`);
  progress.append(bar, progressText);
  const actions = el('div', `${P}-export-actions`);
  const cancelBtn = el('button', `${P}-btn`, '取消');
  const startBtn = el('button', `${P}-btn ${P}-btn-primary`, '正在检查…');
  const downloadBtn = el('button', `${P}-btn ${P}-btn-primary`, '重新下载');
  cancelBtn.type = 'button';
  startBtn.type = 'button';
  downloadBtn.type = 'button';
  startBtn.disabled = true;
  downloadBtn.hidden = true;
  // 顺序：关闭 / 再次导出 / 重新下载（产出文件后，下载才是主角）
  actions.append(cancelBtn, startBtn, downloadBtn);

  // 主体与底部都塞进模态壳的插槽
  modal.body.append(main);
  modal.foot.append(progress, actions);

  /* ---------------- 渲染 ---------------- */

  let rowRefs: RowRefs[] = [];
  let renderedItems: TaskRow[] = [];
  /** 上一次渲染时左边的页签 —— 用它区分“换页签”和“同一页签但条目变了” */
  let renderedTab: TaskTab = task.tab;
  /**
   * 这份 DOM 里的列表是否已经渲染过至少一次。
   *
   * 首次渲染时列表是刚建出来的、`scrollTop` 恒为 0 —— 那一刻**不能**把它存回去，否则每次
   * 从悬浮条重新打开都会用 0 抹掉上次记住的位置（实测踩过）。要存的只有“用户真的滚过”的
   * 那些时刻。
   */
  let renderedOnce = false;

  function buildRow(): RowRefs {
    const li = el('li', `${P}-export-row`);

    const mainEl = el('div', `${P}-export-row-main`);
    const title = el('span', `${P}-export-row-title`);
    const out = el('span', `${P}-export-row-out`);
    mainEl.append(title, out);

    const sub = el('div', `${P}-export-row-sub`);
    const type = el('span', `${P}-export-row-type`);
    const state = el('span', `${P}-export-row-state`);
    const progressEl = el('span', `${P}-export-row-progress`);
    sub.append(type, el('span', `${P}-export-row-sep`, '·'), state, progressEl);

    const problems = el('ul', `${P}-export-row-problems`);
    problems.hidden = true;

    li.append(mainEl, sub, problems);
    return { li, title, out, type, state, progress: progressEl, problems };
  }

  function updateRow(refs: RowRefs, row: TaskRow, withProblems: boolean): void {
    const title = row.note.title || '未命名笔记';
    refs.title.textContent = title;
    refs.title.title = title;
    refs.out.textContent = row.outputExt;
    refs.type.textContent = row.noteTypeLabel || '类型未知';
    refs.state.textContent = row.state;
    refs.state.className = `${P}-export-row-state ${P}-export-row-state-${row.tone}`;
    refs.progress.textContent = row.progress ?? '';
    refs.progress.hidden = !row.progress;

    refs.problems.replaceChildren();
    refs.problems.hidden = !(withProblems && row.problems.length > 0);
    if (!refs.problems.hidden) {
      for (const problem of row.problems) refs.problems.append(el('li', undefined, problem));
    }
  }

  /**
   * 视口顶部那一行，以及它相对列表上沿的位置。
   *
   * 重建列表时拿它当锚点：重建之后把这一行放回**同一个位置**，新条目插在它上面也不会把
   * 视口内容顶走。没有可见行（空列表 / 首次渲染）时给 `undefined`。
   */
  function captureAnchor(): { row: TaskRow; offset: number } | undefined {
    const top = listScroll.getBoundingClientRect().top;
    for (let i = 0; i < rowRefs.length; i++) {
      const rect = rowRefs[i].li.getBoundingClientRect();
      if (rect.bottom > top) return { row: renderedItems[i], offset: rect.top - top };
    }
    return undefined;
  }

  /**
   * 列表重建之后把滚动位置放回去。
   *
   * 为什么必须自己接住：`replaceChildren` 只负责换节点，浏览器不会替我们记住“看到哪儿了”
   * —— 它只会把 `scrollTop` 夹进新内容的范围（新内容比视口矮就直接夹成 0，也就是回顶）。
   *
   * 两种意图分开处理：
   * - **锚点行还在新列表里**（同一页签下问题页长出新条目）：让它回到原位 —— 加回差值即可；
   * - **锚点行不在**（换了页签、或那一行被移出列表）：落回该页签自己存档的位置。
   */
  function restoreScroll(anchor: { row: TaskRow; offset: number } | undefined, items: TaskRow[]): void {
    const index = anchor ? items.indexOf(anchor.row) : -1;
    if (anchor && index >= 0) {
      const top = listScroll.getBoundingClientRect().top;
      const now = rowRefs[index].li.getBoundingClientRect().top - top;
      listScroll.scrollTop += now - anchor.offset;
      return;
    }
    listScroll.scrollTop = task.listScroll[task.tab] ?? 0;
  }

  function renderList(): void {
    const issues = task.rows.filter(isProblem);
    // 问题页空了就落回“笔记”页：否则两个页签都没有选中态，列表还渲染成空的
    if (task.tab === 'issues' && issues.length === 0) task.tab = 'all';

    tabAll.textContent = `笔记 ${task.rows.length}`;
    tabIssues.hidden = issues.length === 0;
    tabIssues.textContent = `问题 ${issues.length}`;
    tabAll.classList.toggle(`${P}-export-tab-active`, task.tab === 'all');
    tabIssues.classList.toggle(`${P}-export-tab-active`, task.tab === 'issues');

    const items = task.tab === 'issues' ? issues : task.rows;
    const sameSet = items.length === renderedItems.length && items.every((row, i) => row === renderedItems[i]);
    if (!sameSet) {
      /*
       * 只有重建这一条路会丢位置，所以两个动作都放在这里：
       * 先把当前偏移落回**它所属的那个页签**（换页签时这正是旧页签），再重建、再还原。
       * 别改成每次 render 都读一遍 `scrollTop` —— 那会每 60ms 强制一次布局。
       */
      const anchor = task.tab === renderedTab ? captureAnchor() : undefined;
      // 首次渲染的 scrollTop 是“刚建出来”的 0，不是用户的位置 —— 别拿它覆盖存档
      if (renderedOnce) task.listScroll[renderedTab] = listScroll.scrollTop;
      rowRefs = items.map(() => buildRow());
      listRows.replaceChildren(...rowRefs.map((refs) => refs.li));
      renderedItems = items.slice();
      renderedTab = task.tab;
      renderedOnce = true;
      restoreScroll(anchor, items);
    }
    items.forEach((row, index) => updateRow(rowRefs[index], row, task.tab === 'issues'));
  }

  /**
   * 任务一旦进入队列，选项就冻结了（它们是开跑那一刻的快照）。
   * 结束之后也不重新解锁 —— 想换选项就“再次导出”，那会产出另一份文件。
   */
  function renderOptions(): void {
    const locked = task.phase === 'queued' || task.phase === 'running';
    for (const input of [imageInput, attachmentInput, commentInput, metadataInput, networkInput, htmlInput]) {
      input.disabled = locked;
    }
    if (locked) {
      formatSelect.disabled = true;
      formatRow.classList.add(`${P}-export-option-disabled`);
      rawInput.parentElement?.classList.add(`${P}-export-option-disabled`);
    } else {
      syncMetadataControls();
    }
  }

  function summarize(): string {
    if (task.phase === 'scanning') {
      const done = Math.min(task.scannedCount + 1, task.notes.length);
      return `共 ${task.notes.length} 篇 · 正在检查本地内容… ${done}/${task.notes.length}`;
    }
    if (task.phase === 'done') return task.summary;
    return describePlanSummary(task);
  }

  /** 横幅上的常驻提示：解释右上角那个按钮此刻的含义（每个阶段都不一样） */
  function minimizeHint(): string {
    if (task.phase === 'queued') return '前面还有任务在跑，这里排队等待；可以点右上角的 − 收起来，排队不会断。';
    if (task.phase === 'running') return '导出在后台继续；可以点右上角的 − 收起来去忙别的，导出不会中断。';
    return '这批结果会留在悬浮条里；点右上角的 − 收起来，之后还能回来下载。';
  }

  /** 右上角按钮的 tooltip：比横幅那句更短，只说“点下去会怎样” */
  function minimizeTitle(): string {
    if (task.phase === 'queued') return '最小化到悬浮条，排队不会断';
    if (task.phase === 'running') return '最小化到悬浮条，导出不会中断';
    return '最小化到悬浮条，结果与文件都留着';
  }

  /**
   * 底部那个按钮的 tooltip：会丢东西的按钮都得能先 hover 出后果来。
   *
   * 措辞与悬浮条上那几个同名按钮对齐（`ui/export-tasks.ts` 的 `actionSpecs`）——
   * 同一件事在两处不该有两种说法。它跟着按钮文案一起在 `render()` 里更新，别写死。
   */
  function cancelHint(): string {
    if (task.phase === 'running') return '中止这次导出；已经导出的部分会保留';
    if (task.phase === 'queued') return '把它从队列里去掉，不会开始导出';
    if (task.phase === 'done') return '清掉这批导出记录和已生成的文件；还没下载的话先下载';
    return '丢弃这个草稿，不会开始导出';
  }

  /**
   * 二次确认行的文案：把“关闭会掉什么”说全。
   *
   * 产物是一份挂在任务上的 Blob（§1.1；字节在浏览器的 blob storage 里、不在 JS 堆），
   * 没下载就关掉就真没了 ——
   * 所以有文件时必须点名这件事，否则用户会以为记录清掉了文件还在。
   * 只有下载按钮真的在（选项没被改过）时才劝人先下载，不然是句空话。
   */
  function closeConsequence(canDownload: boolean): string {
    if (!task.file) return '关闭会清掉这批导出记录。';
    return canDownload
      ? '关闭会清掉这批导出记录和已生成的文件，还没下载的话，先下载再关。'
      : '关闭会清掉这批导出记录和已生成的文件。';
  }

  /** 唯一的渲染入口：所有 DOM 更新都从这里走 */
  function render(): void {
    if (closed) return;
    if (task.discarded) {
      closeDialog();
      return;
    }

    summaryEl.textContent = summarize();
    renderList();
    renderOptions();

    /*
     * 进度区“有事可报”的时候才出现：
     * - 扫描中：拿不出百分比（预检的篇数在右栏摘要里），用不确定进度条表示“在动”
     *   —— 那一段最像“没反应”，空槽跟卡住了一模一样（见 panel.css 的 `-indeterminate`）；
     * - 导出中：确定进度；
     * - 结束之后：`progressText` 还留着最后一句（“已生成文件”“已中止”），这条进度留着当结论。
     */
    const scanning = task.phase === 'scanning';
    progress.hidden = !scanning && task.phase !== 'running' && !task.progressText;
    bar.classList.toggle(`${P}-export-bar-indeterminate`, scanning);
    // 不确定进度的宽度由 CSS 给，这里必须把内联宽度**撤掉** —— 内联会盖过那条规则
    barInner.style.width = scanning ? '' : `${task.progress}%`;
    progressText.textContent = task.progressText;

    /*
     * 阶段一变（比如确认行亮着时点了“再次导出”、或者中止真的生效了），那条没意义的确认行
     * 立刻作废 —— 每条只在自己那个阶段里有意义：关闭只在结束之后、中止只在跑着时。
     * 顺带把触发按钮上的 `aria-disabled` / `aria-controls` 解掉（`close()` 里做）。
     */
    if (task.phase !== 'done') confirmClose.close();
    if (task.phase !== 'running') confirmAbort.close();

    /*
     * 已开始的任务（排队 / 导出中 / 已结束），右上角一律是“最小化”。
     * 收起是无副作用的动作，随手点错也没有代价：任务还在，悬浮条上点得回来。
     * 唯一的不可逆出口是底部那个文案明确的按钮。
     */
    const minimize = isStarted(task);
    modal.closeButton.textContent = minimize ? '–' : '×';
    modal.closeButton.setAttribute('aria-label', minimize ? '最小化' : '关闭并丢弃草稿');
    modal.closeButton.title = minimize ? minimizeTitle() : '关闭并丢弃这个草稿';

    // 两槽各管一件事，所以不再互斥：底部亮着确认行时，顶部那条提示照旧挂着
    // 显隐交给壳（`setBanner`）：它自己判“状态变没变”“该不该补间”，这里每帧调一次即可
    bannerText.textContent = minimizeHint();
    modal.setBanner(minimize);

    if (task.phase === 'scanning') {
      startBtn.disabled = true;
      startBtn.textContent = '正在检查…';
    } else if (task.phase === 'queued') {
      startBtn.disabled = true;
      startBtn.textContent = '排队中…';
    } else if (task.phase === 'running') {
      startBtn.disabled = true;
      startBtn.textContent = '导出中…';
    } else {
      startBtn.disabled = false;
      startBtn.textContent = task.phase === 'done' ? '再次导出' : '开始导出';
    }

    cancelBtn.textContent =
      task.phase === 'running' ? '中止' : task.phase === 'queued' ? '取消排队' : task.phase === 'done' ? '关闭' : '取消';
    cancelBtn.title = cancelHint();

    /*
     * 下载按钮的前提是“手上这份文件 = 当前选项会产出的东西”。
     * 选项改过（指纹变了）就只留“再次导出”—— 否则用户会以为下载的是新选项的结果。
     */
    const downloadReady = task.downloadLabel !== '' && task.usedOptions === optionsKey(task.options);
    downloadBtn.hidden = !downloadReady;
    downloadBtn.textContent = task.downloadLabel;
    // 有文件可下载时，下载才是主按钮，“再次导出”降为普通样式
    startBtn.classList.toggle(`${P}-btn-primary`, !downloadReady);
  }

  /* ---------------- 交互 ---------------- */

  /**
   * 收起对话框（带动画）。
   *
   * `to` 是**退场的落点**：给了就把对话框收成那个矩形 —— 也就是“回悬浮条那儿去”；
   * 不给就原地缩小淡出，用于真的把东西扔掉的路径。
   *
   * 那一层的显隐（`setExportDialogOpen(false)`）要**等对话框收完**再放出来：早放一秒，
   * 悬浮条就会和正在收起的对话框同时亮着。收完再放，接力的读感才是“进去了一条”。
   */
  function closeDialog(to?: MorphRect | null): void {
    if (closed) return;
    /*
     * 最后一个写入点：这就收起来了，DOM 一会儿就被摘掉，位置得在**这一刻**落回任务上。
     * 它是“最小化后从悬浮条点回来还能接着看”的那一半（另一半在 `renderList()` 的还原）。
     */
    task.listScroll[task.tab] = listScroll.scrollTop;
    closed = true;
    unsubscribe();
    const wasCurrent = active?.task === task;
    if (wasCurrent) active = undefined;
    void modal.close(to).then(() => {
      // 这段时间里可能已经有下一个对话框顶上来了（`active` 又有人）：那就让它继续占着
      if (wasCurrent && !active) setExportDialogOpen(false);
    });
  }

  /**
   * 收起对话框，任务留在队列/后台继续跑，由悬浮条接管。
   *
   * ⚠️ **顺序不能反**：先把任务交给悬浮条（`notifyTasks()` 让它就位），再收起对话框。
   * 第一次把任务收进去时悬浮条是**这一刻**才被建出来的，而对话框“收过去”正需要它落定的
   * 盒子当落点（`kit/morph.ts` 的接力锚点）—— 反过来写的话，锚点还是 `null`，收起动画就
   * 只会原地缩一下，指不出它收到哪儿去了（实测踩过：合并版悬浮条看着有方向、单任务版没有，
   * 差别只在这里 —— 合并版那时悬浮条早就存在于屏幕上了）。
   */
  function minimize(): void {
    task.minimized = true;
    notifyTasks();
    closeDialog(getBarAnchor());
  }

  /**
   * 真的丢掉这个任务：草稿被取消、结束后被确认关闭，都走这里。
   *
   * 这条路径**不给退场落点** —— 东西是真的没了，没有“回哪儿去”这回事，
   * 原地缩小淡出才是对的（收向悬浮条反而像“它还在那边等着”）。
   */
  function closeAndDiscard(): void {
    closeDialog();
    discardTask(task);
  }

  /**
   * 右上角按钮与 Esc 的统一裁决：
   *
   * | 阶段 | 行为 |
   * | --- | --- |
   * | 检查中 / 待导出（草稿） | 丢弃草稿并关闭 |
   * | 排队中 / 导出中 / 已结束 | **最小化**（一个字节都不丢） |
   * | 二次确认行亮着时按 Esc | 先收起确认行，停在对话框里 |
   *
   * 不可逆的动作只留给底部那个文案明确的按钮：中止（跑着）与关闭（结束），
   * 而**两个都要先亮一条确认行**（§1.2）—— 中止丢的是还没处理的那几十篇，
   * 关闭丢的是这批记录与产出的文件，都得让用户看到后果再决定。
   */
  function handleDismiss(source: ModalDismissSource): void {
    // Esc 是“反悔”的手势：确认行亮着时先收它，别顺手把任务也收走
    // （两条都调一遍：没亮的那条 `close()` 是空操作，省得这里再判一次“亮的是哪条”）
    if (source === 'escape' && (confirmClose.isOpen() || confirmAbort.isOpen())) {
      confirmClose.close();
      confirmAbort.close();
      return;
    }
    if (isStarted(task)) {
      minimize();
      return;
    }
    closeAndDiscard();
  }

  /**
   * 底部按钮：导出中是“中止”（**要先确认**）、排队中是“取消排队”（不必）、
   * 结束后是“关闭”（**要先确认**）、草稿是“取消”（不必）。
   *
   * 分界线是“这一下会不会丢掉已经产生的东西”：中止丢掉还没处理的那几十篇与当前这一篇，
   * 关闭丢掉记录 + 产出文件，都得问一句；排队中与草稿什么都还没产出（草稿更是点 × /
   * 按 Esc 也一样即点即弃，三种手势同义），拦一道只会让人多点一下（§1.2）。
   */
  function cancelOrClose(): void {
    if (task.phase === 'running') {
      // 中止 = 停在这儿，后面的篇数不会再处理：亮出确认行，把“会掉什么”说白
      confirmAbort.setMessage(abortConsequence(task));
      confirmAbort.open(cancelBtn);
      return;
    }
    if (task.phase === 'queued') {
      cancelTask(task);
      return;
    }
    if (task.phase === 'done') {
      // 关闭 = 清掉这批导出记录（含产出的文件）：亮出确认行，把“会掉什么”说白
      const canDownload = task.downloadLabel !== '' && task.usedOptions === optionsKey(task.options);
      confirmClose.setMessage(closeConsequence(canDownload));
      confirmClose.open(cancelBtn);
      return;
    }
    closeAndDiscard();
  }

  cancelBtn.addEventListener('click', cancelOrClose);
  downloadBtn.addEventListener('click', () => {
    if (task.file) saveBlob(task.file.blob, task.file.filename);
  });
  // 点空白**不关闭**弹窗：这是最容易误触的手势（尤其中途一慌就乱点），
  // 遮罩只负责挡住下层页面，所以这里不挂事件。
  tabAll.addEventListener('click', () => patchTask(task, { tab: 'all' }));
  tabIssues.addEventListener('click', () => patchTask(task, { tab: 'issues' }));

  startBtn.addEventListener('click', () => {
    const phase = task.phase;
    if (phase === 'scanning' || phase === 'queued' || phase === 'running') return;

    // 把当前选项写回设置，下次打开对话框时沿用
    store.set('exportIncludeImages', task.options.includeImages);
    store.set('exportIncludeAttachments', task.options.includeAttachments);
    store.set('exportKeepComments', task.options.keepComments);
    store.set('exportAllowNetworkFetch', task.options.allowNetworkFetch);
    store.set('exportMetadata', task.options.exportMetadata);
    store.set('exportMetadataRaw', task.options.metadataRaw);
    store.set('exportHtml', task.options.exportHtml);
    store.set('exportMetadataFormat', task.options.metadataFormat);
    log.info('导出任务已提交', { notes: task.notes.length, phase });

    startTask(task);
  });

  const unsubscribe = subscribeTasks(render);
  active = { task, close: closeDialog };
  // 占住“当前对话框”这个位置的同时把悬浮条藏起来，两件事永远同进同出
  setExportDialogOpen(true);
  render();
}
