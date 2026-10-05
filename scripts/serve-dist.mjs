#!/usr/bin/env node
/**
 * 用 HTTP 暴露 dist/，方便油猴从 http:// 地址安装/覆盖构建产物。
 *
 * 配合 `npm run build:watch` 使用：改代码 → dist 重新产出 → 在油猴里重新安装即可。
 * 相比直接打开 file:// 路径，http:// 地址对油猴更可靠，也方便交给 AI 用浏览器自动打开。
 *
 * 用法：node scripts/serve-dist.mjs
 * 环境变量：WZE_DIST_PORT（默认 8080）
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const PORT = Number(process.env.WZE_DIST_PORT ?? 8080);
const ROOT = normalize(join(process.cwd(), 'dist'));
const DEFAULT_FILE = 'wiznote-enhanced.user.js';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function resolveTarget(pathname) {
  const relative = pathname === '/' ? DEFAULT_FILE : pathname.replace(/^\/+/, '');
  const target = normalize(join(ROOT, relative));
  // 防目录穿越：必须落在 dist 内
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const target = resolveTarget(pathname);

  if (!target) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 forbidden\n');
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}\n先执行一次 npm run build\n`);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(target));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`
  构建产物已通过 HTTP 暴露

    安装 / 覆盖  http://127.0.0.1:${PORT}/${DEFAULT_FILE}
    目录         ${ROOT}
`);
});
