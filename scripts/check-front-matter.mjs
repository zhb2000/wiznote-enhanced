#!/usr/bin/env node
/**
 * front matter（YAML 元数据）的回归检查，不依赖任何测试框架。
 *
 * 为什么要单独有这么一个脚本：元数据里的字符串全部来自用户数据（标题、标签名…），
 * 而“哪些字符串必须加引号”是个坑很深的判断题 —— 手写那套就在两处翻过车：
 * `- ` 开头的值会产出**语法错误**的 YAML，控制字符（`\x00` / `\x0b` …）会产出
 * **解析器拒收**的 YAML。现在序列化交给 js-yaml，这个脚本用一批极端值把它钉住，
 * 免得以后又有人想“顺手手写几行拼一下”。
 *
 * 跑法：npm run check:frontmatter
 *
 * ⚠️ 判定器用的是 js-yaml 自己（仓库依赖，零额外安装），属于“自产自检”。
 * 所以另外加了几条**不依赖解析器**的结构断言（裸控制字符、锚点/别名、折行）。
 * 当初那批判定用的是 pyyaml 6.0.3（YAML 1.1，比多数消费者更严格）：手写版 8 项失败，
 * js-yaml 0 项失败 —— 本脚本的用例集就是从那批里搬过来的。
 */
import { load } from 'js-yaml';
import { collectMetadata, renderFrontMatter } from '../src/export/metadata.ts';
import { buildTagPaths, ROOT_TAG_GUID } from '../src/export/tag-path.ts';

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

/** 只渲染一个标签名（其它字段固定），方便逐条定位 */
function renderTagCase(name) {
  const note = { title: 't', created: Date.parse('2024-01-02T03:04:05+08:00'), tags: 'g0' };
  return renderFrontMatter(collectMetadata(note, new Map([['g0', name]]), false));
}

/**
 * 极端值。分三类：
 * 1. 会被 YAML 当语法 / 类型解释的（`- dash`、`---`、`yes`、`2024-01-01`…）；
 * 2. 需要转义的（引号、反斜杠、换行、tab…）；
 * 3. 只该走 escape 的控制字符（NUL、BEL、VT、FF、NEL、LS、PS…）。
 */
const EXTREME_TAGS = [
  '普通标签', 'has space', 'a: b', 'a:b', '#hash', 'a #c', '- dash', '-foo', '-', '---', '...',
  '2024', '1.5', '2024-01-01', 'true', 'False', 'null', 'yes', 'on', '~', ' lead', 'trail ',
  'quote"inside', 'back\\slash', 'comma,inside', 'bracket[inside]', 'brace{inside}', 'amp&ersand',
  'star*inside', 'percent%', 'at@sign', 'tick`x`', 'question?', "single'quote", 'dollar$', 'equal=',
  'caret^', 'pipe|x', 'gt>', 'bang!', 'nl\nhere', 'crlf\r\nhere', 'cr\rhere', 'tab\there',
  'vt\u000bhere', 'ff\u000chere', 'nul\u0000here', 'bel\u0007here', 'nel\u0085here', 'ls\u2028here',
  'ps\u2029here', 'emoji 🎉 中文', 'bom\uFEFFhere',
];

/** 去掉首尾 `---` 分隔符，只留 YAML 本体 */
function bodyOf(frontMatter) {
  return frontMatter.slice('---\n'.length, -'---\n\n'.length);
}

process.stdout.write('== 逐个标签名：渲染 → 用 js-yaml 读回，必须与原值完全一致 ==\n');

for (const name of EXTREME_TAGS) {
  const frontMatter = renderTagCase(name);
  const label = JSON.stringify(name);
  let parsed;
  try {
    parsed = load(bodyOf(frontMatter));
  } catch (error) {
    fail(`标签 ${label} 的 YAML 解析失败`, String(error).split('\n')[0]);
    continue;
  }
  const tags = parsed?.tags;
  if (!Array.isArray(tags) || tags.length !== 1 || tags[0] !== name) {
    fail(`标签 ${label} 读回变了样`, `读回 ${JSON.stringify(tags)}`);
    continue;
  }
  ok(`标签 ${label}`);
}

