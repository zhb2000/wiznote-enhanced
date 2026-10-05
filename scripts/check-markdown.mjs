#!/usr/bin/env node
/**
 * markdown 内联图片 / 链接解析的回归检查，不依赖任何测试框架。
 *
 * 为什么要单独有这么一个脚本：这一层啃的全是**宿主产物里的脏字符串**，而“什么样的目标
 * 算一个资源名”是个很容易漏的判断题。已经实测翻过两次车：
 *
 * 1. **目标里带成对括号**（`index_files/<hex>(2).png`，网页剪藏里“重名加 `(2)`”很常见）。
 *    老写法用 `[^)]*` 取目标，会在第一个 `)` 上截断：拿一个不存在的名字去请求（服务端回
 *    807 B 占位图，还会把它按错名字固化进本地缓存 —— 好图就这么丢了），产物里还会留下
 *    `…(2).png)` 这样的残渣。CommonMark 本来就允许裸目标里出现配对括号。
 * 2. **没加引号的 title**（`images/x.png 截图`，见 `splitImageTitle` 的注释）。
 * 3. **资源名在请求路径里的转义**：本地缓存是按**原始字符**认名字的，多转义一个就等于换了
 *    个名字（miss → 服务端回 807 B 占位图）。`@`（2026-10-04）与 `[` `]`（2026-10-08，整篇
 *    17 张图全部“没取到”而应用里显示得好好的）都栽过，所以口径钉成“URL 标准里路径的
 *    percent-encode set”，见 `encodePathSegment`。
 *
 * 跑法：npm run check:markdown
 *
 * ⚠️ `markdown-inline.ts` 刻意零依赖，就是为了能被这里直接 import（Node 直跑 TS 时解析不了
 * 无扩展名的相对导入）。**别给它加 import**，否则这个脚本会挂。
 */
import {
  encodePathSegment,
  linkTargetParts,
  replaceInlineLinks,
  rewriteImageTargets,
  splitImageTargets,
  splitImageTitle,
  unescapeMarkdown,
} from '../src/export/markdown-inline.ts';

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

/** 同样的“资源名 → 文件名”分配器**故意与输入无关**：这样输出里能一眼看出改了哪些目标 */
function makeNamer() {
  const names = [];
  return {
    names,
    path(name, dir) {
      names.push(name);
      return `${dir}/img-${names.length}.png`;
    },
  };
}

/** 跑一遍图片改写，同时把“这次落盘的资源名”收出来 */
function run(markdown, { rewrite = true } = {}) {
  const namer = makeNamer();
  const result = rewriteImageTargets(markdown, { rewrite, namer });
  return { ...result, names: namer.names };
}

function expectRewrite(label, markdown, expected, expectedNames, options) {
  const { markdown: out, imageRefs, names } = run(markdown, options);
  const same = out === expected;
  const namesOk = JSON.stringify(names) === JSON.stringify(expectedNames);
  expect(
    label,
    same && namesOk,
    same ? `资源名：${JSON.stringify(names)}（期望 ${JSON.stringify(expectedNames)}）` : `产物：${JSON.stringify(out)}（期望 ${JSON.stringify(expected)})`,
  );
}

/* ------------------------------------------------------------------ */
/* 1. 目标里的成对括号 —— 这次修的 bug                                  */
/* ------------------------------------------------------------------ */

{
  // 老写法会把名字截成 `index_files/aaaa(2`，再拿它去请求；顺带在产物尾部留一截 `.png)`
  expectRewrite(
    '目标带括号：资源名完整取得',
    '![image](index_files/aaaa(2).png)',
    '![image](images/img-1.png)',
    ['index_files/aaaa(2).png'],
  );

  expectRewrite(
    '目标带括号 + 引号 title',
    '![x](index_files/a(2).png "截图")',
    '![x](images/img-1.png "截图")',
    ['index_files/a(2).png'],
  );

  expectRewrite(
    '目标带括号（嵌套一层）',
    '![x](index_files/a(b(c)d).png)',
    '![x](images/img-1.png)',
    ['index_files/a(b(c)d).png'],
  );

  expectRewrite(
    '正文里的普通括号不受影响，同段图片照常改写',
    '前面 (这是一句括号) 后面 ![x](index_files/a.png)',
    '前面 (这是一句括号) 后面 ![x](images/img-1.png)',
    ['index_files/a.png'],
  );
}

/* ------------------------------------------------------------------ */
/* 2. title / 尺寸 / 尖括号 / 多图                                      */
/* ------------------------------------------------------------------ */

