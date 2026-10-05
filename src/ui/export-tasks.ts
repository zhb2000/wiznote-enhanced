import { config } from '../config';
import { saveBlob } from '../export/app-bridge';
import {
  abortConsequence,
  barTasks,
  cancelTask,
  discardTask,
  onTaskFinished,
  subscribeTasks,
  type ExportTask,
} from '../export/session';
import { store } from '../store';
import { openTaskDialog } from './export-dialog';
import { createConfirmRow, type ConfirmRow } from './kit/confirm';
import { el } from './kit/el';
import { focusedElement } from './kit/focus';
import { morphIn, morphOut, morphRectOf, motionEase, motionMs, setBarAnchor, setRevealed } from './kit/morph';
import { sendSystemNotification } from './notify';
import { getOverlayRoot, onExportDialogOpenChange } from './panel/host';
import { showToast } from './toast';

const P = config.prefix;

/**
 * 最小化之后的**导出任务悬浮条**（默认右下角，可拖动）。
 *
 * 它是“后台导出”的可见形态：对话框一收起，任务并没有消失，而是变成这里的内容继续跑。
 *
 * 版面是**一套槽位两种形态**：
 *
 * ```
 * ┌────────────────────────────────┐
 * │              ────              │  ← 把手条：唯一的拖拽面，两种形态外观完全一致
 * ├────────────────────────────────┤
 * │ 导出任务 2 个 · 1 个进行中   ⌄ │  ← 分组行（仅多任务）：整行可点 = 展开 / 折叠
 * ├────────────────────────────────┤
 * │ 导出中   正在处理 2/5 · 标题    │  ← 任务行：点它打开对话框
 * │ [中止]                         │
 * │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░       │
 * └────────────────────────────────┘
 * ```
 *
 * 单任务时没有分组行，把手条下面直接就是任务行（多任务只是多一层“一组”的概念：
 * 计数 + 折叠开关，那才有内容可放）。
 *
 * **导出对话框开着时，整条会被 CSS 藏起来**（`panel.css` 的 `:host(.wze-dialog-open)`，
 * class 由 `ui/panel/host.ts` 的 `setExportDialogOpen()` 落在遮罩宿主上）—— 那时候它就在
 * 对话框旁边晃，纯属抢注意力。藏起来不动任何状态：任务照跑，位置、展开状态、确认行都留在
 * 原地，对话框一关就回到原处。
 *
 * 它和对话框是**一个东西换地方**，所以换的时候要有交代（见 `kit/morph.ts`）：落位时报一次
 * 自己的盒子（对话框据此知道从哪来、回哪去），对话框收完的那一刻自己补一段出场，
 * 双击把手则飞回原位。这三件事都只是补间，不改任何状态。
 *
 * ⚠️ 贯穿这份文件的一条设计约束：**一个像素只承诺一个手势**。
 * 把手条只拖、分组行只开关、任务行只打开详情、按钮只干自己的事 —— 四者互不重叠。
 * 所以“拖拽之后紧跟的那次 click”不需要任何拦截：它落在没有监听器的地方。
 *
 * 键盘上是同一张图：拖动没有键盘等价物（退路是双击把手，见下），其余三处都可达 ——
 * 分组行 / 汇总行 / 任务行各自可聚焦、Enter 与 Space 等价于点击（焦点圈在 `panel.css`），
 * 行内按钮本来就是按钮。
 * （反过来，只要拖拽面和可点元素重叠，就得靠 `pointer capture` / 吞 click / 渲染不重建
 * 这类机制去救，都是踩过坑的，见 docs/export-pipeline.md §1.5。）
 *
 * 唯一的例外是任务里的**确认行**：它长在“点一下打开对话框”的任务行内部，所以整块吞掉
 * click（`ui/kit/confirm.ts` 里做的，不是这里）。任务行上那两个会丢东西的按钮 ——
 * 跑着时的“中止”与结束后的“关闭” —— 都会就地展开各自那条确认行（§1.2）：
 * 前者丢掉还没处理的那几十篇，后者丢掉产出那份文件，都值得多问一句。
 * 一个决策一条（`RowRefs` 里两个字段），屏幕上最多只露一条。
 *
 * 还有两件事也归它管：
 * - 任务在**收起状态**下跑完时发一条系统通知（见 `notifyFinished`）；
 * - 拖动改位置（右下角常常正好压着为知自己的控件），位置记进设置，下次不用重拖。
 *   位置**每次高度变化都要重夹**（见 `applyPosition`）：卡片是往上长的，贴着屏幕上沿时
 *   一展开，唯一的拖拽面（顶部把手条）就会被顶出视口，用户再也拖不回来。
 *
 * 只在真的有待显示的任务时才创建 DOM，平时页面里没有这个节点。
 */

/* ------------------------------------------------------------------ */
/* DOM 结构                                                            */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ 阴影为什么放在 `.wze-task-shell` 上、而不是每张卡片上：
 * 卡片列表是需要滚动的（`overflow-y: auto`），而**任何非 visible 的 overflow 都会在
 * padding box 处裁剪子元素**——卡片自己的 `box-shadow` 画在卡片外面，于是被容器裁出一条
 * 直边，看起来就像“阴影被一个矩形框切了”。把阴影上提到外壳（外壳自己不裁剪、`overflow:
 * hidden` 只用来切圆角，裁不到自己的阴影），并且让里面每一行是**扁平**的（hover 底色 +
 * 分隔线，没有阴影），这个问题就不存在了。
 */
