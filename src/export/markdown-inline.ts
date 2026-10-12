/**
 * 宿主产物里那些**脏字符串**的解析与转义（纯字符串处理，**刻意零依赖**，同 `naming.ts`）：
 * markdown 的内联图片 / 链接目标，以及“资源名 → 请求路径段”的编码。
 *
 * 为什么要单独一个文件：这一层必须能被 `npm run check:markdown` 直接喂脏字符串，而它恰好是
 * 实测踩过坑的地方 ——
 *
 * 1. **目标里可以有成对括号**。实测有 `index_files/<64 位 hex>(2).png` 这种资源名（网页剪藏里
 *    “重名加 `(2)`”很常见）。拿 `[^)]*` 去取目标会在**第一个** `)` 上截断，后果有两个：
 *    ① 用一个不存在的名字去请求 —— 服务端回 807 B 占位图（还会把它按那个错名字固化进本地
 *    缓存），于是**一张好图被白白丢掉**；② 产物被写坏：`![image](images/<hex>(2).png)` ——
 *    链接目标其实是 `images/<hex>(2`，后面还挂着一截 `.png)` 残渣。CommonMark 本来就允许裸
 *    目标里出现配对括号，所以这里照它的规则做括号配对扫描，而不是一条正则了事。
 * 2. **title 有五种写法**（`<url>`、`url "t"`、`url 't'`、`url (t)`，以及实测多出来的**没引号**
 *    那种），所以拆 title 只能靠启发式，见 `splitImageTitle`。
 * 3. **资源名里的字符不能在请求路径里乱转义** —— 本地缓存与本地数据服务是按**原始字符**认
 *    名字的，多转义一个就 miss（见 `encodePathSegment`）。
 * 4. **富文本正文的转义要按宿主的实际行为还原**，不能照抄 CommonMark 的标点全集 —— 多还原
 *    一个就是把公式里的 LaTeX 转义（`\\` / `\|` / `\{` …）改坏，见 `unescapeMarkdown`。
 */

/** 只有“真正的外部链接”才保持原样不下拉（协议相对与根相对地址是笔记自己的资源，仍要下载） */
export const EXTERNAL_URL = /^(https?:|data:|blob:|file:)/i;

/**
 * 还原宿主 `doc2markdown` 为**编辑器显示**而给正文文字加的转义（`html2Doc → doc2markdown` 这条路专用）。
 *
 * 富文本正文里，`![](index_files/x.png)`、`[TOC]`、`**粗体**` 都是**字面文本**，
 * `doc2markdown` 会把它们转义成 `!\[\](index\_files/x.png)`，好让编辑器按字面显示。
 * 但导出的 `.md` 是要拿去渲染的：保持转义会让图片、目录、粗体**全部失效**
 * （`!\[\](…)` 在 markdown 里就是一行普通文字，不是图片），所以要还原一次。
 *
 * **只还原宿主真正会转义的那几个字符**：实测（2026-10-09）`LiveEditor.escapeMarkdownText()`
 * —— 宿主自己给正文转义用的那个函数 —— 只转义 6 个：`` \ $ [ ] _ * ``。
 * 早先的实现照抄了 CommonMark 的“可转义标点”全集（`{}()#+-.!>~|` 等也在内），
 * 那些字符宿主根本不会转义，还原只会**误伤公式** —— LaTeX 里 `\|`（范数）、
 * `\{` `\}`（字面花括号）、`\(` `\)`（行内公式定界）都是**原文**，被还原后公式就坏了。
 *
 * 剩下这 4 个里，有两个**刻意不还原**（各是一处取舍）：
 *
 * - **反斜杠**：公式里的 `\\` 是 LaTeX 换行符（`doc2markdown` 对公式内容是**原样输出**，
 *   不转义），而正文里字面的 `\` 会被转义成 `\\`。两者在字符串上长得一模一样、无法区分；
 *   公式里的 `\\` 远比正文里的字面反斜杠常见，所以保留 `\\` 不动 —— 正文里的字面反斜杠
 *   留在产物里是 `\\`，markdown 渲染出来仍是单个 `\`，**观感一致**（见 export-pipeline.md §六）；
 * - **`$`**：正文里字面的 `$` 会被转义成 `\$`。不还原同样是刻意的 —— `\$` 渲染出来就是 `$`，
 *   还原反而可能让“成本 $100，而公式是 $x$”里的两个 `$` 被渲染器配成一段公式。
 *
 * ⚠️ 只用在 `html2Doc → doc2markdown` 这条路上：那条路是“富文本还原成 markdown”，
 * 转义是渲染产物、不是用户意图。**Lite Markdown 笔记的正文是用户手写的 markdown**，
 * 里面的 `\_` 可能就是故意写的，绝不能走这里；大纲笔记同理（它的 `\*` 是故意加的）。
 */
