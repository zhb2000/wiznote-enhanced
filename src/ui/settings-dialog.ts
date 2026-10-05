import { config, META } from '../config';
import { store } from '../store';
import { logger, setDebug } from '../utils/log';
import { getWizApp } from '../wiz-app';
import { createConfirmRow } from './kit/confirm';
import { el } from './kit/el';
import { createModal } from './kit/modal';
import { queryOverlay } from './panel/host';
import { showToast } from './toast';

const log = logger('settings');

const P = config.prefix;

export interface SettingsDialogOptions {
  /** 设置发生变化时通知外面（油猴菜单的标题要跟着重注册） */
  onChange?: () => void;
}

/** 判断当前页的公式引擎来自哪里，用于验证离线修复是否生效 */
function describeMathJax(): string {
  const script = document.getElementById('MathJax-script');
  if (!script) return '未加载（当前页还没出现过公式）';
  return script.hasAttribute('src') ? '第三方 CDN（需要联网）' : '本地注入（离线可用）';
}

/**
 * 为知宿主是否就绪。
 *
 * ⚠️ 用 `app.os`（`macOS` 这种）而不是 `app.platform` —— 后者是个
 * `{ isMac, isWindows, … }` 对象，直接插值会印出 `[object Object]`。
 */
function describeHost(): string {
  const app = getWizApp();
  if (!app) return '未就绪（可能还在登录页）';
  const kind = app.isElectron ? '桌面端' : app.isMobile ? '移动端' : 'Web 端';
  return `${kind} / ${app.os} / v${app.version}`;
}

/** 诊断区要展示（也用于“复制”）的整段文本 */
function diagnosticText(): string {
  return [
    `${META.name} v${META.version}`,
    `页面：${location.href}`,
    `公式引擎：${describeMathJax()}`,
    `为知宿主：${describeHost()}`,
    `调试日志：${store.get('debug') ? '开' : '关'}`,
  ].join('\n');
}

/**
 * 设置对话框。
 *
 * 为什么要有它：油猴菜单那种列表只能表达布尔量、标题还得靠重注册伪造、没法写说明，
 * 一旦设置项超过几个就很难看。设置放在页面里的对话框，油猴菜单只留一个入口。
 *
 * **范围**：只放“脚本自身”的全局项 + 诊断。
 * 导出选项（图片 / 评论 / 元数据 …）不在这里 —— 那是在导出对话框里临时决定的，
 * 只是被记住了而已，不属于设置。
 */