process.stdout.write('\n== 不依赖解析器的结构断言 ==\n');

for (const name of EXTREME_TAGS) {
  const body = bodyOf(renderTagCase(name));
  // 裸 C0 控制字符（tab 与换行除外）一律不允许出现在产物里 —— 这是 pyyaml 直接拒收的那批
  const raw = body.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  if (raw) {
    fail(`标签 ${JSON.stringify(name)} 产物里含裸控制字符`, `U+${raw[0].codePointAt(0).toString(16)}`);
    continue;
  }
  if (/[&*](ref|id|anchor)/i.test(body)) {
    fail(`标签 ${JSON.stringify(name)} 产物里有锚点 / 别名`, body.replace(/\n/g, ' | '));
    continue;
  }
}

process.stdout.write('\n== 一份真实形态的元数据 ==\n');

const note = {
  title: '基础教程',
  created: Date.parse('2024-01-02T03:04:05+08:00'),
  dataModified: Date.parse('2024-01-02T03:04:05+08:00'),
  accessed: Date.parse('2024-01-02T03:04:05+08:00'),
  category: '/计算机/网络',
  tags: 'g1*g2*g3',
  url: 'https://example.com/x?y=1',
  docGuid: 'abc-123',
  type: 'document',
  version: 13875,
};
const tagNames = new Map([
  ['g1', '计算机网络'],
  ['g2', 'TCP/IP'],
  ['g3', '- 手写'],
]);
const frontMatter = renderFrontMatter(collectMetadata(note, tagNames, true));
process.stdout.write(frontMatter);

expect('以 `---\\n` 开头', frontMatter.startsWith('---\n'));
expect('以 `---\\n\\n` 结尾', frontMatter.endsWith('---\n\n'));

const parsed = load(bodyOf(frontMatter));
expect(
  '字段顺序保持 title → created → modified → accessed → category → tags → url',
  JSON.stringify(Object.keys(parsed).slice(0, 7)) ===
    JSON.stringify(['title', 'created', 'modified', 'accessed', 'category', 'tags', 'url']),
  JSON.stringify(Object.keys(parsed)),
);
expect('标签读回不变', JSON.stringify(parsed.tags) === JSON.stringify(['计算机网络', 'TCP/IP', '- 手写']));
expect('时间是字符串（不被解析成日期对象）', typeof parsed.created === 'string', typeof parsed.created);
expect('wiznote.version 是数字', parsed.wiznote?.version === 13875 && typeof parsed.wiznote.version === 'number');
expect('wiznote 块在最后', Object.keys(parsed).at(-1) === 'wiznote');

process.stdout.write('\n== 几个容易回归的边角 ==\n');

const longTitle = '长'.repeat(300);
const longFrontMatter = renderFrontMatter(
  collectMetadata({ title: longTitle, created: Date.now() }, new Map(), false),
);
expect(
  '超长标题不折行（lineWidth: -1）',
  bodyOf(longFrontMatter).split('\n').filter((line) => line.includes('长')).length === 1,
);

const dupFrontMatter = renderFrontMatter(
  collectMetadata(
    { title: 't', created: Date.now(), tags: 'g1*g2' },
    new Map([['g1', '同名'], ['g2', '同名']]),
    false,
  ),
);
expect('同名标签不产生锚点 / 别名', !/&\w|\*\w/.test(dupFrontMatter), dupFrontMatter.replace(/\n/g, ' | '));
expect('同名标签都保留', JSON.stringify(load(bodyOf(dupFrontMatter)).tags) === JSON.stringify(['同名', '同名']));

expect('没有元数据时返回空串（不产出空壳 front matter）', renderFrontMatter({ fields: [], raw: [] }) === '');

process.stdout.write('\n== 标签层级 → 路径（buildTagPaths，脏数据在这里覆盖）==\n');