interface RowRefs {
  root: HTMLElement;
  state: HTMLElement;
  text: HTMLElement;
  progress: HTMLElement;
  progressInner: HTMLElement;
  actions: HTMLElement;
  /** “关闭”的二次确认行（`ui/kit/confirm.ts`），行内形态，挂在卡片里 */
  confirm: ConfirmRow;
  /** “中止”的二次确认行：同一个控件、另一条决策（两行互斥，见 `updateRow`） */
  confirmAbort: ConfirmRow;
}

interface BarPosition {
  right: number;
  bottom: number;
}

const DEFAULT_POSITION: BarPosition = { right: 16, bottom: 16 };
/** 距视口边缘至少留这么多，别让悬浮条贴着边或被拖出可视区 */
const EDGE_GAP = 8;
/** 位移超过这个距离才算“拖拽”，否则仍然算一次点击 */
const DRAG_THRESHOLD = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';
/*
 * 时长与曲线一律来自 `kit/morph.ts` 的 token（值定义在 `style.css` 的 `--wze-dur-*` /
 * `--wze-ease`）。双击复位“飞回去”用的是其中最长的一档（`fly`）：那一下常常跨半个屏幕，
 * 比展开补间长一点才跟得上。
 *
 * 这里**不再自己问 `prefers-reduced-motion`** —— 系统要求减少动态效果时 token 被归零，
 * `motionMs()` 读到 0，跟别处一样瞬时完成。
 */

/**
 * 折叠箭头。
 *
 * 自己画 SVG 而不是用字体里的 `▾`：那个字符在 11px 下细得像一个点，
 * 大小还跟着字体回退变来变去。这里用 16px 的画布 + 2px 圆头描边。
 *
 * 指向按“面板往哪边长”定：悬浮条贴着屏幕下沿，**展开是往上长**，
 * 所以画的是**朝上**的箭头（收起态 = 点它会往上展开），展开后整体旋转 180° 变成朝下。
 */
function chevronIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M4 9.5 8 5.5 12 9.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

let host: HTMLElement | undefined;
let shell: HTMLElement | undefined;
let groupEl: HTMLElement | undefined;
let groupText: HTMLElement | undefined;
let groupHint: HTMLElement | undefined;
let chevronEl: SVGSVGElement | undefined;
let summaryEl: HTMLElement | undefined;
let summaryText: HTMLElement | undefined;
let summaryBarInner: HTMLElement | undefined;
let listEl: HTMLElement | undefined;
let initialized = false;
/** 多任务时明细是否展开；重新出现分组时回到折叠 */
let expanded = false;
/** 分组下面当前露出的是哪一块（`undefined` = 卡片还没出现过） */
let revealed: 'summary' | 'list' | undefined;
let position: BarPosition = { ...DEFAULT_POSITION };
/** 盯着卡片高度：一变就重夹位置（见 `applyPosition`），高度变化的地方太多，手动调容易漏 */
let resizeObserver: ResizeObserver | undefined;
/** 按任务 id 复用行节点，进度刷新时只改文字与宽度，不重建 DOM */
const rows = new Map<number, RowRefs>();
/**
 * 整张卡片自己身上正在跑的补间：出场 / 退场 / 双击飞回原位。
 *
 * 三段动画动的都是 `transform`，同一时刻只该留一段 —— 见 `playMotion()`。
 */
let motion: Animation | undefined;
/**
 * 对话框是从哪一行打开的（任务 id），收起之后要把焦点还给那一行。
 *
 * 为什么不能指望 `kit/modal.ts` 还：任务一进对话框就不再算“收起来的”（`barTasks()` 只管
 * `minimized` 的），整条悬浮条连同行一起被拆掉；关掉之后重建的是**新节点**，而模态壳只按
 * “打开之前那个元素还在不在文档里”判断 —— 它已经不在了。所以由这里按**任务 id** 接过来还
 * （见 `teardown()` 与 `restoreRowFocus()`）。
 */
let pendingFocusTask: number | undefined;

/** 幂等：由 `main.ts` 在启动时调用一次 */
export function initTaskBar(): void {
  if (initialized) return;
  initialized = true;
  position = readStoredPosition();
  subscribeTasks(render);
  onTaskFinished(notifyFinished);
  /*
   * 对话框收完（遮罩摘掉）的那一刻，把悬浮条放出来。
   *
   * 它没有别的途径知道这件事：对话框开着时它只是被 CSS 藏着（`visibility: hidden`，
   * 见 panel.css 的 `:host(.wze-dialog-open)`），收不到任何渲染通知。补一段出场，
   * 正好接上对话框那一下“收过来”的变形 —— 一个收进去、一个冒出来，中间不断。
   */
  onExportDialogOpenChange((open) => {
    if (open) return;
    if (host) playMotion(morphIn(host));
    restoreRowFocus();
  });
  // 窗口变小之后原来的位置可能已经在视口外了，重新夹一次（不动 position，窗口变回来还能回原位）
  window.addEventListener('resize', () => applyPosition());
  render();
}

