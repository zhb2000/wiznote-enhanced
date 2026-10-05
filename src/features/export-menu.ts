import { config } from '../config';
import { findNoteFromElement, findSelectedNotes, getActiveEditor } from '../export/app-bridge';
import type { NoteRef } from '../export/types';
import { openExportDialog } from '../ui/export-dialog';
import { showToast } from '../ui/toast';
import { logger } from '../utils/log';

const log = logger('menu');

/**
 * 两个导出入口：
 *   A. 笔记列表的右键菜单（应用自带的 React/MUI 菜单，Web 版把“导出为Markdown”藏了，
 *      我们注入自己的菜单项）
 *   B. 阅读界面编辑器的右键菜单（应用自带，用 DOM 注入追加菜单项）
 *
 * ⚠️ 这里依赖的 DOM 契约（都集中在下方的 SELECTOR 里）：
 *   - 列表菜单根节点 id: context-menu-note-list
 *   - 编辑器菜单容器 class: editor-menu-scroll-container / editor-command-item
 */

const SELECTOR = {
  /** 笔记列表右键菜单根节点 */
  listMenu: '#context-menu-note-list',
  /** 编辑器右键菜单的滚动容器 */
  editorMenuScroll: '.editor-menu-scroll-container',
  /** 编辑器右键菜单所在的 tippy 主题盒 */
  editorMenuBox: '.tippy-box[data-theme~="editor-context-menu"]',
  /** 标记我们注入的菜单项，避免重复注入 */
  ours: '[data-wze-export]',
};

const P = config.prefix;

/**
 * 应用菜单项的外观（内外边距 / 圆角 / 字体 / hover 底色）挂在 `.MuiMenuItem-root` 这套
 * class 上，**不是从容器继承**的 —— 注入的 `li` 只带 `menu-item` 的话，左边距会比邻居少 8px
 * （实测应用项 `margin: 0 8px; padding: 6px 16px; border-radius: 6px`，我们的没有 margin）。
 *
 * 所以直接把同一套 class 挂上去，让应用自己的规则来管，顺带跟随它的主题（含暗色）。
 * 这里用的是 MUI 的**稳定**类名（v4/v5 都有），没碰 jssXXX 那种生成名。
 */
const APP_MENU_ITEM_CLASS = [
  'MuiButtonBase-root',
  'MuiListItem-root',
  'MuiMenuItem-root',
  'MuiMenuItem-gutters',
  'MuiListItem-gutters',
  'MuiListItem-button',
].join(' ');

let lastContextTarget: EventTarget | null = null;
/** 只有右键前后这一小段时间才去检查菜单，避免全程监听 DOM 变化 */
let watchUntil = 0;
let scheduled = false;

/* ------------------------------------------------------------------ */
/* 菜单项 DOM                                                          */
/* ------------------------------------------------------------------ */

function buildListItem(label: string, onClick: () => void): HTMLElement {
  const item = document.createElement('li');
  item.className = `${APP_MENU_ITEM_CLASS} menu-item ${P}-menu-item`;
  item.setAttribute('role', 'menuitem');
  item.setAttribute('tabindex', '-1');
  item.setAttribute('data-wze-export', '1');
  const text = document.createElement('span');
  text.className = 'menu-text';
  text.textContent = label;
  item.append(text);
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return item;
}

function buildEditorItem(label: string, onClick: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = `editor-command-item menu-item clickable-item ${P}-menu-item`;
  item.setAttribute('data-wze-export', '1');
  const text = document.createElement('div');
  text.className = 'menu-text';
  text.textContent = label;
  item.append(text);
  item.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return item;
}

/**
 * 宿主自己的防溢出边距（MUI Popover 的 marginThreshold）：贴边保留 16px。
 * 实测它把菜单定位成 `740 − 高度 − 16`，我们按同一个口径算，结果和它完全一致。
 */
const VIEWPORT_MARGIN = 16;

/**
 * 让我们塞进去的那一项不会把菜单顶出视口。
 *
 * 宿主（MUI v4 的 Popover）是**插入菜单的那一刻**就把位置算好的，比我们能观察到的任何时机都早，
 * 所以它算的时候我们的项还不存在 —— 多出来的这一项（33px，标签带篇数时还会更宽）不在它的账里，
 * 菜单会顶穿视口下沿，“导出为 Markdown”被窗口边切掉一截。
 *
 * 这里分两步做：
 *   1. 先自己把 `top`/`left` 挪到位 —— 同一帧生效，屏幕上看不到“先被挡住再抬起来”的过渡；
 *   2. 再补发一个 resize，让宿主的内部定位状态也收敛到同一个结果，
 *      免得它之后某次重渲染按旧值把菜单弹回溢出位置。
 *
 * 只在真的溢出时才做，并且同一个菜单只做一次（避免 resize → 重建 → 又溢出 → 再 resize 的循环）。
 * 量尺寸用 offset* 而不是 getBoundingClientRect()：后者会吃 MUI 展开动画的 scale 变换，
 * 把菜单量小导致漏判；这里 offsetParent 正是铺满视口的 .MuiPopover-root，offset 即视口坐标。
 */