expectRewrite('普通目标', '![x](index_files/a.png)', '![x](images/img-1.png)', ['index_files/a.png']);
expectRewrite(
  '尺寸后缀原样补回',
  '![x](index_files/a.png =300x200)',
  '![x](images/img-1.png =300x200)',
  ['index_files/a.png'],
);
expectRewrite(
  '带引号的 title',
  '![x](index_files/a.png "截图")',
  '![x](images/img-1.png "截图")',
  ['index_files/a.png'],
);
expectRewrite(
  '没引号的 title 要补上引号',
  '![x](images/a.png 截图)',
  '![x](images/img-1.png "截图")',
  ['images/a.png'],
);
expectRewrite(
  '括号形式的 title（CommonMark）',
  '![x](index_files/a.png (标题))',
  '![x](images/img-1.png (标题))',
  ['index_files/a.png'],
);
expectRewrite(
  '尖括号目标（名字里带空格）',
  '![x](<index_files/a b.png>)',
  '![x](images/img-1.png)',
  ['index_files/a b.png'],
);
expectRewrite(
  '| 分隔的多图逐段处理',
  '![x](a.png|b.png)',
  '![x](images/img-1.png|images/img-2.png)',
  ['a.png', 'b.png'],
);
expectRewrite(
  '同一段里两处图片各算各的',
  '![x](index_files/a.png)\n\n![y](index_files/b.png)',
  '![x](images/img-1.png)\n\n![y](images/img-2.png)',
  ['index_files/a.png', 'index_files/b.png'],
);

/* ------------------------------------------------------------------ */
/* 3. 该保持原样的                                                     */
/* ------------------------------------------------------------------ */

expectRewrite('外链不动，也不计数', '![x](https://e.com/a.png)', '![x](https://e.com/a.png)', []);
expectRewrite('非图片链接不归它管', '[x](index_files/a.png)', '[x](index_files/a.png)', []);
expectRewrite('转义过的 `![` 是字面文本', '\\![x](index_files/a.png)', '\\![x](index_files/a.png)', []);
expectRewrite('括号不配对时不动', '![x](index_files/a.png', '![x](index_files/a.png', []);
expectRewrite(
  '目标跨空行（段落边界）时不动，别把正文吃掉',
  '[a](b\n\nc)',
  '[a](b\n\nc)',
  [],
);

{
  // `rewrite: false`（用户关了“把图片下载到 images/”）：只计数，链接一个都不许动
  const { markdown, imageRefs, names } = run('![x](index_files/a.png)', { rewrite: false });
  expect(
    'rewrite=false：只计数、不动链接',
    markdown === '![x](index_files/a.png)' && imageRefs === 1 && names.length === 0,
    `产物：${JSON.stringify(markdown)} / imageRefs=${imageRefs} / 名字 ${names.length} 个`,
  );
}

/* ------------------------------------------------------------------ */
/* 4. 纯函数本身                                                       */
/* ------------------------------------------------------------------ */

{
  expect(
    '带空格的文件名不该被当 title 拆坏',
    JSON.stringify(splitImageTitle('path sound')) === JSON.stringify({ url: 'path sound', title: '' }),
    JSON.stringify(splitImageTitle('path sound')),
  );
  expect(
    'splitImageTargets 摘掉尺寸后缀',
    JSON.stringify(splitImageTargets(' a.png|b.png =100x100 ')) ===
      JSON.stringify({ targets: ['a.png', 'b.png'], size: ' =100x100' }),
    JSON.stringify(splitImageTargets(' a.png|b.png =100x100 ')),
  );
  expect(
    'linkTargetParts 拆目标与其余部分',
    JSON.stringify(linkTargetParts(' qj-x.pdf "标题" ')) ===
      JSON.stringify({ target: 'qj-x.pdf', rest: ' "标题"' }),
    JSON.stringify(linkTargetParts(' qj-x.pdf "标题" ')),
  );
  expect(
    'linkTargetParts：没有 title 时其余部分为空',
    JSON.stringify(linkTargetParts('a.pdf')) === JSON.stringify({ target: 'a.pdf', rest: '' }),
    JSON.stringify(linkTargetParts('a.pdf')),
  );
  expect(
    'replaceInlineLinks 只回调真正的内联形态',
    (() => {
      const seen = [];
      replaceInlineLinks('一句 (括号) 与 [不是链接] 文字，还有 ![图](a.png)', (link) => {
        seen.push(`${link.image ? 'image' : 'link'}:${link.label}:${link.raw}`);
        return undefined;
      });
      return seen.length === 1 && seen[0] === 'image:图:a.png';
    })(),
    '只应命中 `![图](a.png)` 这一处',
  );
}