export function unescapeMarkdown(markdown: string): string {
  return markdown.replace(/\\([\[\]_*])/g, '$1');
}

/**
 * 把资源名编成**请求 URL 里的路径段**：口径 = URL 标准里“路径的 percent-encode set”，
 * 也就是**浏览器解析相对地址时会做的那一套**。
 *
 * 为什么必须与浏览器一致：我们请求的资源名（`index_files/xxx.png`）本质就是笔记 HTML 里写的
 * 相对地址，而本地缓存 / 本地数据服务都是按**原始字符**查名字的。多转义一个字符就等于换了个
 * 名字 —— 缓存 miss，服务端只回 807 B 占位图（还会把它按那个错名字固化进缓存）。实测踩过两次：
 *
 * | 名字 | 原样请求 | 被 `encodeURIComponent` 过一遍 |
 * | --- | --- | --- |
 * | `share-icons@2x.png` | 200，真 PNG（12 KB 级） | `…%402x.png` → 807 B 占位图（2026-10-04） |
 * | `open[1].gif` | 200，真图 | `…open%5B1%5D.gif` → **整篇 17 张图全部“没取到”**，而应用里显示得好好的（2026-10-08） |
 *
 * 所以这里用**白名单**（保留什么）而不是给 `encodeURIComponent` 打补丁 —— 后者转的比需要的多
 * 得多，每漏一个字符就是一次“图片没取到”。保留集 = 字母数字 + `- . _ ~ ! $ & ' ( ) * + , ; = : @`
 * （unreserved + sub-delims + `:` `@`）+ `[ ] ^ |`（URL 标准在路径里也不转义它们）+ `%`
 * （HTML 里的引用可能**已经是** `%XX` 形式，浏览器解析相对地址时不会再转一次）。
 * 其余（空格、引号、`#`、`<` `>`、`?`、反引号、花括号、`/`、非 ASCII 与控制符）一律转义 ——
 * `/` 要转是因为进到这里的是**单个路径段**（`index_files/` 前缀在外面）。
 */
export function encodePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@[\]^|%]/g, (char) => encodeURIComponent(char));
}

/** 判断是不是图片资源；CSS `url()` 那类只需要处理这些，别去碰字体 / 脚本 */
export const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|avif|svg|ico)$/i;

/** 一处内联图片 / 链接的原文切片 */
export interface InlineLink {
  /** 是不是图片语法（`![`） */
  image: boolean;
  /** `[...]` 里的文本 */
  label: string;
  /** `(` 与收尾 `)` 之间的原文（未 trim） */
  raw: string;
}

/**
 * 找出 markdown 里的内联图片 / 链接，逐个交给 `map`；`map` 返回 `undefined` 表示这一处不动。
 *
 * 认的形态就是宿主产物里会出现的那两种：`![label](目标…)` 与 `[label](目标…)`。引用式链接
 * （`[x][y]`）不处理。目标按 CommonMark 的规则扫到**配对**的 `)`（见 `findInlineDestEnd`）。
 */
export function replaceInlineLinks(
  markdown: string,
  map: (link: InlineLink) => string | undefined,
): string {
  let out = '';
  /** 已经原样拷进 `out` 的下标；一处都没改时整体原样返回 */
  let copied = 0;
  let search = 0;

  while (search < markdown.length) {
    const bracket = markdown.indexOf('[', search);
    if (bracket < 0) break;
    search = bracket + 1;

    // `![` 才算图片；被转义的 `\![` 是字面文本，不算
    const prev = markdown[bracket - 1];
    const image = prev === '!' && markdown[bracket - 2] !== '\\';
    if (!image && (prev === '\\' || prev === '!')) continue;

    const labelEnd = markdown.indexOf(']', bracket + 1);
    if (labelEnd < 0) break;
    if (markdown[labelEnd + 1] !== '(') continue;

    const close = findInlineDestEnd(markdown, labelEnd + 2);
    if (close < 0) continue;
    search = close + 1;

    const replacement = map({
      image,
      label: markdown.slice(bracket + 1, labelEnd),
      raw: markdown.slice(labelEnd + 2, close),
    });
    if (replacement === undefined) continue;

    // 图片语法的那一个 `!` 也属于这一处，要跟着一起换掉（留着就会输出 `!![…](…)`）
    const start = image ? bracket - 1 : bracket;
    out += markdown.slice(copied, start) + replacement;
    copied = close + 1;
  }

  return copied === 0 ? markdown : out + markdown.slice(copied);
}

