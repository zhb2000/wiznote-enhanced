import { config } from '../../config';
import { getOverlayRoot } from '../panel/host';
import { el } from './el';
import { focusablesIn, focusedElement } from './focus';
import { fadeIn, fadeOut, morphIn, morphOut, setRevealed, type MorphRect } from './morph';

const P = config.prefix;

/** 模态标题的 id 序号：`aria-labelledby` 得指向一个真实存在的节点 */
let seq = 0;

/** 模态壳的插槽与句柄：壳只管外框和“怎么关”，内容全部由调用方填 */
export interface ModalHandle {
  /** 遮罩。点它**不会**关闭（见下面的说明），只负责挡住下层页面 */
  mask: HTMLDivElement;
  /**
   * 头部下方横幅的**内容容器**，默认隐藏。放**通知**：“需要刷新”这类与具体按钮无关的整条内容。
   *
   * ⚠️ 往里塞内容是调用方的事，**显隐必须走 `setBanner()`** —— 这个节点只是内层，真正被补间
   * 的是它外面那层（理由与确认行那两层一样：外层不能带 padding，见 `setBanner`）。
   */
  banner: HTMLDivElement;
  /**
   * 亮出 / 收起头部横幅（0 ↔ 自然高度，`kit/morph.ts` 的 `setRevealed`）。
   *
   * 内容原样留着，只是收起来 —— 再亮出来时调用方不用重新填。状态没变时**什么都不做**，
   * 所以调用方可以每次渲染都调它（导出对话框就是每帧调一次），不必自己记
   * “上一轮是开着还是关着”（另存一份状态迟早漏一处）。
   *
   * 跟着对话框一起生出来的那条横幅**不补间**：它和对话框的入场变形是同一件事，再自己长一下
   * 就多了一拍。判据由壳自己看（入场补间是否已经开始），调用方不用管。
   */
  setBanner(show: boolean): void;
  /** 主体插槽 */
  body: HTMLDivElement;
  /**
   * 主体与底部之间的插槽，放**决策**：待决确认行（`ui/kit/confirm.ts`）。
   *
   * 调用方**不用维护它的 `hidden`** —— 有没有内容由 CSS 看（`:has()`），
   * 否则确认行自己开合、插槽另存一份状态，迟早漏一处。插槽只管位置与外观，
   * 开合完全归控件。
   *
   * ⚠️ 它自己**不带 padding**（只有那条分隔线与底色）：内边距在确认行的内层
   * （`panel.css` 的 `.wze-modal-notice .wze-confirm-inner`）。留在插槽上的话，确认行
   * 露头时那一圈空白会**先**跳出来 —— 插槽的 padding 补不了。要往这个槽里放别的东西，
   * 得自己带内边距。
   */
  notice: HTMLDivElement;
  /** 底部插槽（`<footer>` 在 DOM 类型里就是 HTMLElement） */
  foot: HTMLElement;
  /**
   * 头部右上角那个按钮。
   *
   * 壳把它暴露出来是为了让调用方能改它的**语义**：导出对话框在任务跑着的时候
   * 把它换成一个“最小化”（点它只是收起面板，不再等于放弃），文案与 aria-label
   * 都由调用方按当前状态设置。壳自己不管这些。
   */
  closeButton: HTMLButtonElement;
  /**
   * 收起并解绑（由调用方决定何时调，见 onDismiss）。
   *
   * **带动画**：`to` 给了就收成那个矩形（“回悬浮条去”），不给就原地缩小淡出（“销毁”）。
   * 返回的 Promise 在遮罩真的摘掉时 resolve —— 需要让别的东西接上（比如把悬浮条放出来）
   * 就在那之后做，别让两个控件同时亮着。
   */
  close(to?: MorphRect | null): Promise<void>;
  /** 还未收起（收起动画跑着的那段时间也算已收起：它已经不再接受操作了） */
  isOpen(): boolean;
}

/** 关闭手势的来源：两者语义相同，但“误按代价”差很多，调用方可能区别对待 */
export type ModalDismissSource = 'close' | 'escape';

