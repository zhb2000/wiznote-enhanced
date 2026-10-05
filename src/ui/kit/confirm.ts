import { config } from '../../config';
import { el } from './el';
import { setRevealed } from './morph';

const P = config.prefix;

/*
 * 危险动作的“待决确认行”：一句后果说明 + [不做] [执行]。
 *
 * 为什么不是模态、也不是“按钮变色”（第一次点变成“再点一次确认重置”）：
 *
 * - **说清后果要一整句** —— “关闭会清掉这批导出记录和已生成的文件”塞不进按钮文案里，
 *   而那句“再点一次确认重置”其实什么都没说；
 * - **位置必须贴着触发它的按钮** —— 点的是底部那个按钮，反馈不能出现在屏幕另一头；
 * - **不做超时自动收起** —— 它是显式状态、自己带“不做”这个出口；按钮变色那种隐性规则
 *   （3 秒没动作复位）只配留给无副作用的小动作。
 *
 * 三个消费者共用：`ui/export-dialog.ts`、`ui/settings-dialog.ts`、`ui/export-tasks.ts`。
 * 所以它**不依赖模态壳**；也正因为跨了模态内外，两条行为写死在这里：
 *
 * 同一个消费者可以**同时挂多条**：导出对话框与悬浮条各挂着两条（“中止”与“关闭”）。
 * 一个决策一条 —— 两条的后果、执行按钮、不做按钮全不一样，合并成一条复用得让控件记住
 * “这次是哪条”，那套隐性规则正是本控件要避免的。互斥由调用方按**阶段**负责
 * （每条只在自己那个阶段里有意义，见 §1.2 / §1.6 的“阶段变化”）。
 *
 * 1. **Esc 只收起它**：模态里由调用方代接（模态壳在 `document` 捕获阶段就 `stopPropagation()`
 *    了，控件根本收不到；调用方在 `onDismiss` 里先问 `isOpen()`，规则统一为“只收起它，
 *    不关对话框、不最小化”）。不在模态里（悬浮条）时这里自己接住 —— 见下面那条 keydown；
 * 2. **点击不外泄**：悬浮条里整张卡片是“打开对话框”的热区，确认行上的点击冒泡上去
 *    会把对话框也一起打开。
 *
 * 待决期间**触发它的那个按钮会变成“不可用”**（`aria-disabled` + 拿掉 hover 底色）：动作被
 * 挂起了、得先在下面这条里选一个，那就不该看起来还能点。**不**做成“再点一次就执行”（那套
 * 按钮变色 / 二次点击确认早已废弃，见 §1.6），也**不**让它消失（它得留在原地当焦点回收的
 * 落点，见 `hide()`）。三处消费者因此自动一致，谁也不许自己另搞一套。
 *
 * 露头与收起走 `kit/morph.ts` 的 `setRevealed()`（0 ↔ 自然高度）：它出现的位置总是某个
 * 容器的底边，瞬闪一下会让整块界面**凭空变高**（在悬浮条里就是卡片猛地长一截）。
 * 因此结构上分两层：外层 `.wze-confirm` 只负责被补间的高度，间距与内边距全在内层
 * `.wze-confirm-inner`（外层带 padding / margin 的话高度补不到 0，见 `setRevealed` 的说明）。
 *
 * 文案规范（比控件更容易走样，见 docs/export-pipeline.md §1.6）：说明用陈述句、
 * 执行按钮写“动词 + 对象”、不做按钮写这个动作“不做”的说法（别用泛化的“取消”，
 * 那个词在导出对话框里已经有别的含义了）。
 */
let seq = 0;

export interface ConfirmRowOptions {
  /** 说明后果的陈述句 */
  message: string;
  /** 执行按钮：动词 + 对象（“确定关闭”“确定重置”） */
  confirmLabel: string;
  /** 不做按钮：这个动作“不做”的说法（“继续查看”“暂不重置”） */
  cancelLabel: string;
  onConfirm: () => void;
}

export interface ConfirmRow {
  /** 整行（说明 + 两个按钮）。插哪儿由调用方决定：模态里挂 `modal.notice`，悬浮条里挂进卡片 */
  el: HTMLElement;
  /**
   * 亮出确认行；`trigger` 是刚点的那个按钮。
   *
   * 待决期间 `trigger` 会被置成不可用（`aria-disabled` + 收掉 hover 底色，外观在 panel.css），
   * 收起时解禁，并把焦点还给它。
   */
  open(trigger: HTMLElement): void;
  close(): void;
  isOpen(): boolean;
  /** 文案随状态变时用（例如“手上有没有文件”说的后果不一样），开之前调 */
  setMessage(message: string): void;
}