/**
 * 换上一段卡片补间。
 *
 * 上一段用 `finish()` 落定而不是 `cancel()`：这几段动画的终点就是元素此刻该有的样子
 * （`transform: none`、不透明），落定一下不跳，也能顺势接上新的那一段。
 */
function playMotion(animation: Animation | undefined): void {
  if (motion && motion !== animation) motion.finish();
  motion = animation;
  if (!animation) return;
  animation.onfinish = () => {
    if (motion === animation) motion = undefined;
  };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render(): void {
  const tasks = barTasks();
  if (tasks.length === 0) {
    teardown();
    return;
  }

  ensureHost();
  const multi = tasks.length > 1;
  const running = tasks.filter((task) => task.phase === 'running').length;
  const queued = tasks.filter((task) => task.phase === 'queued').length;

  if (groupEl && groupText && groupHint && chevronEl) {
    groupEl.hidden = !multi;
    groupText.textContent = `导出任务 ${tasks.length} 个`;
    // 串行调度下最多只有一个在跑，这里照样按数量写，免得日后放开并发就错了
    groupHint.textContent = multi
      ? `· ${running > 0 ? `${running} 个进行中` : queued > 0 ? `${queued} 个排队中` : '全部结束'}`
      : '';
    chevronEl.classList.toggle(`${P}-task-chevron-expanded`, expanded);
    groupEl.setAttribute('aria-expanded', String(expanded));
  }

  const collapsed = multi && !expanded;
  const target: 'summary' | 'list' = collapsed ? 'summary' : 'list';
  // 只在形态真的变了的时候做补间：`render()` 每次进度刷新都会跑（60ms 一次），
  // 不拦一道就会把动画反复重启成幻灯片
  if (target !== revealed) {
    const animate = revealed !== undefined;
    revealed = target;
    if (summaryEl) setRevealed(summaryEl, target === 'summary', animate);
    if (listEl) setRevealed(listEl, target === 'list', animate);
  }
  if (collapsed) renderSummary(tasks);
  renderRows(tasks);
}

/** 折叠时的一行汇总：当前（或最近）任务的文案 + 所有任务的总体进度 */
function renderSummary(tasks: ExportTask[]): void {
  const primary =
    tasks.find((task) => task.phase === 'running') ??
    tasks.find((task) => task.phase === 'queued') ??
    tasks[tasks.length - 1];

  if (summaryText) {
    summaryText.textContent = `${stateLabel(primary)} · ${textOf(primary)}`;
    summaryText.title = summaryText.textContent;
  }
  if (summaryBarInner) {
    const total = tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length;
    summaryBarInner.style.width = `${Math.round(total)}%`;
  }
}

function renderRows(tasks: ExportTask[]): void {
  const list = listEl;
  if (!list) return;

  // 先清掉已经不在列表里的行（被关闭 / 被取消的任务，以及“刚被对话框收走”的那一个）
  const wanted = new Set(tasks.map((task) => task.id));
  const stale = [...rows].filter(([id]) => !wanted.has(id));
  // 拆掉行之前先记住焦点在哪一行 —— 这一行马上就不在了（见 `pendingFocusTask`）
  if (stale.length > 0) rememberRowFocus();
  for (const [id, refs] of stale) {
    refs.root.remove();
    rows.delete(id);
  }

  const ordered = tasks.map((task) => {
    let refs = rows.get(task.id);
    if (!refs) {
      refs = buildRow(task);
      rows.set(task.id, refs);
    }
    updateRow(refs, task);
    return refs.root;
  });

  /*
   * 只在“节点的集合或顺序”真的变了时才动 DOM。
   *
   * `replaceChildren()` 会把已有节点先摘下来再插回去；而进度每 60ms 就刷新一次，
   * 于是 mousedown 与 mouseup 之间节点常常被换过一轮，浏览器就把这次 click 判给
   * 两者的**共同祖先**（外壳），行上的监听器收不到 —— 症状和 pointer capture
   * 那个坑一模一样。内容刷新走 `updateRow()` 就够了，不需要重建结构。
   */
  const sameOrder = list.childElementCount === ordered.length && ordered.every((node, i) => list.children[i] === node);
  if (!sameOrder) list.replaceChildren(...ordered);
}

function buildRow(task: ExportTask): RowRefs {
  const root = el('div', `${P}-task`);

  const top = el('div', `${P}-task-top`);
  const state = el('span', `${P}-task-state`);
  const actions = el('span', `${P}-task-actions`);
  top.append(state, actions);

  const text = el('div', `${P}-task-text`);
  const progressInner = el('i');
  const progress = el('div', `${P}-task-progress`);
  progress.append(progressInner);

  /*
   * 两个会丢东西的按钮各配一条确认行（“关闭” / “中止”）：和对话框里那两处是同一个控件
   * （`ui/kit/confirm.ts`），只是形态更轻 —— 排在进度条下面一行，行为（焦点 / 文案规则）
   * 完全一致。中止那句后果与对话框**共用同一句**（`session.ts` 的 `abortConsequence()`），
   * 关闭那句按界面分写（这里说的是“从悬浮条移除”）。
   */
  const confirm = createConfirmRow({
    message: closeMessage(task),
    confirmLabel: '确定移除',
    cancelLabel: '继续留着',
    onConfirm: () => discardTask(task),
  });
  const confirmAbort = createConfirmRow({
    message: abortConsequence(task),
    confirmLabel: '确定中止',
    cancelLabel: '继续导出',
    onConfirm: () => cancelTask(task),
  });

  root.append(top, text, progress, confirm.el, confirmAbort.el);
  root.title = '打开导出详情';
  /*
   * 整行可点：点它把对话框叫回来。可点的可供性靠 hover 底色 + 上面那句 tooltip，不用手型光标。
   *
   * 键盘也要有等价物（hover 与 tooltip 对键盘 / 触屏都到不了）：整行可聚焦，Enter / Space
   * 打开详情，焦点圈在 `panel.css` 的 `.wze-task:focus-visible` 里补。
   *
   * ⚠️ 角色是 `group` 而**不是 `button`**：`button` 的子元素在无障碍树里会被当作纯装饰
   * （children presentational），而这一行里还装着“中止 / 下载 / 关闭”与确认行的两个按钮 ——
   * 那么写会让它们**从读屏里消失**，其中就包括“关闭会把没下载的文件一起放掉”那道确认。
   * `group` 只是把这一行标成一个带名字的组，里面的控件照旧可见、可聚焦。
   */
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '打开导出详情');
  root.addEventListener('click', () => openTaskDialog(task));
  root.addEventListener('keydown', (event) => {
    // 行里的按钮（含确认行）发出的 keydown 会冒到这里：那些键归它们自己（回车 = 点它），
    // 不该顺带打开对话框 —— 只有焦点真的在这行自己身上时才响应
    if (event.target !== root) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openTaskDialog(task);
  });
  return { root, state, text, progress, progressInner, actions, confirm, confirmAbort };
}