export interface ModalOptions {
  /** 标题，创建时固定 */
  title: string;
  /** 追加到对话框上的 class，用于尺寸之类的差异（如导出对话框要 880px） */
  dialogClass?: string;
  /**
   * 打开时从哪儿长出来（视口矩形，通常是悬浮条当前所在的位置）。
   *
   * 只管入场；退场的目标由调用方在 `close(to)` 时现给 —— 同一段“来”和“回”往往不是
   * 同一件事：从悬浮条点开是“从它长出来”，而收起可能是回悬浮条（最小化），也可能是
   * 原地销毁（草稿取消 / 结束后的关闭），后者给 `null` 才对。
   */
  origin?: MorphRect | null;
  /**
   * 用户**请求**关闭（点 × 或按 Esc）时调用，带上来源。
   *
   * 传了它就由调用方裁决，壳自己不会关 —— 需要关时调用方自己调 `close()`。
   * 这正是导出对话框所需要的：任务跑着的时候，“关闭”要变成“最小化”，
   * 而空闲时才是真的关掉。壳负责手势与元素，语义留给业务。
   */
  onDismiss?: (source: ModalDismissSource) => void;
}

/**
 * 面板里的模态壳（导出对话框 / 设置对话框共用）。
 *
 * 抽它的理由：这两个对话框的外框与关闭规则必须一致，而这些规则是踩过坑才定下来的，
 * 复制一份必然会走样：
 *
 * - **点遮罩空白不关闭** —— 最容易误触的手势（尤其中途一慌就乱点），遮罩只挡下层页面；
 * - **× 与 Esc 都只是“请求关闭”** —— 由调用方裁决（导出要按任务状态决定是关掉还是最小化）；
 * - **横幅放通知、底部 `notice` 放决策** —— 通知（“需要刷新”）与具体按钮无关，留在顶部；
 *   决策（“关闭会掉什么”）必须贴着触发它的按钮，所以有独立的 `notice` 槽。两者能同时出现，
 *   谁也不挡谁；
 * - **两个槽露头 / 收起都是补间**（`kit/morph.ts` 的 `setRevealed`）：横幅走 `setBanner()`、
 *   确认行走 `ui/kit/confirm.ts`，两者都分两层（外层只管被补间的高度）。瞬现一下会让整块界面
 *   凭空变高，和“这块内容长出来了”的读感不是一回事；
 * - 尺寸差异只体现在 `dialogClass`，其余完全一致；
 * - 样式在 `panel.css` 的 `.wze-modal-*`，和其他 UI 一样锁在 Shadow DOM 里；
 * - **焦点也全归壳管**（`trapTab()` / `restoreFocus()`，能 Tab 到哪些元素与“焦点现在在哪”
 *   由 `kit/focus.ts` 提供）：打开时焦点落到容器自己（`tabindex="-1"` + `aria-labelledby`，
 *   读屏先念“这是什么对话框、叫什么”，而不是直接念第一个按钮）、Tab 在对话框内环绕、点遮罩
 *   空白不把焦点丢给页面、关闭后还给打开它的那个元素。`aria-modal="true"` 承诺的“外面不可达”
 *   就是靠这一组兑现的 —— 只有 `aria-modal` 而不拦 Tab 的话，键盘会一路走进遮罩底下的宿主界面。
 *
 *   还焦点有一条**它办不到的**尾巴：要还的那个元素可能已经被拆掉重建了（悬浮条那一行就是，
 *   见 `ui/export-tasks.ts` 的 `restoreRowFocus()`），壳只按“原节点还在不在”判断，剩下的
 *   由那一侧按任务 id 接着还。
 *
 * 入场 / 退场各有一段变形补间（见 `kit/morph.ts`）：从 `origin` 长出来、收成 `close(to)` 给的
 * 那个矩形。**这段动画不影响任何状态** —— 摘元素仍然只有 `close()` 一处，关闭手势的裁决
 * 也仍然全在 `onDismiss` 里，只是最后那一下“从屏幕上消失”改成了两三百毫秒。
 */
