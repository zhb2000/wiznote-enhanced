/*
 * 整套动效的原语都收在这里：**一块内容怎么出现 / 消失**，以及**时长与曲线的唯一来源**
 * （token 定义在 `style.css` 的 `:root`，见下面 `motionMs()` / `motionEase()`）。
 *
 * 三件事，同一份用途：让界面的变化看起来是“同一件东西在动”，而不是两个控件各自被开关了
 * 一下（见 docs/export-pipeline.md §1.5）。
 *
 * 一、变形补间（`morphIn` / `morphOut`）：从某个矩形**长**出来、**收**回某个矩形去 ——
 * 悬浮条与导出对话框互相切换时用它做接力。`hidden` / `display: none` 是瞬时开关、做不了
 * 过渡，所以走 WAAPI。换算方式是 FLIP：量出自己最终的盒子，再把 `translate + scale` 反推
 * 回去（绕中心缩放，位移只按两个矩形的中心差走）。
 *
 * 二、高度露出 / 收起（`setRevealed`）：一块内容从 0 长到自然高度、或反过来。展开 / 折叠
 * 任务明细、确认行从卡片里长出来都用它。
 *
 * 三、接力锚点：悬浮条落定在屏幕上的哪个盒子。那个盒子在**另一个模块**手里（悬浮条是
 * `export-tasks.ts` 建的，对话框不该去摸它的 DOM），所以由它每次落位时
 * （`export-tasks.ts` 的 `applyPosition()`）报一次，对话框需要时直接取。放这里是为了避开
 * `export-tasks` ←→ `export-dialog` 的循环依赖（前者要用后者的 `openTaskDialog`）。
 *
 * ⚠️ 锚点必须**在对话框收起之前**就已经报过一次，否则那一下“收过去”没有落点、只会原地
 * 缩一下。第一次把任务收进悬浮条时最容易踩：悬浮条是那一刻才建出来的，所以
 * `export-dialog.ts` 的 `minimize()` 里**先**让它就位、**再**收起对话框。
 */

/** 视口坐标系里的矩形。只用到这四项，不依赖 `DOMRect` */
export interface MorphRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* 动效 token                                                          */
/* ------------------------------------------------------------------ */

/**
 * 时长与曲线的**唯一来源**是 `style.css` 的 `:root`（那几行 `--wze-dur-*` / `--wze-ease`）。
 *
 * 两个消费方读同一份：`panel.css` 里的 `transition` 直接 `var()`，这边读出来喂给 WAAPI。
 * 从前是 JS 一套常量、CSS 另一套（0.15s / 0.16s / 0.2s 各写各的，还得靠注释提醒
 * “改一处要连着另一处改”），现在只有一处可改。
 *
 * `prefers-reduced-motion` 也归 token 管：`style.css` 里把四个时长都归零，于是
 * `motionMs()` 读到 0、各处“时长为 0 就瞬时落定”的短路判断照旧生效，不用再单独
 * 问一次媒体查询（CSS 侧的 `transition` 也一起被归零了）。
 */
const TOKEN = {
  ease: '--wze-ease',
  fast: '--wze-dur-fast',
  reveal: '--wze-dur-reveal',
  normal: '--wze-dur-normal',
  fly: '--wze-dur-fly',
} as const;

/** token 的取值类型：`'fast' | 'reveal' | 'normal' | 'fly'`（见 `style.css` 的注释） */
export type MotionTiming = 'fast' | 'reveal' | 'normal' | 'fly';

/** token 读不到时（样式还没注入、被裁剪掉）退回这套动效原本写死的值，行为与从前一致 */
const FALLBACK: Record<MotionTiming, number> = { fast: 150, reveal: 160, normal: 200, fly: 280 };
const FALLBACK_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/*
 * 只在**首次用到时**读一次，不在模块顶层读。
 *
 * 这个模块由 `main.ts` 的 import 链在 document-start 就求值，而 `style.css` 何时注入
 * 是打包器的事 —— 现在 `main.ts` 里那句 `import './style.css'` 排在最前，但那是巧合、
 * 不是契约。补间只可能在用户交互时跑，那时样式一定就位；读一次就够（会话中途改
 * 系统设置需要刷新才生效，代价只是补间多跑两百毫秒，不影响状态）。
 */
const msCache = new Map<MotionTiming, number>();
let easeCache: string | undefined;

