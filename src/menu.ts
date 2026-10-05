import { store } from './store';
import { openSettingsDialog } from './ui/settings-dialog';
import { logger, setDebug } from './utils/log';

const log = logger('menu');

interface ToggleItem {
  kind: 'toggle';
  title: (enabled: boolean) => string;
  get: () => boolean;
  set: (enabled: boolean) => void;
  onToggle?: (enabled: boolean) => void;
}

interface ActionItem {
  kind: 'action';
  title: string;
  onClick: () => void;
}

type MenuItem = ToggleItem | ActionItem;

const items: MenuItem[] = [];
let registeredIds: (string | number)[] = [];

/**
 * 重新注册整个菜单。
 *
 * 油猴菜单的标题在注册那一刻就固定了，只改 store 不会让标题跟着变，
 * 必须注销后重新注册。这里是整体重注册而不是只重注册被点的那一项，
 * 目的是保持菜单顺序不变；setTimeout 用于等油猴收起当前菜单后再重建，
 * 否则部分版本会刷新不生效。
 */
function renderMenu(): void {
  for (const id of registeredIds) GM_unregisterMenuCommand(id);
  registeredIds = items.map((item) => {
    if (item.kind === 'action') {
      return GM_registerMenuCommand(item.title, item.onClick);
    }
    return GM_registerMenuCommand(item.title(item.get()), () => {
      const next = !item.get();
      item.set(next);
      item.onToggle?.(next);
      window.setTimeout(renderMenu);
    });
  });
}

/** 设置被别处改了（比如设置对话框）之后，让菜单标题跟上 */
export function refreshMenus(): void {
  renderMenu();
}

/**
 * 油猴菜单只留“一个入口 + 保命项”。
 *
 * 真正的设置界面是页面里的对话框（`ui/settings-dialog.ts`）—— 油猴菜单这种只能表达
 * 布尔量、标题还得靠重注册伪造、写不下说明的列表，做设置 UI 太简陋。
 *
 * 保命项的意义：页面 UI 万一因为宿主改版挂了，还能从这里关掉“离线公式渲染”
 * （唯一可能影响页面行为的功能）或重置设置自救。
 */
export function registerMenus(): void {
  items.length = 0;
  items.push(
    {
      kind: 'action',
      title: '设置',
      onClick: () => openSettingsDialog({ onChange: refreshMenus }),
    },
    {
      kind: 'toggle',
      title: (enabled) => `离线公式渲染：${enabled ? '开' : '关'}（刷新生效）`,
      get: () => store.get('offlineMathJax'),
      set: (enabled) => store.set('offlineMathJax', enabled),
      onToggle: (enabled) => log.info(`离线公式渲染已${enabled ? '开启' : '关闭'}，刷新页面生效`),
    },
    {
      kind: 'action',
      title: '重置脚本设置',
      onClick: () => {
        store.reset();
        setDebug(store.get('debug'));
        renderMenu();
        log.info('脚本设置已重置');
      },
    },
  );

  renderMenu();
}
