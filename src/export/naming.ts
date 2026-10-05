/**
 * 文件 / 目录名的**合法化与唯一化** —— 全项目只此一套。
 *
 * ⚠️ 本模块**刻意不 import 任何其他模块**：名字策略要能被 `scripts/check-naming.mjs`
 * 直接 `import` 进来跑（Node 直跑 TS 时解析不了无扩展名的相对导入）。
 *
 * 两道工序，顺序不能反：
 * 1. **对齐上游**：`convertToValidFilename()`（本文件内）—— 复刻应用自己的函数，
 *    只把非法字符换成空格。保持原样是为了能和应用的命名对上；
 * 2. **落盘加固**：`portableName()` —— 在上游结果之上再修到跨文件系统安全
 *    （保留名 / 尾部点 / 控制字符 / 超长），然后把唯一化交给 `createNameAllocator()`。
 *
 * 唯一化本身有两个作用域，靠 `scope` 隔开：
 * - **archive 级**（`task.ts`）：文件夹名、正文文件名、根级 sidecar。不带 `scope`，名字就是完整 zip 路径；
 * - **每篇笔记目录级**（`note-content.ts`）：`images/` 与 `attachments/`。`scope` 取子目录名，名字是 basename。
 *
 * 撞名规则：加后缀 ` (N)`，N 从 2 起，**原名里的字符一个都不改**（所以文件名仍能看出原始标题）；
 * 文件插在**最后一个 `.` 之前**（`a.png` → `a (2).png`）；目录没有扩展名概念，一律追加到末尾。
 * 查重用的 key 会做 **NFC 归一化 + 大小写折叠**，落盘用的仍是原名。
 *
 * 为什么查重要折叠：Windows（NTFS）与 macOS（APFS / HFS+）默认**大小写不敏感**，部分还做
 * Unicode 归一化 —— 不折叠就会在解压时互相覆盖（正文或图片被静默顶掉）。代价是大小写敏感的
 * Linux 上会多出一些 ` (2)`；**宁可多改名，不可静默覆盖**。
 */

/**
 * 复刻应用里的同名函数：把文件名非法字符换成空格。
 *
 * 刻意与上游保持一字不差 —— 我们和应用的命名差异要能一眼看出是“加固”而不是“另一个实现”。
 * 加固的部分（保留名 / 尾部点 / 控制字符 / 超长）不在这里，见 `portableName()`。
 */