const nudgedBoxes = new WeakSet<Element>();

function keepListMenuInViewport(injected: Element): void {
  const box = injected.closest('.MuiPopover-paper');
  if (!(box instanceof HTMLElement) || nudgedBoxes.has(box)) return;

  const dy = box.offsetTop + box.offsetHeight - (window.innerHeight - VIEWPORT_MARGIN);
  const dx = box.offsetLeft + box.offsetWidth - (window.innerWidth - VIEWPORT_MARGIN);
  if (dy <= 0 && dx <= 0) return;
  nudgedBoxes.add(box);

  if (dy > 0) box.style.top = `${Math.max(VIEWPORT_MARGIN, box.offsetTop - dy)}px`;
  if (dx > 0) box.style.left = `${Math.max(VIEWPORT_MARGIN, box.offsetLeft - dx)}px`;

  window.dispatchEvent(new Event('resize'));
}

/** 关掉应用自己的菜单，避免和导出对话框叠在一起 */
function closeAppMenu(menuRoot: Element): void {
  // MUI 的 Menu 点了 backdrop 就会 onClose
  const backdrop = document.querySelector('.MuiBackdrop-root');
  if (backdrop instanceof HTMLElement) {
    backdrop.click();
    return;
  }
  menuRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  getActiveEditor()?.contextMenu?.hide?.();
}

/* ------------------------------------------------------------------ */
/* 目标笔记                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取右键要导出的笔记。
 * 和应用的逻辑一致：右键的笔记如果落在多选集合里，就导出整个多选集合。
 */
function resolveTargets(target: EventTarget | null): NoteRef[] {
  const note = findNoteFromElement(target);
  const selected = findSelectedNotes(target);
  if (selected && selected.length > 1) {
    const inSelection = !!note && selected.some((item) => item.docGuid === note.docGuid);
    if (inSelection) return selected;
  }
  return note ? [note] : [];
}

function runExport(target: EventTarget | null, source: string): void {
  const targets = resolveTargets(target);
  if (targets.length === 0) {
    showToast('没能识别出笔记，换个位置再试一次', 'error');
    log.warn('无法从右键位置解析出笔记');
    return;
  }
  openExportDialog(targets, source);
}

/* ------------------------------------------------------------------ */
/* 注入                                                                */
/* ------------------------------------------------------------------ */

function injectListMenu(): void {
  const menu = document.querySelector(SELECTOR.listMenu);
  if (!menu) return;
  const list = menu.querySelector('ul');
  if (!list) return;

  const existing = list.querySelector(SELECTOR.ours);
  const targets = resolveTargets(lastContextTarget);
  const label = targets.length > 1 ? `导出为 Markdown（${targets.length} 篇）` : '导出为 Markdown';

  if (existing) {
    const text = existing.querySelector('.menu-text');
    if (text && text.textContent !== label) text.textContent = label;
    // 应用重建列表时可能把我们挤到中间，顺手挪回最后
    if (list.lastElementChild !== existing) list.append(existing);
    // 标签变长可能让菜单变宽，同样要确认没顶出视口
    keepListMenuInViewport(existing);
    return;
  }

  const item = buildListItem(label, () => {
    closeAppMenu(menu);
    runExport(lastContextTarget, '笔记列表');
  });
  // 放在最后一项。注意是挂到外层 ul 上（应用自己的那组项在它内部的一个 MuiList 里），
  // 不要去改应用那个 React 管理的列表，免得被重建时抹掉。
  list.append(item);
  // 宿主可能是在我们注入之前就定位完了，多出来的这一项会把菜单顶出视口
  keepListMenuInViewport(item);
}

function injectEditorMenu(): void {
  const containers = document.querySelectorAll(SELECTOR.editorMenuScroll);
  containers.forEach((container) => {
    // 只注入顶层菜单，不进子菜单
    const box = container.closest(SELECTOR.editorMenuBox);
    if (!box) return;
    if (box.querySelector(`:scope > .tippy-content ${SELECTOR.editorMenuScroll}`) !== container) return;
    if (container.querySelector(SELECTOR.ours)) return;

    const item = buildEditorItem('导出为 Markdown', () => {
      closeAppMenu(container);
      runExport(lastContextTarget, '阅读界面');
    });
    container.append(item);
  });
}

function flush(): void {
  scheduled = false;
  if (Date.now() > watchUntil) return;
  try {
    injectListMenu();
    injectEditorMenu();
  } catch (error) {
    log.error('注入导出菜单失败', error);
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(flush);
}

/** 注册两个入口 */
export function installExportMenus(): void {
  document.addEventListener(
    'contextmenu',
    (event) => {
      lastContextTarget = event.target;
      watchUntil = Date.now() + 2000;
      schedule();
    },
    true,
  );

  // 应用右键菜单里也带“导出为Word”这类项，点击后会走应用自己的逻辑，
  // 我们只关心自己注入的节点，所以这里只观察新增节点。
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  log.info('导出菜单已就绪');
}
