import './style.css';
import { config, META } from './config';
import { watchServiceWorkerMessages } from './export/app-bridge';
import { installExportMenus } from './features/export-menu';
import { installOfflineMathJax } from './features/offline-mathjax';
import { registerMenus } from './menu';
import { store } from './store';
import { initTaskBar } from './ui/export-tasks';
import { $, onDomReady } from './utils/dom';
import { logger, setDebug } from './utils/log';
import { getWizApp } from './wiz-app';

const log = logger('main');

// 必须在 document-start 同步执行：要抢在页面脚本之前占住 window.MathJax
if (store.get('offlineMathJax')) {
  installOfflineMathJax();
}

function bootstrap(): void {
  setDebug(store.get('debug'));
  registerMenus();

  log.info(`${META.name} v${META.version} 已启动`, location.href);
  log.debug('appRoot =', $(config.selectors.appRoot));

  const wizApp = getWizApp();
  log.debug('wizApp =', wizApp ? `v${wizApp.version} / ${wizApp.os}` : '未找到（可能还在登录页）');

  // 笔记列表 / 阅读界面右键菜单里的“导出为 Markdown”
  installExportMenus();

  // 导出任务最小化之后的悬浮条（此时还没有任务，不会产生 DOM）
  initTaskBar();

  // 顺手记录 SW 同步协作笔记时带出的 ksURL，导出时可用于主动触发同步
  watchServiceWorkerMessages();
}

onDomReady(bootstrap);