/** 取 token 时长（毫秒）。`0.2s` 与 `200ms` 两种写法都认 */
export function motionMs(timing: MotionTiming): number {
  const cached = msCache.get(timing);
  if (cached !== undefined) return cached;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(TOKEN[timing]).trim();
  const value = Number.parseFloat(raw);
  const ms = Number.isFinite(value) ? (raw.endsWith('ms') ? value : value * 1000) : FALLBACK[timing];
  msCache.set(timing, ms);
  return ms;
}

/** 整套动效共用的一条减速曲线（`--wze-ease`） */
export function motionEase(): string {
  easeCache ??=
    getComputedStyle(document.documentElement).getPropertyValue(TOKEN.ease).trim() || FALLBACK_EASE;
  return easeCache;
}

/** 元素的屏幕矩形；没有盒子（`display: none`、还没挂载）时给 `null` */
export function morphRectOf(node: Element | null | undefined): MorphRect | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * 让节点看起来正占着 `shown` 那个盒子 —— 它自己实际占的是 `natural`。
 *
 * `transform-origin` 默认在中心，所以位移取两个矩形的**中心差**；`scale` 的 x / y 各算各的
 * —— 形状不一样（对话框 880×600 收进 320×90 的悬浮条）时，正是这份“变形”在告诉眼睛
 * 它收到哪儿去了。
 */
function collapseTo(shown: MorphRect, natural: MorphRect): string {
  const scaleX = shown.width / natural.width;
  const scaleY = shown.height / natural.height;
  const dx = shown.left + shown.width / 2 - (natural.left + natural.width / 2);
  const dy = shown.top + shown.height / 2 - (natural.top + natural.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
}

/**
 * 收到一半的样子（`collapseTo` 与“原样”的正中间）。
 *
 * 中间那帧是为了**不让形变提前化掉**：收向悬浮条时形状差得远（宽高比都不一样），
 * 两帧一起补的话不透明度会跟着线性降到一半，还没看清收到哪儿去就已经淡没了。
 * 关键帧的 transform 必须写成同一组函数（`translate` + `scale`），浏览器才插得动。
 */
function halfCollapse(shown: MorphRect, natural: MorphRect): string {
  const scaleX = (shown.width / natural.width + 1) / 2;
  const scaleY = (shown.height / natural.height + 1) / 2;
  const dx = (shown.left + shown.width / 2 - (natural.left + natural.width / 2)) / 2;
  const dy = (shown.top + shown.height / 2 - (natural.top + natural.height / 2)) / 2;
  return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
}

/**
 * 从 `shown` 这个矩形“长出来”（不给就原地轻轻放大）。
 *
 * 起点留了 0.35 的不透明度：它是从悬浮条那儿钻出来的，一开始就不该是隐形的 ——
 * 那才是“从哪来”的信息本身。
 *
 * ⚠️ 节点**必须已经可见**、并且尺寸已经是最终尺寸 —— 这里量的是它此刻的盒子。
 * 量不到盒子（尺寸为 0）就什么都不做：那种情况下它本来也看不见。
 */
export function morphIn(node: HTMLElement, shown?: MorphRect | null): Animation | undefined {
  const duration = motionMs('normal');
  if (duration === 0) return undefined;
  const natural = morphRectOf(node);
  if (!natural) return undefined;
  const start = shown
    ? { transform: collapseTo(shown, natural), opacity: 0.35 }
    : { transform: 'scale(0.96)', opacity: 0 };
  return node.animate([start, { transform: 'none', opacity: 1 }], { duration, easing: motionEase() });
}

/**
 * 收成 `shown` 那个矩形（不给就原地缩小淡出）。
 *
 * 返回值在补间跑完时 resolve，调用方**那时**才摘节点；`prefers-reduced-motion` 下立刻
 * resolve。`fill: forwards` 是为了跑完到摘掉之间不闪回原样。
 */
export function morphOut(node: HTMLElement, shown?: MorphRect | null): Promise<void> {
  const duration = motionMs('normal');
  const natural = morphRectOf(node);
  if (duration === 0 || !natural) return Promise.resolve();
  const keyframes: Keyframe[] = shown
    ? [
        { transform: 'none', opacity: 1 },
        { offset: 0.65, transform: halfCollapse(shown, natural), opacity: 0.9 },
        { offset: 1, transform: collapseTo(shown, natural), opacity: 0 },
      ]
    : [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.96)', opacity: 0 }];
  const animation = node.animate(keyframes, { duration, easing: motionEase(), fill: 'forwards' });
  // `finished` 会因 `cancel()` 而 reject，这里只关心“跑完了没”
  return animation.finished.catch(() => undefined).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* 高度露出 / 收起                                                     */
/* ------------------------------------------------------------------ */

/** 每个节点上正在跑的高度补间，用来在连点时从当前高度接着走 */
const reveals = new WeakMap<HTMLElement, Animation>();

/** 把节点归位到“已经落定”：停掉补间、摘掉补间期间那点临时裁剪 */
function settleReveal(node: HTMLElement): void {
  reveals.get(node)?.cancel();
  reveals.delete(node);
  node.style.overflow = '';
}

/**
 * 露出一块内容 / 把它收回去（0 ↔ 自然高度）。
 *
 * `hidden` 是瞬时开关，做不了补间，所以这里自己量高度再跑一段 WAAPI：露出 = 0 → 自然高度，
 * 收起 = 当前高度 → 0，跑完再落回 `hidden` —— 结束时节点真的不在布局里，键盘与读屏都到不了，
 * 和没写动画时完全一致。
 *
 * 两个细节：
 *
 * - **连点两次也能接上**：打断上一次之前先量它当前的**动画高度**，再从那儿继续；
 * - **只在补间期间裁剪**（临时给节点 `overflow: hidden`）：收起时内容得跟着切掉、露出时内容
 *   不能先冒出来，但落定之后要把裁剪还回去 —— 否则按钮的焦点圈会被一个常驻的
 *   `overflow: hidden` 沿着边切掉一条。
 *
 * ⚠️ 被补间的节点**自己不能带 padding / margin**（`box-sizing: border-box` 下 `height`
 * 压不过 padding，动画会在“只剩 padding 的厚度”上停一拍再啪一下消失），间距留给内层元素。
 *
 * @param animate 首次出现传 `false`：刚生出来就“长开”一下是多余的
 */
export function setRevealed(node: HTMLElement, show: boolean, animate = true): void {
  const duration = motionMs('reveal');
  // 先量（动画中的高度也量得到），否则会先跳回自然高度再收，看着像闪了一下
  const from = reveals.has(node) ? node.getBoundingClientRect().height : node.offsetHeight;
  // 顺带清掉上一轮 `fill: forwards` 留下的残影与临时裁剪
  settleReveal(node);

  if (!animate || duration === 0) {
    node.hidden = !show;
    return;
  }

  if (show) node.hidden = false;
  const to = show ? node.offsetHeight : 0;
  if (from === to) {
    node.hidden = !show;
    return;
  }

  node.style.overflow = 'hidden';
  const animation = node.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration,
    easing: motionEase(),
    // 收起方向要停在 0：等 `onfinish` 落到 `hidden`，中间不能闪回自然高度
    fill: show ? 'none' : 'forwards',
  });
  reveals.set(node, animation);
  animation.onfinish = () => {
    // 这一轮可能已经被新的补间接替了（结束事件是排队派发的，中间又调了一次）：那就别动
    if (reveals.get(node) !== animation) return;
    if (!show) node.hidden = true;
    // 收干净：`fill: forwards` 的那份残影留着也没用，下次露出时还得再清一遍
    settleReveal(node);
  };
}