/**
 * 从 `(` 之后开始，找内联目标的收尾 `)`；找不到给 -1。
 *
 * 规则对齐 CommonMark：尖括号目标直接读到 `>`；裸目标里的 `(` / `)` **成对配对**（配对内的
 * `)` 不算收尾，只有配对外的 `)` 才是）。顺带把空行当段落边界 —— 不收的话，两段普通文字之间
 * 的一对括号会被当成链接目标，把中间的正文整段吃掉。
 */
function findInlineDestEnd(markdown: string, from: number): number {
  let i = from;
  while (i < markdown.length && /\s/.test(markdown[i])) i += 1;

  if (markdown[i] === '<') {
    const gt = markdown.indexOf('>', i + 1);
    if (gt < 0) return -1;
    i = gt + 1;
    // 尖括号目标之后还可能跟着 title，继续走到收尾 `)`
    while (i < markdown.length && markdown[i] !== ')' && !(markdown[i] === '\n' && markdown[i + 1] === '\n')) {
      i += 1;
    }
    return i < markdown.length && markdown[i] === ')' ? i : -1;
  }

  let depth = 0;
  while (i < markdown.length) {
    const ch = markdown[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === '\n' && markdown[i + 1] === '\n') return -1;
    i += 1;
  }
  return -1;
}

/**
 * 把 `=300x200` 这类**尺寸后缀**摘出来（为知自己的约定），剩下的按 `|` 拆成多个目标
 * （图集）。尺寸在写回时原样补上，所以这里连前导空格一起留着。
 */
export function splitImageTargets(raw: string): { targets: string[]; size: string } {
  const trimmed = raw.trim();
  const sizeMatch = trimmed.match(/^(.*?)(\s+=[^=]*)$/);
  const target = (sizeMatch ? sizeMatch[1] : trimmed).trim();
  const size = sizeMatch ? sizeMatch[2] : '';
  return { targets: target.split('|').map((part) => part.trim()).filter(Boolean), size };
}

/**
 * 把一个图片目标拆成“资源名 + title”。
 *
 * CommonMark 的 title 写法有 `<url>`、`url "title"`、`url 'title'`、`url (title)`，实测
 * （2026-10-07）宿主产物里还有第五种：**没加引号的 title** —— 旧版 Markdown 笔记里原文是
 * `![截图](index_files/x.png&nbsp;"截图")`，经 `html2Doc → doc2markdown` 之后成了
 * `![截图](images/x.png 截图)`：既没引号、又和文件名之间只隔一个空格。旧实现把整串当成资源名
 * 去请求（`x.png 截图`），服务端查不到就回 807 B 占位图，于是报“1 张图片没取到”，而那张图
 * 本身是好好的。这种写法按 CommonMark 根本不是合法图片引用、原样写进产物也不会被渲染成图片，
 * 所以拆出来之后**要给它补上引号**，链接和下载一起修好。
 */
export function splitImageTitle(part: string): { url: string; title: string } {
  // `<url>`：CommonMark 用尖括号让目标里可以带空格
  const angle = part.match(/^<([^>]*)>$/);
  const rest = (angle ? angle[1] : part).trim();
  if (!rest) return { url: '', title: '' };

  const quoted = rest.match(/^([\s\S]*?)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/);
  if (quoted) return { url: quoted[1].trim(), title: quoted[2] };

  // 括号形式的 title（`url (title)`）：`(` 前面有空白才算 title，所以 `a(2).png` 那种
  // **名字里自带括号**的不会被误判；括号里的内容按配对取，嵌套一层也认。
  const paren = rest.match(/^([\s\S]*?)\s+(\((?:[^()]|\([^()]*\))*\))$/);
  if (paren) return { url: paren[1].trim(), title: paren[2] };

  const space = rest.search(/\s/);
  if (space > 0) {
    const head = rest.slice(0, space);
    const tail = rest.slice(space).trim();
    // 只在“前半像个文件名（带图片扩展名）、后半不像文件名”时才拆 ——
    // 否则 `path sound` 这种**本身就是带空格的文件名**会被拆坏；括号开头的尾巴留给上面那条
    // （这里猜只会猜错）。
    if (IMAGE_EXT.test(head) && !IMAGE_EXT.test(tail) && !tail.startsWith('(')) {
      return { url: head, title: `"${tail.replace(/"/g, '\\"')}"` };
    }
  }

  return { url: rest, title: '' };
}

/** 落盘文件名的分配器；这里只依赖最小的那一面（实现在 `note-content.ts`） */
export interface ImageNameAllocator {
  path(name: string, dir: 'images', options: { referencedBy: 'markdown' }): string;
}

/**
 * 把 markdown 里的图片目标换成落盘路径，并返回“这次要落盘的图片数”（外链不计）。
 *
 * `rewrite` 为 false（用户关了“把图片下载到 images/”）时只做计数、不动链接 —— 免得留下指向
 * 不存在文件的引用。
 */
