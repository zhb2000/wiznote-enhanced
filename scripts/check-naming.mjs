#!/usr/bin/env node
/**
 * 文件 / 目录名（合法化 + 唯一化）的回归检查，不依赖任何测试框架。
 *
 * 为什么要单独有这么一个脚本：名字全部来自用户数据（笔记标题、附件名、资源名），
 * 而“什么样的名字真能落盘”是个很容易漏的判断题 —— 保留名、尾部点号、控制字符、
 * 255 字节上限，任何一条漏掉都会在**别人的操作系统上**表现为丢文件或互相覆盖。
 * 撞名规则还要求“查重要折叠（大小写 / Unicode）、落盘不许改字符”，手改很容易碰坏。
 *
 * 跑法：npm run check:naming
 *
 * ⚠️ `naming.ts` 刻意零依赖，就是为了能被这里直接 import（Node 直跑 TS 时解析不了
 * 无扩展名的相对导入）。**别给它加 import**，否则这个脚本会挂。
 */
import {
  NAME_BUDGET_BYTES,
  convertToValidFilename,
  createNameAllocator,
  foldName,
  portableName,
  toDiskName,
  withSuffix,
} from '../src/export/naming.ts';

let checks = 0;
let failures = 0;

function ok(label) {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  process.stdout.write(`FAIL ${label}${detail ? `\n       ${detail}` : ''}\n`);
}