/** 移除会说掉什么：有文件才提文件（“没有产出”的任务说这句话是无中生有） */
function closeMessage(task: ExportTask): string {
  return task.file
    ? '从悬浮条移除这个任务；还没下载的文件会一起释放。'
    : '从悬浮条移除这个任务。';
}

function updateRow(refs: RowRefs, task: ExportTask): void {
  /*
   * 阶段一变，两条确认行各自按“还对得上吗”作废（关闭只在结束之后、中止只在跑着时），
   * 否则它会挂在一个已经被换掉的触发按钮上。
   *
   * ⚠️ 顺序要紧：先 `close()`（它顺带把触发按钮上的 `aria-disabled` / `aria-controls` 解掉），
   * 再重建按钮（见下面那段）—— 反过来新按钮就不带标记了，行亮着、按钮却看着能点（§1.6）。
   */
  if (task.phase !== 'done') refs.confirm.close();
  if (task.phase !== 'running') refs.confirmAbort.close();

  refs.state.textContent = stateLabel(task);
  refs.state.className = `${P}-task-state ${P}-task-state-${toneOf(task)}`;
  refs.text.textContent = textOf(task);
  refs.text.title = refs.text.textContent;
  refs.progress.hidden = task.phase !== 'running';
  refs.progressInner.style.width = `${task.progress}%`;

  /*
   * 按钮同样只在“集合真的变了”时才重建 —— 进度每 60ms 刷新一次，
   * 每次把按钮换掉就会让 mousedown 与 mouseup 之间节点易主，浏览器把 click 判给
   * 共同祖先，于是“中止”点不动（和上面 renderRows 里那段注释是同一个坑）。
   * 按钮的闭包只认 task，复用旧节点不会有副作用。
   */
  const specs = actionSpecs(task, refs);
  const key = specs.map((spec) => spec.label).join('|');
  if (refs.actions.dataset.actions !== key) {
    refs.actions.replaceChildren(
      ...specs.map((spec) => taskButton(spec.label, spec.onClick, spec.primary, spec.hint)),
    );
    refs.actions.dataset.actions = key;
  }
}

interface ActionSpec {
  label: string;
  /** 按钮上的 tooltip：把“点下去会发生什么”说清楚（尤其是会丢东西的那种） */
  hint: string;
  primary?: boolean;
  /** 带上事件是为了让“亮确认行”那种动作能拿到自己这个按钮当焦点归属（`event.currentTarget`） */
  onClick: (event: MouseEvent) => void;
}

function stateLabel(task: ExportTask): string {
  if (task.phase === 'running') return '导出中';
  if (task.phase === 'queued') return '排队中';
  if (task.cancelled) return '已中止';
  if (!task.file) return '没有产出';
  return '已完成';
}

function toneOf(task: ExportTask): string {
  if (task.phase === 'running') return 'running';
  if (task.phase === 'queued') return 'queued';
  if (task.cancelled) return 'warn';
  if (!task.file || task.hasProblems) return 'warn';
  return 'ok';
}