export function rewriteImageTargets(
  markdown: string,
  options: { rewrite: boolean; namer: ImageNameAllocator },
): { markdown: string; imageRefs: number } {
  let imageRefs = 0;

  const next = replaceInlineLinks(markdown, (link) => {
    if (!link.image) return undefined;

    const { targets, size } = splitImageTargets(link.raw);
    const rewritten = targets.map((part) => {
      const { url, title } = splitImageTitle(part);
      const suffix = title ? ` ${title}` : '';
      if (!url || EXTERNAL_URL.test(url)) return part;

      imageRefs += 1;
      if (!options.rewrite) return part;

      return `${options.namer.path(url, 'images', { referencedBy: 'markdown' })}${suffix}`;
    });

    return `![${link.label}](${rewritten.join('|')}${size})`;
  });

  return { markdown: next, imageRefs };
}

/**
 * 把 `[label](目标 可选title)` 里的 `raw` 拆成“目标 + 其余部分”（附件链接改写用）。
 *
 * 目标就是第一个空白之前的那一段 —— 宿主产物里附件链接的目标没有空格，title 才在空格之后。
 */
export function linkTargetParts(raw: string): { target: string; rest: string } {
  const trimmed = raw.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return { target: trimmed, rest: '' };
  return { target: trimmed.slice(0, space), rest: trimmed.slice(space) };
}

/* ------------------------------------------------------------------ */
/* 笔记链接（内链 / 双链）→ wikilink / markdown 链接                    */
/* ------------------------------------------------------------------ */

/**
 * wikilink 名字里**没法表达**的字符；返回第一个命中的那一个（用于提示文案）。
 *
 * wikilink 没有任何转义机制 —— Obsidian 官方帮助文档（`Linking notes and files /
 * Internal links`）的原话是“含有以下字符的字符串可能无法作为链接生效”，给的规避方式是
 * **别在文件名里用它们**（官方清单：`# | ^ : %% [[ ]]`）。逐个对应：
 * `[` `]` 是链接定界符本身、`#` 是锚点分隔符（`[[note#heading]]`）、`^` 是块引用分隔符
 * （`[[note#^block]]`）、`%%` 与注释语法同形。
 *
 * ⚠️ 这里只挡**落盘名里真的可能出现**的那些：`|` `/` `\` `:` `*` `?` `"` `<` `>`
 * 早在 `convertToValidFilename()`（naming.ts）里就被换成空格了，轮不到它们破坏语法。
 * 单 `%` 也不挡 —— `100%` 这种名字很常见，官方清单里只有 `%%`。
 */
const WIKILINK_CONFLICT = /[\[\]#^]|%%/;

export function wikilinkConflict(name: string): string | undefined {
  return WIKILINK_CONFLICT.exec(name)?.[0];
}

/**
 * 渲染成 wikilink。
 *
 * 名字由调用方按**产物里的文件名**规则归一化（`toDiskName(extractNoteTitle(标题))`，
 * 见 note-content.ts 的 `noteBaseName()`）：wikilink 是按名字匹配的，写出来的名字必须
 * 与落盘文件名一字不差，`.md` 后缀也**不写**（Obsidian 的 `[[名字]]` 与 `[[名字.md]]`
 * 等价，默认生成的就是不带后缀的那种；带后缀在其他渲染器里还会把 `.md` 显示出来）。
 */
export function renderWikiLink(name: string): string {
  return `[[${name}]]`;
}

/**
 * markdown 链接**显示文本**里的转义。
 *
 * 只有回退成标准 markdown 链接时才用得上（wikilink 没有单独的显示文本），而标题里
 * `[` `]` 很常见（网页剪藏那种 `[栏目]标题` 的写法）：`]` 会提前结束 `[...]`，
 * 所以 `\` `[` `]` 一律转义。
 */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * 产物内的相对路径 → markdown 链接目标。
 *
 * **逐段**做 percent-encoding、并保留段之间的 `/`：目标是**路径**，不能整串丢给
 * `encodeURIComponent`（它会把 `/` 也编掉）。这正是 wikilink 冲突时的出路 ——
 * markdown 链接形式有正规的转义途径（官方要求目标做 percent-encoding），wikilink 没有。
 *
 * `(` `)` `'` 按 `encodeAttachmentName()` 的口径一并编掉：它们在裸目标里要么破坏括号
 * 配对、要么在部分渲染器里需要转义。空格 / 中文 / `#`（fragment）/ `^` / `[` `]` 都由
 * `encodeURIComponent` 负责。
 */
export function encodeMarkdownPath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[()']/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/');
}

/** 渲染成标准 markdown 链接（wikilink 表达不了时的回退） */
export function renderMarkdownLink(label: string, path: string): string {
  return `[${escapeLinkText(label)}](${encodeMarkdownPath(path)})`;
}
