import { dump, type DumpOptions } from 'js-yaml';
import type { NoteRef } from './types';

/**
 * 笔记元数据的收集与序列化。
 *
 * ## 数据从哪来
 *
 * 全部来自**已经在手的笔记对象**（导出处从 React fiber 上取到的那一个），
 * 不需要查 IndexedDB、不需要任何网络请求。实测（2026-10-03）这个对象上有 34 个字段。
 *
 * 唯一的例外是**标签名**：`note.tags` 是 `guid1*guid2` 形式的 guid 列表，
 * 要换成名字得查主库的 `tags` 表（见 app-bridge 的 `resolveTagNames()`）。
 *
 * ## 两个坑
 *
 * - 有些字段是字符串 `'null'` 而不是真的 null（实测 `keywords` 有 34 篇如此），
 *   必须过滤，否则会写出 `keywords: "null"`;
 * - 时间戳在对象上可能是数字也可能是字符串，统一按毫秒解析。
 */

/** 顶层友好字段：`[输出名, 笔记对象上的原始字段名]`，数组顺序即输出顺序 */
const FRIENDLY_FIELDS: [string, string][] = [
  ['title', 'title'],
  ['created', 'created'],
  ['modified', 'dataModified'],
  ['accessed', 'accessed'],
  ['category', 'category'],
  ['tags', 'tags'],
  ['url', 'url'],
];

/** `wiznote` 命名空间里的原始字段（默认不导出，供排查用） */
const RAW_FIELDS: string[] = [
  'docGuid',
  'type',
  'fileType',
  'version',
  'readCount',
  'infoModified',
  'status',
];

/** 时间是这些字段，按 ISO 8601 输出；其余原样 */
const TIME_FIELDS = new Set(['created', 'modified', 'accessed', 'infoModified']);

/**
 * 本来就是数字的字段。
 *
 * 必须单独拎出来，让它们以 **YAML 数字**（而不是字符串）落盘：写成 `'13875'`
 * 下游就没法比较大小、排序。
 */
const NUMERIC_FIELDS = new Set(['version', 'readCount']);

export interface NoteMetadata {
  /** 顶层友好字段，已按需过滤空值 */
  fields: [string, string | number | string[]][];
  /** 原始字段（仅当用户勾选了“附带 WizNote 原始字段”） */
  raw: [string, string | number][];
}

/**
 * 归一化成字符串：`''`、`null`、`undefined`、字符串 `'null'` 一律当空。
 *
 * 实测有字段真的存了字符串 `'null'`，不挡掉就会写进文件里。
 */
function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : String(value);
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
}

/**
 * 毫秒时间戳 → ISO 8601 **带本地时区偏移**。
 *
 * 用带偏移的格式而不是 UTC：笔记的创建/修改时间对用户来说是“本地几点”，
 * 转成 UTC 反而要心算。同时它仍是机器可解析、可直接排序的。
 */