export function createModal(options: ModalOptions): ModalHandle {
  /** 打开之前焦点在哪儿 —— 关闭时还给它（见 `restoreFocus()`） */
  const restoreTarget = focusedElement();

  const mask = el('div', `${P}-modal-mask`);
  const dialog = el('div', `${P}-modal`);
  for (const name of options.dialogClass?.split(/\s+/).filter(Boolean) ?? []) {
    dialog.classList.add(name);
  }
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  /*
   * 容器自己可聚焦、但不进 Tab 顺序（`tabindex="-1"`）：打开时把焦点放在它身上，读屏才会
   * 先念“这是个对话框、叫什么名字”（`aria-labelledby`），而不是直接念第一个按钮。
   * 它自己的焦点圈由 `panel.css` 的 `.wze-modal:focus` 收掉 —— 它不是控件。
   */
  dialog.tabIndex = -1;

  const head = el('header', `${P}-modal-head`);
  const title = el('span', `${P}-modal-title`, options.title);
  title.id = `${P}-modal-title-${(seq += 1)}`;
  head.append(title);
  dialog.setAttribute('aria-labelledby', title.id);

  const closeBtn = el('button', `${P}-modal-close`, '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  head.append(closeBtn);

  /*
   * 横幅分两层，和确认行（`kit/confirm.ts`）同一个理由：外层只负责被补间的高度，间距与内边距
   * 全在内层 —— `box-sizing: border-box` 下 `height` 压不过 padding，padding 留在外层会让
   * 收起动画停在“只剩 padding 的厚度”上，再啪一下消失。
   */
  const bannerShell = el('div', `${P}-modal-banner`);
  const banner = el('div', `${P}-modal-banner-inner`);
  bannerShell.append(banner);
  bannerShell.hidden = true;
  const body = el('div', `${P}-modal-body`);
  const notice = el('div', `${P}-modal-notice`);
  const foot = el('footer', `${P}-modal-foot`);

  dialog.append(head, bannerShell, body, notice, foot);
  mask.append(dialog);
  getOverlayRoot().append(mask);

  let closing = false;
  /** 入场补间是否已经跑起来（见下面的 `close()`：没进场就被关掉时没什么可动画的） */
  let entered = false;

  /**
   * 横幅此刻该不该亮着。
   *
   * ⚠️ 不能用 `bannerShell.hidden` 当状态：收起动画跑着的那 160ms 里它还是 `false`，
   * 而这里必须**立刻**知道“它已经在收起了”（`setBanner(true)` 要能接得上，见 `setRevealed`
   * 的连点处理）。判断方式与 `kit/confirm.ts` 里的 `shown` 一致。
   */
  let bannerShown = false;

  /**
   * 亮出 / 收起横幅。
   *
   * 补间与否看 `entered`：跟着对话框**一起**生出来的横幅（调用方建完 DOM 就同步调了一次，
   * 那时入场补间还没跑）直接落定 —— 它和对话框的入场变形本来就是同一件事，再自己长一下
   * 只会多出一拍；对话框已经落定之后再出现的（点“开始导出”后那条提示、设置里那条
   * “需要刷新”）才是真的“长出来”，那才补。
   */
  function setBanner(show: boolean): void {
    if (bannerShown === show) return;
    bannerShown = show;
    setRevealed(bannerShell, show, entered);
  }

  /*
   * 入场：遮罩先藏起来、补间留到**下一帧**再量、再跑。
   *
   * 为什么要等一帧：内容由调用方在这个任务里**同步**填进插槽（`buildDialog` /
   * `openSettingsDialog` 都是建完 DOM 才返回），此刻量到的还是空壳的尺寸，拿它做 FLIP
   * 会收错地方。rAF 回调在绘制之前跑，所以等这一帧也不会先露一下原样。
   */
  mask.style.opacity = '0';
  requestAnimationFrame(() => {
    // 还没露过面就被关掉了（预检当场失败、草稿直接被替换），那就一直藏着
    if (closing || !mask.isConnected) return;
    entered = true;
    mask.style.opacity = '';
    fadeIn(mask);
    morphIn(dialog, options.origin ?? null);
    // 内容由调用方在同一个任务里同步填好，这一帧才量得到、也才轮得到它接焦点
    dialog.focus({ preventScroll: true });
  });

  /**
   * 把焦点还给打开它的那个元素。
   *
   * 时机是**遮罩摘掉之后、再等一帧**：调用方要等 `close()` 的 promise 才有机会收掉
   * “把悬浮条藏起来”那个 class（`setExportDialogOpen(false)`），而 `visibility: hidden`
   * 的元素**收不到焦点** —— 早一帧还等于没还（最小化那条路径每次都会踩到）。rAF 正好排在
   * 那一轮微任务之后、下一次绘制之前：悬浮条已经可见，而用户还没看到任何变化。
   *
   * 元素可能已经不在了（右键菜单项就是点完即拆的），所以先查 `isConnected`；
   * 还不了就**什么都不做**，别去抢页面别处的焦点。
   */
  function restoreFocus(): void {
    const target = restoreTarget;
    if (!target) return;
    requestAnimationFrame(() => {
      if (target.isConnected) target.focus();
    });
  }

  function close(to?: MorphRect | null): Promise<void> {
    if (closing) return Promise.resolve();
    closing = true;
    document.removeEventListener('keydown', onKeydown, true);
    // 压根没进过场：它一直是 `opacity: 0`，直接摘，别为了动画先把它亮出来。
    // 也没接过焦点（`dialog.focus()` 在那段 rAF 里，同样没跑），所以不必还
    if (!entered) {
      mask.remove();
      return Promise.resolve();
    }
    // 收起的这段时间它已经不算“开着”了，别再挡住底下：替换对话框时新的那个可能已经挂上了
    mask.style.pointerEvents = 'none';
    return Promise.all([fadeOut(mask), morphOut(dialog, to)]).then(() => {
      mask.remove();
      restoreFocus();
    });
  }

  function requestDismiss(source: ModalDismissSource): void {
    if (options.onDismiss) options.onDismiss(source);
    else void close();
  }

  /**
   * 把 Tab 关在对话框里。
   *
   * 遮罩底下就是宿主页面：不拦的话 Tab 会一路走进被挡住的那一层，焦点跑到用户看不见的地方
   * （`aria-modal="true"` 已经向辅助技术承诺了“外面不可达”，这里得真的做到）。
   *
   * 焦点**不在**对话框里时也要管（点过遮罩空白之后就会这样）：那一下先把焦点收进来，
   * 而不是放任它从页面某处继续往下走。
   */
  function trapTab(event: KeyboardEvent): void {
    const items = focusablesIn(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = getOverlayRoot().activeElement as HTMLElement | null;
    if (!active || active === dialog || !dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // 这段在 `document` 的**捕获**阶段跑：宿主页面自己也听着键，得先我们一步决定
    if (event.key === 'Escape') {
      event.stopPropagation();
      requestDismiss('escape');
      return;
    }
    if (event.key !== 'Tab' || closing) return;
    trapTab(event);
  }

  /*
   * 点遮罩空白**不关闭**（见文件头）。顺带把焦点留在原处：点在一个不可聚焦的元素上会让浏览器
   * 把焦点丢回 `body` —— 之后键盘用户按 Tab 就得靠上面的环绕逻辑把他捞回来。
   * 与其捞，不如一开始就别丢。
   */
  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) event.preventDefault();
  });

  closeBtn.addEventListener('click', () => requestDismiss('close'));
  document.addEventListener('keydown', onKeydown, true);

  return {
    mask,
    banner,
    setBanner,
    body,
    notice,
    foot,
    closeButton: closeBtn,
    close,
    isOpen: () => !closing && mask.isConnected,
  };
}