function textOf(task: ExportTask): string {
  if (task.phase === 'running') return task.progressText || '准备中…';
  if (task.phase === 'queued') return `共 ${task.notes.length} 篇 · 等待前面的任务结束`;
  return task.summary || task.progressText;
}

function actionSpecs(task: ExportTask, refs: RowRefs): ActionSpec[] {
  if (task.phase === 'running') {
    return [
      {
        label: '中止',
        hint: '中止这次导出；已经导出的部分会保留',
        // 中止丢掉的是“还没处理的那几十篇”：先就地亮一条确认行说清后果（§1.2）
        onClick: (event) => {
          refs.confirmAbort.setMessage(abortConsequence(task));
          refs.confirmAbort.open(event.currentTarget as HTMLElement);
        },
      },
    ];
  }
  if (task.phase === 'queued') {
    return [{ label: '取消排队', hint: '把它从队列里去掉，不会开始导出', onClick: () => cancelTask(task) }];
  }

  const specs: ActionSpec[] = [];
  const file = task.file;
  if (file) {
    specs.push({ label: '下载', hint: '保存这份文件', primary: true, onClick: () => saveBlob(file.blob, file.filename) });
  }
  /*
   * 说明“关闭”会把产出那份文件一起放掉 —— 不说的话没人敢点。
   * 第一次点击只亮确认行（开合与焦点都归控件管），真正的移除在那一行里。
   */
  specs.push({
    label: '关闭',
    hint: '从悬浮条移除这个任务；还没下载的文件会一起释放',
    onClick: (event) => {
      refs.confirm.setMessage(closeMessage(task));
      refs.confirm.open(event.currentTarget as HTMLElement);
    },
  });
  return specs;
}

function taskButton(
  label: string,
  onClick: (event: MouseEvent) => void,
  primary = false,
  hint?: string,
): HTMLButtonElement {
  const node = el('button', `${P}-btn ${P}-task-btn${primary ? ` ${P}-btn-primary` : ''}`, label);
  node.type = 'button';
  if (hint) node.title = hint;
  node.addEventListener('click', (event) => {
    // 按钮在整行可点的容器里，别让这一下顺带把对话框也打开
    event.stopPropagation();
    onClick(event);
  });
  return node;
}

/* ------------------------------------------------------------------ */
/* DOM 创建 / 销毁                                                     */
/* ------------------------------------------------------------------ */

function ensureHost(): void {
  if (host) return;

  host = el('div', `${P}-taskbar`);
  // 外壳：唯一的阴影来源，自己不裁剪（`overflow: hidden` 只切内部圆角）
  shell = el('div', `${P}-task-shell`);

  /*
   * 把手条：整张卡片**唯一**的拖拽面，两种形态都在、外观完全一致。
   * 把“可拖”的承诺收进这一条之后，下面每一行都只承诺“可点”，光标也就不再两难
   * （拖动是平台惯例的 grab，点击由 hover 底色表示、光标保持箭头）。
   */
  const titlebar = el('div', `${P}-task-titlebar`);
  titlebar.title = '按住拖动位置；双击回到右下角';
  const grip = el('span', `${P}-task-grip`);
  grip.setAttribute('aria-hidden', 'true');
  titlebar.append(grip);
  titlebar.addEventListener('dblclick', () => {
    // 拖动没有键盘等价物，得留一条退路：双击回默认位置
    store.set('exportBarPos', null);
    flyTo(DEFAULT_POSITION.right, DEFAULT_POSITION.bottom);
  });

  const group = el('div', `${P}-task-group`);
  group.tabIndex = 0;
  group.setAttribute('role', 'button');
  group.title = '展开 / 折叠任务列表';
  groupText = el('span', `${P}-task-group-text`);
  groupHint = el('span', `${P}-task-group-hint`);
  chevronEl = chevronIcon();
  chevronEl.classList.add(`${P}-task-chevron`);
  group.append(groupText, groupHint, chevronEl);
  group.hidden = true;
  // 整行可点：折叠 / 展开。可点的可供性靠 hover 底色，不用手型光标
  group.addEventListener('click', () => {
    expanded = !expanded;
    render();
  });
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    expanded = !expanded;
    render();
  });
  groupEl = group;

  /*
   * 汇总行外面这层不带 padding，内层才带。
   *
   * 原因在收起动画：`box-sizing: border-box` 下 `height` 压不过 padding，
   * padding 直接留在外层的话，高度动画会在“只剩 padding 的厚度”上停一拍、
   * 再啪一下消失。padding 挪进内层，外层就能真的补到 0。
   */
  const summary = el('div', `${P}-task-summary`);
  summary.title = '展开任务列表';
  const summaryInner = el('div', `${P}-task-summary-inner`);
  summaryText = el('span', `${P}-task-summary-text`);
  summaryBarInner = el('i');
  const summaryBar = el('div', `${P}-task-aggbar`);
  summaryBar.append(summaryBarInner);
  summaryInner.append(summaryText, summaryBar);
  summary.append(summaryInner);
  summary.hidden = true;
  /*
   * 汇总行也点得开：它是“想知道每个任务怎么样了”最自然的落点。
   *
   * 键盘等价物与任务行同一套（见 `buildRow()` 那段）。这里可以用 `role="button"`：汇总行是
   * **叶子** —— 里面只有一行文字与一条进度条，不像任务行那样装着别的按钮。
   * `aria-expanded` 恒为 `false`：展开之后这一行自己就被 `hidden` 掉了，看得见它的时候
   * 一定是收起态。
   */
  const expandFromSummary = (): void => {
    expanded = true;
    render();
  };
  summary.tabIndex = 0;
  summary.setAttribute('role', 'button');
  summary.setAttribute('aria-expanded', 'false');
  summary.addEventListener('click', expandFromSummary);
  summary.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    expandFromSummary();
  });
  summaryEl = summary;

  listEl = el('div', `${P}-task-list`);

  shell.append(titlebar, group, summary, listEl);
  host.append(shell);
  attachDrag(host, titlebar);
  getOverlayRoot().append(host);

  /*
   * 高度一变就重夹一次位置（展开 / 收起、任务增删、确认行亮起都会改高度，
   * 而卡片往上长，顶部那条把手条最容易被顶出视口 —— 见 `applyPosition`）。
   * 用 ResizeObserver 而不是在各处手动补调用：展开（`setRevealed`）是逐帧长高的，
   * 手动调只能等它长完才纠正，中间那段就是“把手条已经在屏幕外面”。
   */
  resizeObserver = new ResizeObserver(() => applyPosition());
  resizeObserver.observe(host);
  applyPosition();
  // 出场：可能是刚生出来的第一张卡片，也可能是从对话框手里接回来的
  playMotion(morphIn(host));
}