export function openSettingsDialog(options: SettingsDialogOptions = {}): void {
  if (queryOverlay(`.${P}-settings-dialog`)) return;

  const notifyChange = (): void => options.onChange?.();

  /*
   * 重置的二次确认走共享的确认行（`ui/kit/confirm.ts`）—— 和导出对话框的“关闭”同一套。
   */
  const resetConfirm = createConfirmRow({
    message: '恢复脚本的默认设置并重置偏好选项',
    confirmLabel: '确定重置',
    cancelLabel: '暂不重置',
    onConfirm: () => {
      store.reset();
      setDebug(store.get('debug'));
      syncers.forEach((sync) => sync());
      notifyChange();
      log.info('脚本设置已重置');
      showReloadBanner('设置已重置');
    },
  });

  const modal = createModal({
    title: '设置',
    dialogClass: `${P}-settings-dialog`,
    // 这个对话框原本没有要裁决的关闭手势，现在多了一条：确认行亮着时 Esc 只收它
    onDismiss: () => {
      if (resetConfirm.isOpen()) {
        resetConfirm.close();
        return;
      }
      modal.close();
    },
  });

  /* 需要刷新才生效的改动，用头部下方那条横幅提示（复用模态壳的 banner 插槽） */
  const bannerText = el('span', `${P}-modal-banner-text`);
  const reloadBtn = el('button', `${P}-btn`, '立即刷新');
  reloadBtn.type = 'button';
  reloadBtn.addEventListener('click', () => location.reload());

  const showReloadBanner = (what: string): void => {
    bannerText.textContent = `${what}，刷新页面后才生效。`;
    modal.banner.replaceChildren(bannerText, reloadBtn);
    // 显隐归壳管（`setBanner`）：这里是对话框已经落定之后才长出来的一条，会带高度补间
    modal.setBanner(true);
  };

  const body = el('div', `${P}-settings-body`);
  /** 重置后要把所有控件按 store 重新同步，这里登记各自的刷新函数 */
  const syncers: (() => void)[] = [];

  const section = (title: string): void => {
    body.append(el('div', `${P}-settings-section`, title));
  };

  /** 一行开关：左边标题 + 说明，右边控件 */
  const addToggle = (
    label: string,
    hint: string,
    get: () => boolean,
    set: (on: boolean) => void,
  ): HTMLInputElement => {
    const rowEl = el('label', `${P}-settings-row`);
    const text = el('span', `${P}-settings-text`);
    text.append(el('span', `${P}-settings-label`, label), el('span', `${P}-settings-hint`, hint));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => {
      set(input.checked);
      notifyChange();
    });
    rowEl.append(text, input);
    body.append(rowEl);
    syncers.push(() => {
      input.checked = get();
    });
    return input;
  };

  /** 只读的一行（诊断用） */
  const addInfo = (label: string, value: string): HTMLElement => {
    const rowEl = el('div', `${P}-settings-row ${P}-settings-row-static`);
    rowEl.append(el('span', `${P}-settings-label`, label), el('span', `${P}-settings-value`, value));
    body.append(rowEl);
    return rowEl;
  };

  /**
   * 只读的一行，值是个外链（“关于”用）。
   *
   * 行式与诊断区一致（标签在左、值紧随其后），别竖排 —— 竖排会让这一段的
   * 左对齐参差、右侧空得更明显。末尾带一个 `↗` 外链角标。
   */
  const addLink = (label: string, href: string, text = href): void => {
    const rowEl = el('div', `${P}-settings-row ${P}-settings-row-static`);
    const link = el('a', `${P}-settings-link`, text);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    // 角标作为 <a> 的子元素：跟链接一起可点、一起出下划线；纯装饰，不让读屏念出来
    const icon = el('span', `${P}-settings-link-icon`, '↗');
    icon.setAttribute('aria-hidden', 'true');
    // ⚠️ 间距用 <a> 里的一个空格承担，别用 CSS margin —— 下划线不覆盖 margin，
    // 那样文字与角标之间的线会断开（实测过）
    link.append(' ', icon);
    rowEl.append(el('span', `${P}-settings-label`, label), link);
    body.append(rowEl);
  };

  section('通用');

  addToggle('调试日志', '把详细过程写进浏览器控制台，排查问题时打开', () => store.get('debug'), (on) => {
    store.set('debug', on);
    setDebug(on);
    log.info(`调试日志已${on ? '开启' : '关闭'}`);
  });

  addToggle(
    '离线公式渲染',
    '用本地缓存的 MathJax 渲染公式；断网或 CDN 被墙时也能正常显示公式',
    () => store.get('offlineMathJax'),
    (on) => {
      store.set('offlineMathJax', on);
      // 这个开关在 document-start 就被读走了，改完必须刷新
      showReloadBanner('“离线公式渲染”已改动');
    },
  );

  section('诊断');

  addInfo('脚本版本', `${META.name} v${META.version}`);
  addInfo('当前页面', location.pathname);
  addInfo('公式引擎', describeMathJax());
  addInfo('为知宿主', describeHost());

  const copyRow = el('div', `${P}-settings-row ${P}-settings-row-static`);
  const copyBtn = el('button', `${P}-btn`, '复制诊断信息');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(diagnosticText());
        showToast('诊断信息已复制');
      } catch (error) {
        log.warn('复制失败', error);
        showToast('复制失败，可手动选中上面的内容', 'error');
      }
    })();
  });
  copyRow.append(copyBtn);
  body.append(copyRow);

  section('关于');

  addLink('作者', META.authorUrl, META.author);
  addLink('项目地址', META.homepage, META.homepageLabel);

  modal.body.append(body);

  /* ---------------- 底部 ---------------- */

  const resetBtn = el('button', `${P}-btn`, '重置脚本设置');
  resetBtn.type = 'button';
  // 会丢东西的按钮都要能先 hover 出后果（悬浮条那几个按钮同理），别让人靠点击去发现
  resetBtn.title = '恢复默认设置；你改过的开关会一起回默认';
  const closeBtn = el('button', `${P}-btn ${P}-btn-primary`, '关闭');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => modal.close());

  const actions = el('div', `${P}-settings-actions`);
  actions.append(closeBtn);
  modal.foot.append(resetBtn, actions);

  // 确认行挂在按钮行正上方（模态壳的 notice 槽）：确认与触发它的按钮不隔一个屏幕
  modal.notice.append(resetConfirm.el);
  resetBtn.addEventListener('click', () => resetConfirm.open(resetBtn));
}