export function createConfirmRow(options: ConfirmRowOptions): ConfirmRow {
  // 外层：只负责被补间的高度（所以它自己不带任何 padding / margin，见文件头）
  const root = el('div', `${P}-confirm`);
  const inner = el('div', `${P}-confirm-inner`);
  const text = el('span', `${P}-confirm-text`, options.message);
  const actions = el('div', `${P}-confirm-actions`);
  const cancelBtn = el('button', `${P}-btn`, options.cancelLabel);
  const confirmBtn = el('button', `${P}-btn ${P}-btn-danger`, options.confirmLabel);
  cancelBtn.type = 'button';
  confirmBtn.type = 'button';

  // 说明用 aria-describedby 挂到两个按钮上：读到“继续查看”时顺带把后果念一遍，
  // 光靠“露出一行文字”在读屏里是不保证被播报的
  const rowId = (seq += 1);
  root.id = `${P}-confirm-row-${rowId}`;
  text.id = `${P}-confirm-${rowId}`;
  cancelBtn.setAttribute('aria-describedby', text.id);
  confirmBtn.setAttribute('aria-describedby', text.id);

  actions.append(cancelBtn, confirmBtn);
  inner.append(text, actions);
  root.append(inner);
  root.hidden = true;
  // 点击一格都不外泄（见文件头第 2 条）
  root.addEventListener('click', (event) => event.stopPropagation());
  /*
   * Esc 的兜底。模态里到不了这儿（模态壳在 `document` 捕获阶段就 `stopPropagation()` 了，
   * 由调用方裁决）；悬浮条里没有模态壳，这一条就是它唯一的 Esc —— 打开时焦点给了“不做”，
   * 所以事件正好从行里冒上来，不会漏掉别处。
   * 顺带把事件留住：一条待决的决策正在屏幕上，不该同时去动页面上的别的东西（与模态那边一致）。
   */
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !shown) return;
    event.stopPropagation();
    hide(true);
  });

  let trigger: HTMLElement | undefined;
  /**
   * 逻辑上的开 / 合。
   *
   * ⚠️ 不能用 `root.hidden` 当状态：收起动画跑着的那 160ms 里它还是 `false`，而
   * `isOpen()` 必须**立刻**变假（调用方拿它判断“这一下 Esc 是收确认行还是收对话框”）。
   */
  let shown = false;

  function hide(restoreFocus: boolean): void {
    if (!shown) return;
    shown = false;
    setRevealed(root, false);
    // 解禁与摘掉那层关系，都在还焦点之前做
    trigger?.removeAttribute('aria-disabled');
    trigger?.removeAttribute('aria-controls');
    // 焦点还给触发按钮，键盘用户不至于掉到文档流开头；
    // 确认路径不还 —— 触发按钮（连同整个对话框 / 卡片）马上就被移除了
    if (restoreFocus) trigger?.focus();
    trigger = undefined;
  }

  function open(next: HTMLElement): void {
    if (shown) return;
    shown = true;
    trigger = next;
    setRevealed(root, true);
    /*
     * 待决期间它不可用（见文件头）。
     *
     * ⚠️ 用 `aria-disabled` 而不是 `disabled`：后者会把按钮移出 tab 顺序、还会让 `title`
     * 失效 —— 而那句 tooltip 说的正是这个待决动作的后果，而且收起时焦点还得还回它身上。
     *
     * 关系用 `aria-controls` 而不是 `aria-expanded`：`aria-expanded` 的语义是“再激活一次
     * 会收起”，可它现在不可用、也没有那条行为。指向那条行既说清了关系，也不撒谎。
     */
    trigger.setAttribute('aria-disabled', 'true');
    trigger.setAttribute('aria-controls', root.id);
    // 焦点给“不做”：键盘用户直接回车不会误执行
    cancelBtn.focus();
  }

  cancelBtn.addEventListener('click', () => hide(true));
  confirmBtn.addEventListener('click', () => {
    hide(false);
    options.onConfirm();
  });

  return {
    el: root,
    open,
    close: () => hide(true),
    isOpen: () => shown,
    setMessage: (message: string) => {
      text.textContent = message;
    },
  };
}