/**
 * 记下“焦点此刻在哪一行”（没有就不动 `pendingFocusTask`）。
 *
 * 在**行即将被拆掉之前**调用（`renderRows()` 的清理与 `teardown()`）：那一行是对话框的入口，
 * 而它在对话框期间不存在，重建之后得靠任务 id 找回来。
 *
 * 不在这里清空 `pendingFocusTask`：这个函数可能因为“别的行被清掉”而被调用，而那时焦点并不在
 * 任何一行上 —— 顺手清空会把上一轮还没还回去的那个 id 弄丢。它只由 `restoreRowFocus()` 消费。
 */
function rememberRowFocus(): void {
  const active = focusedElement();
  if (!active) return;
  for (const [id, refs] of rows) {
    if (refs.root.contains(active)) {
      pendingFocusTask = id;
      return;
    }
  }
}

/**
 * 把焦点还给“刚才那一行”—— 对话框是从它打开的，而它在对话框期间被拆掉、之后是新建的。
 *
 * ⚠️ 只在这一刻**焦点确实没处可去**时才接管（`focusedElement()` 给 `null`）：用户可能已经用
 * 鼠标点去别的地方了，那种情况下抢焦点是打扰。那一行找不回来（任务被关闭 / 被丢弃）就什么都
 * 不做 —— 和模态壳还不了时的姿势一致。
 *
 * 时机是 `setExportDialogOpen(false)` 那次广播：遮罩已经摘掉、悬浮条刚被放出来（class 已摘），
 * 所以焦点落在可见的行上不会失败 —— 这也正是模态壳不能直接把焦点还给这一行的原因（它那边的
 * 还焦点排在广播之后，而且拿的是旧节点）。
 */
function restoreRowFocus(): void {
  const id = pendingFocusTask;
  pendingFocusTask = undefined;
  if (id === undefined || focusedElement()) return;
  const row = rows.get(id)?.root;
  /*
   * ⚠️ 行可能正躺在**收起来的明细里**（多任务时明细默认折叠，而重建之后就是折叠态），那样它
   * 没有盒子、聚焦不了。这时退一步给“展开任务列表”那一行 —— 同一个入口，键盘用户下一步本来
   * 也是要展开它。两个都够不到（整条悬浮条已经不在了）就什么都不做。
   */
  const collapsed = [summaryEl, groupEl].find((node) => node && node.getClientRects().length > 0);
  if (row && row.getClientRects().length > 0) row.focus();
  else collapsed?.focus();
}

function teardown(): void {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  /*
   * 拆之前先记住焦点在哪一行：对话框一开整条就被拆掉，重建之后那个节点已经不是同一个了
   * （见 `pendingFocusTask`）。此时焦点还在那一行上 —— 模态壳要等到自己入场的那一帧才接走它。
   */
  rememberRowFocus();

  const dying = host;
  host = undefined;
  shell = undefined;
  groupEl = undefined;
  groupText = undefined;
  groupHint = undefined;
  chevronEl = undefined;
  summaryEl = undefined;
  summaryText = undefined;
  summaryBarInner = undefined;
  listEl = undefined;
  rows.clear();
  // 下次出现分组时从“折叠”开始，别记住上一轮的手气
  expanded = false;
  // 连同“当前露着哪一块”一起忘掉：下张卡片第一次渲染直接落定，不做补间
  revealed = undefined;
  // 锚点跟着一起清掉：下一轮要是还没有悬浮条，对话框不该往一个早就不存在的位置收
  setBarAnchor(null);
  /*
   * 收掉再摘。
   *
   * 先把上一段补间（飞回原位之类）落定，再从落定的样子收：不然收起的第一帧会从半路跳回
   * 逻辑位置。同时**立刻关掉命中测试** —— 这 200ms 里它还在屏幕上，但里面的任务已经没了
   * （文件都放掉了），点中任何一行都是错的。
   *
   * 被对话框藏起来时也走这条（藏起来只是不画，盒子还在），只是那 200ms 的动画看不见 ——
   * 无所谓，反正结果都是摘掉。
   */
  if (dying) {
    playMotion(undefined);
    dying.style.pointerEvents = 'none';
    void morphOut(dying).then(() => dying.remove());
  }
}

