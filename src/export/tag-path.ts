/**
 * 标签层级 → 完整路径。
 *
 * 为知笔记的标签是**树**：主库 `tags` 表的每一行都带 `parentGuid`（实测每一行都带），
 * 应用自己按 `children` 递归渲染成缩进树。笔记对象上的 `tags` 只是一串
 * `guid1*guid2`，光取 `name` 会把层级丢掉 —— 带标签的笔记里多级标签很常见
 * （占比与层级分布见 docs/private.local/library-stats.md），所以这不是边角情况。
 *
 * 这里把树拍平成 `父/子/孙`（分隔符 `/`）：
 *
 * - **应用没有自己的路径字符串约定**（UI 是缩进树），分隔符是我们定的。选 `/` 是因为
 *   它是 front matter 生态里嵌套标签的通行写法（Obsidian `#父/子`、Dataview 可按层级筛），
 *   对不认层级的消费者也只是普通字符串；
 * - 顶层标签的父是字面量 **`rootTagGuid`**（不是 guid，表里也没有这一行）—— 走到它就停；
 * - 父**查不到**（本地只同步了部分标签）与走到 `rootTagGuid` 一样处理：停，用已经收集到的
 *   那几段，**不臆造**父名；
 * - 带**环保护 + 深度上限**：脏数据不该让导出卡死。
 *
 * 纯函数，无 IO —— 所以 `scripts/check-front-matter.mjs` 能把脏数据（环、缺父、跨父同名）
 * 直接喂进来测，不必在浏览器里造数据。
 */

/** 顶层标签的父：字面量哨兵，不是 guid，`tags` 表里也没有对应行 */
export const ROOT_TAG_GUID = 'rootTagGuid';

/** 分隔符：`[收藏：来源]/果壳网` */
export const TAG_PATH_SEPARATOR = '/';

/**
 * 完整路径的**最大段数**（含自己这一段）。
 *
 * 正常数据最多 3 段（实测：`[收藏：分类]/[科技]/Office`）；这个上限只为防御脏数据
 * （自环、互指、超长链）导致死循环，取一个远大于真实深度的值，正常数据永远碰不到。
 */
const MAX_PATH_DEPTH = 16;

/** `tags` 表里用到的字段（其余字段与导出无关） */
export interface TagRow {
  tagGuid?: unknown;
  name?: unknown;
  parentGuid?: unknown;
}

/** `guid → 完整路径`。名字为空 / 重复的行按后者覆盖，与 Map 语义一致。 */
export function buildTagPaths(rows: readonly TagRow[]): Map<string, string> {
  const byGuid = new Map<string, { name: string; parentGuid: string }>();
  for (const row of rows) {
    const guid = typeof row.tagGuid === 'string' ? row.tagGuid : '';
    const name = typeof row.name === 'string' ? row.name : '';
    if (!guid || !name) continue;
    byGuid.set(guid, { name, parentGuid: typeof row.parentGuid === 'string' ? row.parentGuid : '' });
  }

  const paths = new Map<string, string>();
  for (const [guid, row] of byGuid) {
    const parts = [row.name];
    const seen = new Set([guid]);
    let parentGuid = row.parentGuid;

    // 注意条件是 `parts.length`：上限约束的是**路径段数**（含自己），不是“向上走几次”
    while (parts.length < MAX_PATH_DEPTH && parentGuid && parentGuid !== ROOT_TAG_GUID) {
      const parent = byGuid.get(parentGuid);
      // 父不在本地（含只同步了子树的情况）与环：都当到顶，保留已收集的部分
      if (!parent || seen.has(parentGuid)) break;
      seen.add(parentGuid);
      parts.unshift(parent.name);
      parentGuid = parent.parentGuid;
    }

    paths.set(guid, parts.join(TAG_PATH_SEPARATOR));
  }

  return paths;
}