export function toIsoTime(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;

  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * `guid1*guid2` → 标签**完整路径**数组（`父/子/孙`）。
 *
 * 路径拍平规则见 tag-path.ts。解析不出的 guid 原样保留，不静默丢。
 */
function splitTags(value: unknown, tagPaths: Map<string, string>): string[] {
  const text = clean(value);
  if (!text) return [];
  return text
    .split('*')
    .map((guid) => guid.trim())
    .filter(Boolean)
    .map((guid) => tagPaths.get(guid) ?? guid);
}

export function collectMetadata(
  note: NoteRef,
  tagPaths: Map<string, string>,
  includeRaw: boolean,
  /**
   * 标签原文（`guid1*guid2`）的**覆盖值**。
   *
   * 列表右键拿到的笔记对象上 `tags` 实测是空串，真正的标签在本地 `docs` 行里
   * （见 app-bridge 的 `readNoteTags`）；调用方读出来从这里传进来。不传就只用对象上的。
   */
  tagsText?: string,
): NoteMetadata {
  const read = (key: string): unknown => (note as unknown as Record<string, unknown>)[key];

  /** 按字段名归一化成合适的类型：时间串 / 数字 / 普通字符串 */
  const normalize = (fieldName: string, source: unknown): string | number | undefined => {
    if (TIME_FIELDS.has(fieldName)) return toIsoTime(source);
    const text = clean(source);
    if (text === undefined) return undefined;
    if (NUMERIC_FIELDS.has(fieldName)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
    return text;
  };

  const fields: [string, string | number | string[]][] = [];
  for (const [outName, sourceKey] of FRIENDLY_FIELDS) {
    if (sourceKey === 'tags') {
      const tags = splitTags(tagsText ?? read(sourceKey), tagPaths);
      if (tags.length) fields.push([outName, tags]);
      continue;
    }
    const value = normalize(outName, read(sourceKey));
    if (value !== undefined) fields.push([outName, value]);
  }

  const raw: [string, string | number][] = [];
  if (includeRaw) {
    for (const key of RAW_FIELDS) {
      const value = normalize(key, read(key));
      if (value !== undefined) raw.push([key, value]);
    }
  }

  return { fields, raw };
}

/* ------------------------------------------------------------------ */
/* YAML                                                                */
/* ------------------------------------------------------------------ */

/**
 * YAML 的序列化交给 js-yaml，**不再手写引号 / 转义**。
 *
 * 之前是自己判“哪些字符串必须加引号”（特殊字符集 + 布尔/null 形状 + 数字形状 + 日期形状）。
 * 用真实解析器（pyyaml 6.0.3 = YAML 1.1）与本仓库的 54 个极端值逐条对拍，那份启发式有两个坑：
 *
 * - `- ` 开头的值不加引号 → `title: - dash` / `tags: [- dash]`，**YAML 语法错误**；
 * - 控制字符既不识别也不转义 → `\x00` / `\x07` / `\x0b` / `\x0c` 直接写进文件，解析器拒收；
 *   孤立 `\r` 与 NEL(`\u0085`) 虽被引号包住，但转义只认 `\r?\n`，会被 YAML 折叠成空格（**值变了**）。
 *
 * 这类“看着无害的字符”清单是列不完的，交给成熟库才是终点：js-yaml 的 dumper 偏保守 ——
 * `yes` / `on` / `2024-01-01` 这类**字符串**它会主动加引号（YAML 1.1 里它们是布尔 / 日期），
 * NEL / LS / PS 写成 `\N` / `\L` / `\P`，控制字符写成 `\x..` / `\u....`。
 * 同一批 54 个值实测 **0 失败**（手写版 8 个）。
 *
 * 三个参数是必需的，否则产物会悄悄变样：
 * - `lineWidth: -1`：**不折行**。默认 80 列，长标题 / 长 URL 会被折成多行；
 * - `quoteStyle: 'double'`：保持**双引号**（默认单引号，`'2024-01-02T…'` 与旧产物风格不一致）；
 * - `noRefs: true`：禁用锚点 / 别名（`&ref_0` / `*ref_0`）。正常数据用不到，出现只会让文件更难读。
 *
 * ⚠️ 我们用的是 **js-yaml 5**，它的 API 与 4.x 不同（重写过）：引号风格是 `quoteStyle: 'single'|'double'`，
 * 不再是 4.x 的 `quotingType: "'"|'"'`；`DumpOptions` 也由它自带（无需 `@types/js-yaml`）。
 *
 * 另注：标签数组现在是**块状**（每行一个），不再是行内 `[a, b]` —— js-yaml 没有“只让某个集合走
 * flow”的开关，而块状本来也是 front matter 里更常见的排版。
 */
const YAML_DUMP_OPTIONS = {
  lineWidth: -1,
  quoteStyle: 'double',
  noRefs: true,
} satisfies DumpOptions;

/**
 * 生成 YAML front matter（含首尾 `---`）。
 * 没有任何字段时返回空串 —— 不产出 `---\n---\n` 这种空壳。
 */
export function renderFrontMatter(metadata: NoteMetadata): string {
  if (metadata.fields.length === 0 && metadata.raw.length === 0) return '';

  const payload: Record<string, unknown> = {};
  for (const [key, value] of metadata.fields) payload[key] = value;
  if (metadata.raw.length > 0) {
    const raw: Record<string, string | number> = {};
    for (const [key, value] of metadata.raw) raw[key] = value;
    payload.wiznote = raw;
  }

  // `dump()` 自带结尾换行，所以这里只补 `---\n\n`
  return `---\n${dump(payload, YAML_DUMP_OPTIONS)}---\n\n`;
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

export interface MetadataJsonOptions {
  /** 同目录下对应的正文文件名，便于文件被挪走时重新关联 */
  file: string;
  exportedAt: string;
}

/**
 * 生成同名 `.meta.json` 的内容。
 *
 * 结构刻意与 YAML 保持一致（顶层友好字段 + 可选的 `wiznote` 块），
 * 只多两个定位字段：`file` 指向正文，`exportedAt` 记录导出时刻。
 */
export function renderMetadataJson(metadata: NoteMetadata, options: MetadataJsonOptions): string {
  const payload: Record<string, unknown> = { file: options.file, exportedAt: options.exportedAt };

  for (const [key, value] of metadata.fields) payload[key] = value;
  if (metadata.raw.length > 0) {
    const raw: Record<string, string | number> = {};
    for (const [key, value] of metadata.raw) raw[key] = value;
    payload.WizNote = raw;
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** 导出时刻，批量导出时所有 json 共用同一个值 */
export function nowIso(): string {
  return toIsoTime(Date.now()) ?? new Date().toISOString();
}