/* ------------------------------------------------------------------ */
/* 位置与拖拽                                                          */
/* ------------------------------------------------------------------ */

function readStoredPosition(): BarPosition {
  const stored = store.get('exportBarPos');
  if (!stored || typeof stored.right !== 'number' || typeof stored.bottom !== 'number') {
    return { ...DEFAULT_POSITION };
  }
  return { right: stored.right, bottom: stored.bottom };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 这个尺寸下位置最多能到哪儿（贴着视口边留 `EDGE_GAP`） */
function boundsFor(width: number, height: number): BarPosition {
  return {
    right: Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP),
    bottom: Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP),
  };
}

/**
 * 把位置落到 DOM 上。
 *
 * ⚠️ **每次都要按当前尺寸重夹一次**，不能只信拖拽那一刻夹好的数：
 * 悬浮条锚的是**下沿**，卡片长高（展开明细、任务变多、确认行亮起）就是**往上长** ——
 * 位置要是贴着屏幕上沿，而拖拽时卡片还是收起的（矮），夹出来的 `bottom` 就是按矮的那个算的，
 * 一旦长高，**把手条（唯一的拖拽面，在卡片顶部）会被顶出视口，用户再也拖不回来**。
 *
 * 重夹只影响“显示在哪儿”，不动 `position` —— 用户拖到哪儿仍然记在 `position` 里，
 * 所以收起来之后它会自己回到原来那个高度。
 */
function applyPosition(): void {
  if (!host) return;
  /*
   * ⚠️ 量的是 `offsetWidth / offsetHeight`（布局盒子），不是 `getBoundingClientRect()`：
   * 后者**含**正在跑的补间那一层 `transform`，飞回原位 / 出场缩放的中途量到的是“动画途中的
   * 样子”（小了、偏了），拿它去夹位置、当锚点都不对。
   */
  const width = host.offsetWidth;
  const height = host.offsetHeight;
  // 还没进布局（追加进 DOM 之前、或被移出文档流）时才量不到 —— 正常情况一律量得到，
  // 包括**被对话框藏起来**的时候：那种“藏”是 `visibility: hidden`，照样占着盒子（见 panel.css）
  if (width === 0 || height === 0) return;
  const limit = boundsFor(width, height);
  const right = clamp(position.right, EDGE_GAP, limit.right);
  const bottom = clamp(position.bottom, EDGE_GAP, limit.bottom);
  host.style.right = `${right}px`;
  host.style.bottom = `${bottom}px`;
  rememberAnchor(right, bottom, width, height);
}

/**
 * 把“我落定在哪儿”报给 `kit/morph.ts` —— 导出对话框据此知道从哪儿长出来、收回哪儿去。
 *
 * 报的是**落定的盒子**（右 / 下偏移 + 布局尺寸），不是量到的屏幕矩形：动画途中量到的矩形
 * 带着位移，拿它当锚点会让对话框从半空中长出来。
 *
 * 换算用的是 `documentElement.clientWidth/Height` 而不是 `window.innerWidth/Height` ——
 * `position: fixed` 的包含块是**不含滚动条**的视口，`innerWidth` 把滚动条也算进去了，
 * 在 Windows 这类占位滚动条的平台会让锚点整体偏出十几像素。
 *
 * 被对话框藏着的那段时间**照样会报**（那时它仍然占着盒子），所以对话框收起时拿到的落点
 * 是悬浮条**此刻**的样子 —— 藏着的时候任务还在跑、卡片还在变高，锚点跟着变才收得准。
 * 整条悬浮条没了才由 `teardown()` 清成 `null`。
 */
function rememberAnchor(right: number, bottom: number, width: number, height: number): void {
  const viewport = document.documentElement;
  setBarAnchor({
    left: viewport.clientWidth - right - width,
    top: viewport.clientHeight - bottom - height,
    width,
    height,
  });
}

/** 记下用户拖到的位置，并按当前尺寸夹一次存起来（随后由 `applyPosition` 落 DOM） */
function setPosition(right: number, bottom: number): void {
  if (!host) return;
  // 同样只认布局尺寸：拖动可能正好发生在双击复位那一段飞行动画的头上
  const limit = boundsFor(host.offsetWidth, host.offsetHeight);
  position = {
    right: clamp(right, EDGE_GAP, limit.right),
    bottom: clamp(bottom, EDGE_GAP, limit.bottom),
  };
  applyPosition();
}