function expect(label, condition, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

function expectEq(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  expect(label, same, same ? '' : `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
}

const bytes = (text) => Buffer.byteLength(text, 'utf8');

/* ------------------------------------------------------------------ */
/* 1. 对齐上游：convertToValidFilename 必须与应用的实现一字不差        */
/* ------------------------------------------------------------------ */

expectEq('非法字符换成空格', convertToValidFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
expectEq('首尾空白被 trim', convertToValidFilename('  标题  '), '标题');
expectEq('合法字符一个不动', convertToValidFilename('报告 v1.0（终稿）'), '报告 v1.0（终稿）');
// 这一条是“刻意不改上游”的守门人：加固那套不许渗进这里来
expectEq('上游不做保留名处理（加固才做）', convertToValidFilename('con.txt'), 'con.txt');
expectEq('上游不截断超长名', convertToValidFilename('中'.repeat(300)).length, 300);

/* ------------------------------------------------------------------ */
/* 2. 落盘加固：portableName                                          */
/* ------------------------------------------------------------------ */

// 2.1 控制字符
expectEq('C0 控制字符被剔除', portableName('标\u0000题\u000b名'), '标题名');
expectEq('换行 / 制表被剔除', portableName('标题\n名\t副'), '标题名副');
expectEq('DEL / C1 被剔除', portableName('a\u007fb\u009fc'), 'abc');

// 2.2 尾部点号与空格（Windows 会静默去掉，等于改名）
expectEq('尾部点号被去掉', portableName('报告.'), '报告');
expectEq('尾部点号 + 空格被去掉', portableName('报告. . '), '报告');
expectEq('尾部空格被去掉', portableName('报告 '), '报告');
expectEq('中间的点不动', portableName('a.b.c'), 'a.b.c');
expectEq('纯点号被清空（交给调用方兜底）', portableName('...'), '');

// 2.3 Windows 保留名
expectEq('CON 被转义', portableName('CON'), 'CON_');
expectEq('保留名带扩展名同样转义', portableName('con.txt'), 'con_.txt');
expectEq('大小写不敏感', portableName('Aux'), 'Aux_');
expectEq('COM1 被转义', portableName('com1.md'), 'com1_.md');
expectEq('LPT9 被转义', portableName('lpt9'), 'lpt9_');
expectEq('上标变体也被转义（Windows 11 起占用）', portableName('COM\u00b9'), 'COM\u00b9_');
expectEq('非保留名不误伤：CONSOLE', portableName('CONSOLE'), 'CONSOLE');
expectEq('非保留名不误伤：console.txt', portableName('console.txt'), 'console.txt');
expectEq('非保留名不误伤：COM10', portableName('com10'), 'com10');

// 2.4 超长截断（ext4 / APFS 单组件上限 255 字节，中文一字 3 字节）
{
  const long = 'a'.repeat(300) + '.pdf';
  const out = portableName(long);
  expect('超长名被截断', out.length < long.length, `得到长度 ${out.length}`);
  expectEq('截断保留扩展名', out.endsWith('.pdf'), true);
  expectEq('截断后 stem 恰好在预算内', bytes(out.slice(0, -4)), NAME_BUDGET_BYTES);
}
{
  const long = '中'.repeat(100) + '.png';
  const out = portableName(long);
  expect('中文超长名被截断', bytes(out.replace(/\.png$/, '')) <= NAME_BUDGET_BYTES, `stem ${bytes(out.slice(0, -4))} 字节`);
  expect('按字节而不是按字符截断（3 字节的字装不满 200 个）', out.replace(/\.png$/, '').length <= 66, `得到 ${out.replace(/\.png$/, '').length} 个字`);
}
{
  // 不切断码点：截断点正好落在多字节字符中间时，结果必须仍是合法 UTF-8
  const long = '中'.repeat(70) + '😀'.repeat(20) + '.png';
  const out = portableName(long);
  expect('截断不产生替换字符 U+FFFD', !out.includes('\uFFFD'), out.slice(-12));
  expectEq('截断结果 UTF-8 往返一致（没有半个码点）', Buffer.from(out, 'utf8').toString('utf8'), out);
  expect('截断后仍在预算内', bytes(out.replace(/\.png$/, '')) <= NAME_BUDGET_BYTES);
}
expectEq('预算内不动它', portableName('a'.repeat(NAME_BUDGET_BYTES)), 'a'.repeat(NAME_BUDGET_BYTES));

/* ------------------------------------------------------------------ */
/* 3. 两道工序合体：toDiskName                                        */
/* ------------------------------------------------------------------ */

expectEq('清洗 + 加固都生效', toDiskName('a/b:c', '兜底'), 'a b c');
expectEq('清洗后变成纯点号 → 兜底', toDiskName('...', '兜底'), '兜底');
expectEq('清洗后只剩控制字符 → 兜底', toDiskName('\u0000\u0001', '兜底'), '兜底');
expectEq('上游允许、加固才处理的保留名', toDiskName('CON', '兜底'), 'CON_');
expectEq('普通标题原样通过', toDiskName('会议记录', '兜底'), '会议记录');

/* ------------------------------------------------------------------ */
/* 4. 唯一化：后缀 / 折叠 / 作用域                                     */
/* ------------------------------------------------------------------ */

expectEq('文件：后缀插在最后一个点之前', withSuffix('a.png', 2), 'a (2).png');
expectEq('文件：多点名只动最后一段', withSuffix('data.tar.gz', 2), 'data.tar (2).gz');
expectEq('文件：无扩展名追加到末尾', withSuffix('xxxx', 2), 'xxxx (2)');
expectEq('文件：点开头当无扩展名', withSuffix('.gitignore', 2), '.gitignore (2)');
expectEq('目录：名字里带点也不劈扩展名', withSuffix('v1.0', 2, 'dir'), 'v1.0 (2)');

expectEq('折叠 key：大小写', foldName('README'), foldName('readme'));
expectEq('折叠 key：NFC', foldName('e\u0301'), foldName('\u00e9'));
expect('折叠 key：不同名不折叠', foldName('a') !== foldName('b'));

{
  // 后缀永不嵌套：从**原名**重新生成 (N)，而不是在已带后缀的名字上再加
  const names = createNameAllocator();
  expectEq('标题本来就叫 “报告 (2)” 时顺延而不是嵌套', [
    names.allocate('报告', { kind: 'dir' }),
    names.allocate('报告 (2)', { kind: 'dir' }),
    names.allocate('报告', { kind: 'dir' }),
  ], ['报告', '报告 (2)', '报告 (3)']);
}
{
  // 大小写 / Unicode 折叠必须真的触发消歧 —— 否则在 Windows / macOS 上会静默覆盖
  const names = createNameAllocator();
  expectEq('大小写不同也算重名', [names.allocate('README', { kind: 'dir' }), names.allocate('readme', { kind: 'dir' })], ['README', 'readme (2)']);
  const nfc = createNameAllocator();
  expectEq('NFC/NFD 不同写法也算重名', [nfc.allocate('\u00e9', { kind: 'dir' }), nfc.allocate('e\u0301', { kind: 'dir' })], ['\u00e9', 'e\u0301 (2)']);
}
{
  const names = createNameAllocator();
  expectEq('reserve：第一次拿到空位', names.reserve('T/T.md'), true);
  expectEq('reserve：第二次拿不到（会被不变量抓住）', names.reserve('T/T.md'), false);
  expectEq('reserve：折叠后相同同样拿不到', names.reserve('t/t.MD'), false);
}
{
  // 子目录作用域：images/ 与 attachments/ 互不冲突
  const names = createNameAllocator();
  expectEq('同目录重名加后缀', [names.allocate('1.pdf', { scope: 'attachments' }), names.allocate('1.pdf', { scope: 'attachments' })], ['1.pdf', '1 (2).pdf']);
  expectEq('跨子目录不算重名', names.allocate('1.pdf', { scope: 'images' }), '1.pdf');
}

/* ------------------------------------------------------------------ */
/* 5. 集成：模拟 task.ts 的多篇导出                                    */
/* ------------------------------------------------------------------ */

{
  const archive = createNameAllocator(); // archive 级（task.ts 里那一个）
  const plan = [];
  for (const title of ['会议记录', '会议记录', '会议记录']) {
    const disk = toDiskName(title, '未命名笔记');
    const dirName = archive.allocate(disk, { kind: 'dir' });
    const noteDir = `${dirName}/`;
    const body = `${noteDir}${disk}.md`;
    const bodyOk = archive.reserve(body); // 正文只登记、不改名（消歧只落在文件夹上）
    archive.reserve(`${noteDir}images/annotation-1.svg`); // extractedFiles 提前登记
    const resources = createNameAllocator(); // 每篇目录级是独立实例
    const first = resources.allocate(portableName('a.png'), { scope: 'images' });
    const dup = resources.allocate(portableName('a.png'), { scope: 'images' });
    const annotation = resources.allocate('annotation-1.svg', { scope: 'images' });
    plan.push({ noteDir, body, bodyOk, paths: [`${noteDir}images/${first}`, `${noteDir}images/${dup}`, `${noteDir}images/${annotation}`] });
  }
  expectEq('三篇同名：文件夹加后缀区分', plan.map((p) => p.noteDir), ['会议记录/', '会议记录 (2)/', '会议记录 (3)/']);
  expectEq('三篇同名：正文名恒等于标题', plan.map((p) => p.body), ['会议记录/会议记录.md', '会议记录 (2)/会议记录.md', '会议记录 (3)/会议记录.md']);
  expectEq('正文登记全部拿到空位', plan.map((p) => p.bodyOk), [true, true, true]);
  // P0 回归：目录消歧的后缀必须落在斜杠**之前**，否则图片与正文不再同级、链接全断
  expectEq('图片与正文同级（P0 回归）', plan.map((p) => p.paths[0]), ['会议记录/images/a.png', '会议记录 (2)/images/a.png', '会议记录 (3)/images/a.png']);
  expectEq('同篇内资源重名加后缀', plan[0].paths.slice(1), ['会议记录/images/a (2).png', '会议记录/images/annotation-1.svg']);
  expectEq('12 条 zip 路径互不重复', new Set(plan.flatMap((p) => [p.body, ...p.paths])).size, 12);
}
{
  // 标题是超长中文 + 保留名 + 尾部点号的组合拳，最终仍必须落在 255 字节内
  const title = '中'.repeat(120) + '.' + 'con';
  const baseName = toDiskName(title, '未命名笔记');
  const dir = withSuffix(baseName, 2, 'dir');
  expect('超长 + 加固后目录名仍在 255 字节内', bytes(dir) <= 255, `${bytes(dir)} 字节`);
  expect('派生名（.meta.json）也在 255 字节内', bytes(`${baseName}.meta.json`) <= 255, `${bytes(`${baseName}.meta.json`)} 字节`);
  expect('加后缀后仍在 255 字节内', bytes(`${dir}/`) <= 255, `${bytes(dir)} 字节`);
}

process.stdout.write(`\n命名检查：${checks - failures}/${checks} 通过\n`);
process.exit(failures === 0 ? 0 : 1);