/** 断言 guid → 路径 的映射与期望一致 */
function expectPaths(label, rows, expected) {
  let paths;
  try {
    paths = buildTagPaths(rows);
  } catch (error) {
    fail(`${label} 抛异常了`, String(error).slice(0, 80));
    return;
  }
  const got = [...paths.entries()].sort().map(([guid, path]) => `${guid}=${path}`);
  const want = Object.entries(expected).sort().map(([guid, path]) => `${guid}=${path}`);
  expect(label, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}`);
}

expectPaths(
  '顶层标签（父是 rootTagGuid 哨兵）',
  [{ tagGuid: 'a', name: '[科技]', parentGuid: ROOT_TAG_GUID }],
  { a: '[科技]' },
);

expectPaths(
  '两层：父/子',
  [
    { tagGuid: 'a', name: '[收藏：来源]', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'b', name: '果壳网', parentGuid: 'a' },
  ],
  { a: '[收藏：来源]', b: '[收藏：来源]/果壳网' },
);

expectPaths(
  '三层：父/子/孙（真实数据形态）',
  [
    { tagGuid: 'a', name: '[收藏：分类]', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'b', name: '[科技]', parentGuid: 'a' },
    { tagGuid: 'c', name: 'Office', parentGuid: 'b' },
  ],
  { a: '[收藏：分类]', b: '[收藏：分类]/[科技]', c: '[收藏：分类]/[科技]/Office' },
);

expectPaths(
  '父不在本地：停，不臆造父名',
  [{ tagGuid: 'a', name: '孤儿', parentGuid: '9f9f9f9f-0000' }],
  { a: '孤儿' },
);

expectPaths(
  '自环不会死循环',
  [{ tagGuid: 'a', name: 'A', parentGuid: 'a' }],
  { a: 'A' },
);

expectPaths(
  '互指（a↔b）不会死循环',
  [
    { tagGuid: 'a', name: 'A', parentGuid: 'b' },
    { tagGuid: 'b', name: 'B', parentGuid: 'a' },
  ],
  { a: 'B/A', b: 'A/B' },
);

expectPaths(
  '跨父同名：路径把两者区分开',
  [
    { tagGuid: 'a', name: '父', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'b', name: '同名', parentGuid: 'a' },
    { tagGuid: 'c', name: '同名', parentGuid: ROOT_TAG_GUID },
  ],
  { a: '父', b: '父/同名', c: '同名' },
);

expectPaths(
  '坏行（无 guid / 无名字）被忽略，其余照常',
  [
    { tagGuid: '', name: '空guid', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'x', name: '', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'y', name: '好标签', parentGuid: ROOT_TAG_GUID },
    { tagGuid: 'z', name: '没父字段' },
  ],
  { y: '好标签', z: '没父字段' },
);

{
  // 深度炸弹：长链（20 层）必须被上限截断，不能无限走下去
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ tagGuid: `t${i}`, name: `L${i}`, parentGuid: i === 0 ? undefined : `t${i - 1}` });
  const paths = buildTagPaths(rows);
  const deep = paths.get('t19') ?? '';
  expect(
    '超长链被深度上限截断（不会无限展开）',
    deep.split('/').length <= 16 && deep.startsWith('L'),
    `${deep.split('/').length} 段: ${deep.slice(0, 40)}`,
  );
}

{
  // 标签原文为空时，front matter 里不该出现空的 tags 键
  const frontMatter = renderFrontMatter(
    collectMetadata({ title: 't', created: Date.now(), tags: '' }, new Map(), false),
  );
  expect('对象上没有标签时不写 tags 键', !/^tags:/m.test(frontMatter), frontMatter.replace(/\n/g, ' | '));
}

{
  // 传入覆盖值（本地 docs 行的标签）时应当被采用 —— 这是列表右键那条路的兜底
  const frontMatter = renderFrontMatter(
    collectMetadata(
      { title: 't', created: Date.now(), tags: '' },
      new Map([['g1', '[收藏：来源]/果壳网']]),
      false,
      'g1',
    ),
  );
  expect(
    '对象没有标签时采用覆盖值，并且输出完整路径',
    /\n\s*- "?\[收藏：来源\]\/果壳网"?/.test(frontMatter),
    frontMatter.replace(/\n/g, ' | '),
  );
}

process.stdout.write(`\nfront matter 检查：${checks - failures}/${checks} 通过\n`);
process.exit(failures === 0 ? 0 : 1);