/**
 * 双击把手：飞回默认位置（FLIP）。
 *
 * 拖动没有键盘等价物，这是留给它的那条退路（见 docs/export-pipeline.md §1.5）。
 * 做法是先按新位置把 DOM 落定（改位置只有 `setPosition` 一处），再从**原来的位置**补一段
 * 位移动画 —— 于是逻辑位置在动画开始前就已经是终点了：中途被打断、或者动画没跑完就被
 * 抓住，都不会留下半路的状态（`grabShift()` 处理后者）。
 *
 * 用整套动效共用那条减速曲线（`motionEase()`）：它正好是“从这儿出去、稳稳落在那儿”的手感。
 */
function flyTo(right: number, bottom: number): void {
  if (!host) return;
  const duration = motionMs('fly');
  const from = morphRectOf(host);
  // 上一段补间（可能还在出场淡入里）先落定，落定后量到的 `to` 才是它干净的位置
  playMotion(undefined);
  setPosition(right, bottom);
  const to = morphRectOf(host);
  if (!from || !to || duration === 0) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return;

  playMotion(
    host.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration,
      easing: motionEase(),
    }),
  );
}

/**
 * 拖动开始时跟飞行补间结账：把它落定，并返回**落定造成的视觉位移**（左 / 上被平移了多少）。
 *
 * 拖动算的是“指针移动了多少”，而指针是按**视觉位置**抓上去的；飞行的逻辑位置早就到终点了，
 * 落定会让卡片瞬移一段 —— 不补这一下，一按下去就跳。没有补间在跑时前后量到的是同一个矩形，
 * 补 0，行为与从前完全一致。
 */
function grabShift(): { right: number; bottom: number } {
  if (!host || !motion) return { right: 0, bottom: 0 };
  const before = host.getBoundingClientRect();
  playMotion(undefined);
  const after = host.getBoundingClientRect();
  return { right: after.left - before.left, bottom: after.top - before.top };
}

/**
 * 拖动把手条改位置。
 *
 * 拖拽面只有顶部那条把手条（见文件顶部的约束），位移超过阈值才算拖拽 ——
 * 手抖不该把悬浮条挪走。松手时把位置记进设置，下次直接落在老地方。
 *
 * ⚠️ 这里**刻意不用 `setPointerCapture`**（实测踩过）：
 * 一旦在某个元素上捕获指针，浏览器会把随后的 **pointerup 与 click 一起改判给捕获元素**。
 * 之前捕获在外壳上，于是点任务行时 `click.target` 变成了外壳本身，行上的监听器
 * 永远收不到 —— 表现就是“悬浮条怎么点都打不开对话框”。合成事件验不出来，必须真鼠标点。
 * 现在改成在 `window` 上听 move / up，走原生命中测试，click 该给谁就给谁。
 *
 * 也**不需要**“吞掉拖拽之后那次 click”：拖拽面上没有任何点击监听器，
 * 无论那次 click 落在哪都不会触发动作。
 */
function attachDrag(bar: HTMLElement, handle: HTMLElement): void {
  let drag:
    | { pointerId: number; startX: number; startY: number; startRight: number; startBottom: number; moved: boolean }
    | undefined;

  function detach(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onBlur);
  }

  /** 收尾。`save` 为真且确实拖动过时，把位置记进设置 */
  function finish(save: boolean): void {
    const moved = drag?.moved === true;
    drag = undefined;
    detach();
    bar.classList.remove(`${P}-taskbar-dragging`);
    if (!moved || !save) return;
    store.set('exportBarPos', { ...position });
  }

  function onMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // 在窗口外面松开是收不到 pointerup 的 —— 松手后 buttons 会归零，用它自愈
    if (event.buttons === 0) {
      finish(true);
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // 没超过阈值就还不算拖动：轻微的抖动不该把悬浮条挪走
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      /*
       * 拖动真的开始了才跟飞行动画结账：那之前别碰它（按下去不动的话，让卡片把这段飞行
       * 走完才自然）。结账的位移补进起点，见 `grabShift()`。
       */
      const shift = grabShift();
      drag.startRight += shift.right;
      drag.startBottom += shift.bottom;
      drag.moved = true;
    }
    bar.classList.add(`${P}-taskbar-dragging`);
    setPosition(drag.startRight - dx, drag.startBottom - dy);
  }

  function onUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    finish(true);
  }

  function onBlur(): void {
    finish(true);
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: position.right,
      startBottom: position.bottom,
      moved: false,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
  });
}

/* ------------------------------------------------------------------ */
/* 完成提醒                                                            */
/* ------------------------------------------------------------------ */

/**
 * 任务跑完时的提醒。
 *
 * 对话框就摆在眼前、页面也可见时什么都不做 —— 结果已经在屏幕上了，再弹通知是打扰。
 * 只有任务被收进悬浮条（或页面整个在后台）才发系统通知；连通知都发不出去时
 * 退化成页面内 toast，至少回到页面上能看见。
 */
function notifyFinished(task: ExportTask): void {
  if (!task.minimized && !document.hidden) return;

  const title = task.cancelled ? '导出已中止' : task.file ? '导出完成' : '导出结束';
  const body = task.summary || task.progressText || '任务已结束';
  if (sendSystemNotification(title, body, () => openTaskDialog(task))) return;
  showToast(`${title}：${body}`);
}