/* ------------------------------------------------------------------ */
/* 5. 资源名 → 请求路径段：只转义“必须转义”的                            */
/* ------------------------------------------------------------------ */

{
  const keep = (s) => {
    const out = encodePathSegment(s);
    expect(`路径段：原样保留 ${JSON.stringify(s.replace(/[A-Za-z0-9]/g, 'x'))}`, out === s, out);
  };
  // 剪藏里的名字（2026-10-08 实测：编成 %5B / %5D 会让整篇 17 张图全部取不到）
  keep('open[1].gif');
  keep('a[1]_b_[2].jpg');
  // 同一类坑的更早一例（2026-10-04）
  keep('share-icons@2x.png');
  // URL 标准里路径不转义的其余字符
  keep("a!b$c&d'e(f)g*h+i,j;k=l:m^n|o.png");

  const enc = (s) => encodePathSegment(s);
  expect('路径段：空格 → %20', enc('a b.png') === 'a%20b.png', enc('a b.png'));
  expect('路径段：`#` 要转义（否则成了 fragment）', enc('a#b.png') === 'a%23b.png', enc('a#b.png'));
  expect('路径段：`?` 要转义（否则成了 query）', enc('a?b.png') === 'a%3Fb.png', enc('a?b.png'));
  expect('路径段：`%` 原样（引用可能已经是 %XX 形式，别再转一次）', enc('a%20b.png') === 'a%20b.png', enc('a%20b.png'));
  keep('100%.png');
  expect('路径段：`/` 要转义（进这里是单个路径段）', enc('a/b.png') === 'a%2Fb.png', enc('a/b.png'));
  expect(
    '路径段：非 ASCII 走 UTF-8（与浏览器一致）',
    enc('中文名.png') === encodeURIComponent('中文名.png'),
    enc('中文名.png'),
  );
}

/* ------------------------------------------------------------------ */
/* 6. 富文本正文的反转义：只还原宿主真会转义的那几个字符                 */
/* ------------------------------------------------------------------ */

{
  // 2026-10-09 实测：LiveEditor.escapeMarkdownText() 只转义 6 个（\ $ [ ] _ *）。
  // 公式里的 `\\`（LaTeX 换行）是 doc2markdown 的**原样输出**，绝不能被还原成单个 `\`。
  expect(
    '公式换行 `\\\\` 保留（不是单个 `\\`）',
    unescapeMarkdown('$$ a \\\\ b $$') === '$$ a \\\\ b $$',
    JSON.stringify(unescapeMarkdown('$$ a \\\\ b $$')),
  );
  expect(
    'LaTeX 命令 `\\lambda` 不受影响',
    unescapeMarkdown('$\\lambda_t$') === '$\\lambda_t$',
    JSON.stringify(unescapeMarkdown('$\\lambda_t$')),
  );
  // 早期实现照抄 CommonMark 的标点全集，把这些也一起还原了 —— 公式直接坏掉
  expect(
    '公式里的 `\\|` `\\{` `\\}` `\\(` `\\)` 保持原样',
    unescapeMarkdown('\\|x\\| \\{a\\} \\(b\\)') === '\\|x\\| \\{a\\} \\(b\\)',
    JSON.stringify(unescapeMarkdown('\\|x\\| \\{a\\} \\(b\\)')),
  );
  expect(
    '正文里的 `\\$` 不还原（免得把两个 `$` 配成一段公式）',
    unescapeMarkdown('成本 \\$100') === '成本 \\$100',
    JSON.stringify(unescapeMarkdown('成本 \\$100')),
  );

  // 宿主真正会转义的 4 个标点照旧还原：图片 / 目录 / 粗体得靠它才生效
  expect(
    '图片 `!\\[\\](index\\_files/x.png)` 还原',
    unescapeMarkdown('!\\[\\](index\\_files/x.png)') === '![](index_files/x.png)',
    JSON.stringify(unescapeMarkdown('!\\[\\](index\\_files/x.png)')),
  );
  expect(
    '`\\[TOC\\]` 与 `\\*\\*粗体\\*\\*` 还原',
    unescapeMarkdown('\\[TOC\\] \\*\\*粗体\\*\\*') === '[TOC] **粗体**',
    JSON.stringify(unescapeMarkdown('\\[TOC\\] \\*\\*粗体\\*\\*')),
  );
}

process.stdout.write(`\nmarkdown 检查：${checks - failures}/${checks} 通过\n`);
process.exit(failures === 0 ? 0 : 1);