export function convertToValidFilename(name: string): string {
  return name.replace(/[/|\\:*?"<>]/g, ' ').trim();
}

/**
 * 单个路径组件的字节预算。
 *
 * 不是为了好看，是为了**真能落盘**：ext4 / APFS 的单个组件上限是 **255 字节**，而中文一个字
 * 3 字节 —— 大约 85 个中文就撞线；而附件的名字是**用户上传时自带的**，中文长标题的 PDF 很常见。
 *
 * 留到 200 是给同一篇笔记的派生名腾位置：`<标题>.md` / `.html` / `.meta.json`（最多再 +10 字节），
 * 以及撞名后缀 ` (N)`（最多 +6）。
 */
export const NAME_BUDGET_BYTES = 200;

/** C0 / C1 控制字符与 DEL：文件名里没有任何意义，还可能让 shell、解压器出问题 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Windows 保留名。**带扩展名同样被占用**（`con.txt` 也创建不出来），
 * `COM¹` / `LPT¹` 这类上标变体从 Windows 11 起也算。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/** 一个码点占几个 UTF-8 字节（比 `TextEncoder` 少一次分配） */
function utf8Size(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function byteLength(text: string): number {
  let total = 0;
  for (const char of text) total += utf8Size(char.codePointAt(0) ?? 0);
  return total;
}

/** 按**字节**截断，且不切断码点（按码点迭代，代理对不会被劈成半个字符） */
function truncateBytes(text: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = utf8Size(char.codePointAt(0) ?? 0);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * 去掉尾部的点号与空格。
 *
 * Windows 会**静默去掉**它们 —— 等于替我们改了名，可能正好撞上另一个文件
 * （`报告.` 目录被系统改成 `报告`，而另一篇就叫《报告》）。
 * 用循环而不是正则：`/[. ]+$/` 在长串点上会退化成二次方（CWE-1333）。
 */
function stripTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/** 保留名在 stem 后面补一个下划线：`con.txt` → `con_.txt`，`CON` → `CON_` */
function escapeReservedName(text: string): string {
  if (!WINDOWS_RESERVED.test(text)) return text;
  const dot = text.indexOf('.');
  return dot < 0 ? `${text}_` : `${text.slice(0, dot)}_${text.slice(dot)}`;
}

/** 截断到预算内，但**扩展名不参与**（截的只是 stem） */
function truncateKeepingExtension(text: string, budget: number): string {
  const dot = text.lastIndexOf('.');
  const stem = dot > 0 ? text.slice(0, dot) : text;
  if (byteLength(stem) <= budget) return text;
  const ext = dot > 0 ? text.slice(dot) : '';
  return `${truncateBytes(stem, budget)}${ext}`;
}

/**
 * 落盘加固：把“对齐上游之后”的名字再修到跨文件系统安全。
 *
 * 只处理**不修就真的会出问题**的四类（见 docs/export-pipeline.md §1.4）：
 * 1. 控制字符 —— 粘贴来的标题里很常见（front matter 那边也在专门测）；
 * 2. 尾部点号 / 空格 —— Windows 会静默去掉，等于改名；
 * 3. Windows 保留名 —— Windows 上根本创建不出来；
 * 4. 超长 —— 按字节截断并保留扩展名。
 *
 * 结果为空（原文只剩控制字符之类）由调用方兜底；截断制造出的**新撞名**由
 * `createNameAllocator()` 自然兜住，这里不用管。
 */
export function portableName(name: string, budget = NAME_BUDGET_BYTES): string {
  return truncateKeepingExtension(
    escapeReservedName(stripTrailingDotsAndSpaces(name.replace(CONTROL_CHARS, ''))),
    budget,
  );
}

/**
 * 落盘名的标准两道工序：**先对齐上游，再加固**。
 *
 * 顺序不能反：加固是“在上游结果之上”做的。全部为空时退回 `fallback`（例如标题只剩控制字符）。
 */
export function toDiskName(raw: string, fallback: string, budget = NAME_BUDGET_BYTES): string {
  return portableName(convertToValidFilename(raw), budget) || fallback;
}

/** 查重用的 key：NFC 归一化 + 大小写折叠。**只用于比较，不落盘** */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * 在名字里插入 ` (N)`。
 *
 * - `file`：插在**最后一个 `.` 之前**，扩展名保持不动；没有 `.`、或 `.` 在开头
 *   （`.gitignore`）时追加到末尾。
 * - `dir`：一律追加到末尾 —— 目录名里的 `.` 不是扩展名分隔符，
 *   `v1.0` 要变成 `v1.0 (2)` 而不是 `v1 (2).0`。
 */
export function withSuffix(name: string, index: number, kind: 'file' | 'dir' = 'file'): string {
  if (kind !== 'dir') {
    const dot = name.lastIndexOf('.');
    if (dot > 0) return `${name.slice(0, dot)} (${index})${name.slice(dot)}`;
  }
  return `${name} (${index})`;
}

export interface NameAllocator {
  /**
   * 分配一个唯一名字，撞名时按 ` (2)`、` (3)`… 顺延。
   *
   * @param name 期望用的名字（原名，字符不会被改写）
   * @param options.scope 查重命名空间，让“同名但在不同子目录”不算冲突
   *                      （如每篇笔记里的 `images/` 与 `attachments/`）
   * @param options.kind 文件 / 目录，决定 ` (N)` 插在哪
   */
  allocate(name: string, options?: { scope?: string; kind?: 'file' | 'dir' }): string;
  /**
   * 登记一个**不希望被改名**的名字（如正文文件名：它必须等于笔记标题）。
   * 返回是否拿到了空位 —— 返回 `false` 说明分配逻辑有 bug，调用方要做不变量断言。
   */
  reserve(name: string, options?: { scope?: string }): boolean;
}

export function createNameAllocator(): NameAllocator {
  const used = new Set<string>();
  const keyOf = (name: string, scope: string): string => foldName(scope ? `${scope}\n${name}` : name);

  return {
    allocate(name, options) {
      const scope = options?.scope ?? '';
      const kind = options?.kind ?? 'file';
      const key = keyOf(name, scope);
      if (!used.has(key)) {
        used.add(key);
        return name;
      }
      // 每次都从**原名**重新生成 ` (N)`，所以后缀永不嵌套：
      // 标题本来就叫 `报告 (2)` 也不会变成 `报告 (2) (2)`，只会顺延到 `报告 (3)`。
      let index = 2;
      let next = withSuffix(name, index, kind);
      while (used.has(keyOf(next, scope))) {
        index += 1;
        next = withSuffix(name, index, kind);
      }
      used.add(keyOf(next, scope));
      return next;
    },
    reserve(name, options) {
      const key = keyOf(name, options?.scope ?? '');
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}