/** 只淡入，不做形变：遮罩这类铺满屏幕的层缩起来会露馅 */
export function fadeIn(node: HTMLElement): Animation | undefined {
  const duration = motionMs('normal');
  if (duration === 0) return undefined;
  return node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: motionEase() });
}

/** 只淡出。返回值的语义与 `morphOut` 一致 */
export function fadeOut(node: HTMLElement): Promise<void> {
  const duration = motionMs('normal');
  if (duration === 0) return Promise.resolve();
  const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration,
    easing: motionEase(),
    fill: 'forwards',
  });
  return animation.finished.catch(() => undefined).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* 接力锚点                                                            */
/* ------------------------------------------------------------------ */

/**
 * 悬浮条落定在屏幕上的哪个盒子（最后一次落位的样子）。
 *
 * 被对话框藏起来的那段时间它**照样是新的**：藏起来用的是 `visibility`，卡片仍然占着盒子，
 * 里面的任务也还在跑、还会变高，`applyPosition()` 每落一次位就报一次。
 * 整条悬浮条没了（任务全结束）才清成 `null`，免得下一轮拿一个早已不存在的矩形当落点。
 */
let barAnchor: MorphRect | null = null;

export function setBarAnchor(rect: MorphRect | null): void {
  barAnchor = rect;
}

export function getBarAnchor(): MorphRect | null {
  return barAnchor;
}
