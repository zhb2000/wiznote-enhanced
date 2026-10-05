#!/usr/bin/env node
/**
 * 启动一个“可被 AI 调试”的 Chrome：
 *   - 使用独立 profile（Chrome 136+ 起，远程调试不再允许使用默认 profile 目录）
 *   - 打开 CDP 调试端口，供 chrome-devtools-mcp 通过 --browser-url 接入
 *   - 顺带打开开发态脚本的安装页与目标站点
 *
 * 用法：node scripts/dev-chrome.mjs [--dry-run]
 * 环境变量：WZE_DEBUG_PORT / WZE_DEV_PORT / WZE_TARGET_URL / WZE_PROFILE_DIR / WZE_CHROME_PATH
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEBUG_PORT = Number(process.env.WZE_DEBUG_PORT ?? 9222);
const DEV_PORT = Number(process.env.WZE_DEV_PORT ?? 5173);
const TARGET_URL = process.env.WZE_TARGET_URL ?? 'https://www.wiz.cn/xapp/index.html';
const INSTALL_URL = `http://127.0.0.1:${DEV_PORT}/__vite-plugin-monkey.install.user.js`;
const PROFILE_DIR =
  process.env.WZE_PROFILE_DIR ?? join(homedir(), '.cache', 'chrome-wiznote-enhanced', 'chrome-profile');
const DRY_RUN = process.argv.includes('--dry-run');

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  win32: [
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

function findChrome() {
  if (process.env.WZE_CHROME_PATH) return process.env.WZE_CHROME_PATH;
  const candidates = CHROME_CANDIDATES[process.platform] ?? [];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const chromeArgs = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  INSTALL_URL,
  TARGET_URL,
];

const chromePath = findChrome();
if (!chromePath) {
  console.error('[wiznote-enhanced] 未找到 Chrome，可用 WZE_CHROME_PATH 显式指定可执行文件路径。');
  process.exit(1);
}

const isFirstRun = !existsSync(PROFILE_DIR);
const alreadyRunning = await isPortOpen(DEBUG_PORT);

if (DRY_RUN) {
  console.log('[wiznote-enhanced] dry-run，不会启动浏览器');
  console.log(`  chrome    : ${chromePath}`);
  console.log(`  profile   : ${PROFILE_DIR}${isFirstRun ? ' (首次运行，将自动创建)' : ''}`);
  console.log(`  cdp port  : ${DEBUG_PORT} ${alreadyRunning ? '(已被占用，将直接复用)' : ''}`);
  console.log(`  install   : ${INSTALL_URL}`);
  console.log(`  target    : ${TARGET_URL}`);
  console.log(`  args      : ${chromeArgs.join(' ')}`);
  process.exit(0);
}

if (alreadyRunning) {
  console.log(`[wiznote-enhanced] ${DEBUG_PORT} 端口已有调试中的 Chrome，直接复用，不再启动新实例。`);
} else {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(chromePath, chromeArgs, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    if (await isPortOpen(DEBUG_PORT)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[wiznote-enhanced] 已启动调试用 Chrome，profile: ${PROFILE_DIR}`);
}

console.log(`
  调试实例
    CDP 端口   http://127.0.0.1:${DEBUG_PORT}
    脚本安装   ${INSTALL_URL}
    目标站点   ${TARGET_URL}
`);

if (isFirstRun) {
  console.log(`  这个 profile 是新建的，首次需要手动做三件事：
    1. 安装 Tampermonkey 扩展：https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo
       并在 chrome://extensions 打开右上角“开发者模式”，否则 Chrome 120+ 不会注入用户脚本
    2. 打开上面的“脚本安装”地址，确认安装 server:wiznote-enhanced
    3. 在目标站点登录为知笔记账号（登录态保存在该 profile 里，之后可复用）
  完成后 AI 即可通过 chrome-devtools MCP 接管这个浏览器。
`);
}
