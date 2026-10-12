import { logger } from '../utils/log';
import { encodePathSegment } from './markdown-inline';
import { buildTagPaths, type TagRow } from './tag-path';
import type { NoteRef } from './types';

const log = logger('bridge');

/**
 * 应用适配层。
 *
 * ⚠️ 这个文件是唯一直接依赖为知笔记内部结构的地方，且用的都不是公开契约：
 *   1. 虚拟域 `//wiznote-desktop/...`（由 Service Worker 拦截后交给本地数据服务）
 *   2. React fiber 上的 `memoizedProps.note` / `selectedItems`
 *   3. `window.LiveEditor` 的 `getOfflineDocData` / `doc2markdown` / `html2Doc`
 *   4. 编辑器实例的 `contextMenu.show`
 * 上游改版时只需要改这里。
 */

/** 应用内部的虚拟域，SW 会把它映射到本地数据服务（离线也能命中） */
const VIRTUAL_HOST = '//wiznote-desktop';

interface EditorLike {
  contextMenu?: {
    show?: (event: MouseEvent, items: unknown[]) => void;
    hide?: () => void;
  };
  buildResourceUrl?: (name: string, fileName?: string, options?: { withToken?: boolean }) => string;
}

export interface LiveEditorApi {
  getOfflineDocData(kbGuid: string, docGuid: string): Promise<unknown>;
  doc2markdown(doc: unknown, options?: Record<string, unknown>): string;
  /**
   * 应用自己的 markdown 转义（`*` → `\*`、`#` → `\#`、`[x](y)` → `\[x\](y)`…）。
   *
   * 实测（2026-10-04，xapp 0.1.107）它对"本来就无害"的字符不动手：
   * `域名 -> IP地址`、`队列长度 < 最小门限` 都原样返回。大纲笔记的节点文本按纯文本处理，用它转义。
   */
  escapeMarkdownText?(text: string): string;
  html2Doc(html: string, options?: unknown): unknown;
  getAllResources?(doc: unknown): string[];
  getEditor?(): EditorLike | undefined;
  /** 开一个只读 WebSocket 把协作笔记同步到本地，成功与否由返回值表示 */
  syncOfflineDoc?(serverUrl: string, appId: string, docId: string, timeout?: number): Promise<boolean>;
}

function pageWindow(): Record<string, unknown> {
  return unsafeWindow as unknown as Record<string, unknown>;
}

export function getLiveEditor(): LiveEditorApi | undefined {
  const api = pageWindow().LiveEditor as LiveEditorApi | undefined;
  if (!api || typeof api.doc2markdown !== 'function') return undefined;
  return api;
}

export function getActiveEditor(): EditorLike | undefined {
  try {
    return getLiveEditor()?.getEditor?.();
  } catch {
    // 没有打开的笔记时编辑器会抛 "can not get parent editor"，属于正常情况
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 请求节流与重试                                                      */
/* ------------------------------------------------------------------ */

/**
 * 两次**网络请求**的起始时刻之间至少隔这么久。
 *
 * 本地命中不参与（见 `pacedFetch`）：它既不打后端，也没有必要等。
 */
const NETWORK_REQUEST_GAP_MS = 60;

/** 候选地址一个 HTTP 响应都没拿到（更像“本地服务 / 网络抽风”）时，隔多久把整条序列重走一遍 */
const NETWORK_RETRY_DELAY_MS = 400;

/** 可被中止打断的睡眠：`signal` 中止时立刻结束，不让用户多等 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 这次响应是不是**没走网络**（缓存 / 本地数据服务直接给的）。
 *
 * 依据 Resource Timing 的 `deliveryType === 'cache'`。实测（2026-10-07，本地数据服务命中）：
 * `deliveryType: 'cache'` + `transferSize: 0` + `encodedBodySize` 有值 + 4~29 ms。
 * 浏览器自己的 HTTP 缓存也算 `'cache'` —— 那同样没打到后端，一样不用配速。
 *
 * ⚠️ 这个字段**不是 Baseline**（Chrome 117+；Firefox 稳定版没有；Safari 26.4+），
 * 而且 resource timing 缓冲区默认只有 250 条、满了以后新条目可能压根不记录。
 * 所以**拿不到 / 看不懂一律返回 false（当成走了网络）** ——
 * 判错的方向只能是“多等一会儿”，绝不能变成“少等甚至不等”。
 */
function cameFromCache(startedAt: number, url: string): boolean {
  try {
    // ⚠️ 我们请求用的可能是协议相对地址（`//wiznote-desktop/...`），而 timing 条目里存的是
    // **绝对**地址 —— 不归一化就永远查不到（实测踩过：本地命中被判成“走了网络”，白等 60ms）。
    const absolute = new URL(url, location.href).href;
    const entries = performance.getEntriesByName(absolute);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      // `deliveryType` 是较新的字段，TS 自带的 DOM 类型里还没声明，这里就地补一个
      const entry = entries[index] as PerformanceResourceTiming & { deliveryType?: string };
      // 同名但更早的条目（app 自己渲染时拉过）不是这一次的，不看
      if (entry.startTime < startedAt) break;
      return entry.deliveryType === 'cache' || entry.deliveryType === 'navigational-prefetch';
    }
  } catch {
    /* 拿不到就当走了网络 */
  }
  return false;
}

interface PacerTicket {
  /** 等到属于这次请求的排班时刻 */
  wait(signal?: AbortSignal): Promise<void>;
  /** 记下这次请求，留到下一次领号时结算（原因见 `createRequestPacer` 的说明） */
  mark(url: string, startedAt: number): void;
}

/**
 * 请求节流器：保证**网络请求的起始时刻**之间至少隔 `gapMs`。
 *
 * 为什么按“起始”而不是“结束 + 固定 sleep”：一次请求本身就可能花掉几百毫秒，
 * 那份时间本来就已经起到了间隔作用，事后再睡 60ms 纯属白等 —— 实测一篇 122 个引用的
 * 笔记，光固定 sleep 就是 7.3 秒。改成按起始时刻排班之后：请求慢，下一次自然不用等；
 * 请求快（说明没什么负担），才补足间隔。
 *
 * 本地命中（`cameFromCache`）会把当时占的号**还回去**：它既不占后端资源，也不该让后面的
 * 请求多等。还号的动作**必须推迟到下一次领号时**：实测 Resource Timing 的条目要等
 * 响应体读完才出现（只拿到响应头时 `getEntriesByName` 还看不到这一条），
 * 抢在那时候判断必然判成“走了网络”。
 *
 * ⚠️ 只在**串行调用**下使用 —— 导出链路本来就是串行的（见 session.ts 的任务调度）。
 */
function createRequestPacer(gapMs: number): { take: () => PacerTicket } {
  let nextSlot = 0;
  let pending: { url: string; startedAt: number; slot: number; previous: number } | undefined;

  /** 结算“上一次请求”：确实命中缓存就把当时占的号还回去 */
  const settle = (): void => {
    if (!pending) return;
    const { url, startedAt, slot, previous } = pending;
    pending = undefined;
    if (cameFromCache(startedAt, url) && nextSlot === slot + gapMs) nextSlot = previous;
  };

  return {
    take: (): PacerTicket => {
      settle();
      const slot = Math.max(performance.now(), nextSlot);
      const previous = nextSlot;
      nextSlot = slot + gapMs;
      return {
        wait: (signal?: AbortSignal): Promise<void> => {
          const remain = slot - performance.now();
          return remain > 0 ? sleep(remain, signal) : Promise.resolve();
        },
        mark: (url: string, startedAt: number): void => {
          pending = { url, startedAt, slot, previous };
        },
      };
    },
  };
}

const requestPacer = createRequestPacer(NETWORK_REQUEST_GAP_MS);

/**
 * 所有**可能打到后端**的请求都从这里走：先领号等排班，拿到响应后判断这次是不是本地命中
 * （是就把号还回去）。
 *
 * ⚠️ 别在别处直接 `fetch()` —— 那样就绕过了节流（批量导出时正文本、评论、附件清单
 * 也是一篇一个请求，同样要排队）。
 */
async function pacedFetch(url: string, signal?: AbortSignal): Promise<Response> {
  const ticket = requestPacer.take();
  await ticket.wait(signal);
  const startedAt = performance.now();
  const res = await fetch(url, { credentials: 'include', signal });
  ticket.mark(url, startedAt);
  return res;
}

/**
 * 单地址的后端请求（正文 / 评论 / 附件清单等一篇一次的请求）：
 * `fetch` **整个抛异常**（没拿到任何响应）时隔一会儿再试一次。
 *
 * ⚠️ 只对“异常”重试：拿到 404 / 500 / 占位页这些**有响应**的结果一律原样交回调用方
 * —— 那些是结论，不是抖动，重试只会白等（也避免把“这篇没有”变成“多打一次服务端”）。
 */
async function pacedFetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await pacedFetch(url, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    log.warn('请求异常，稍后重试一次', url, error);
    await sleep(NETWORK_RETRY_DELAY_MS, signal);
    if (signal?.aborted) throw error;
    return await pacedFetch(url, signal);
  }
}

/**
 * 把候选地址序列跑一遍，返回结果与“这趟有没有看到过 HTTP 响应”。
 *
 * 一个 HTTP 响应都没看到（每次尝试都是 `fetch` 抛异常）说明更像**本地数据服务没就绪 /
 * 网络抽风**，而不是“这个资源不存在”—— 后者服务端会老老实实回 404 或占位页（那是有响应的）。
 * 所以只在“全程没响应”时隔 `NETWORK_RETRY_DELAY_MS` 把整条序列重走一遍，
 * 正常路径（含那些真的取不到的资源）一次都不会重试。
 */
async function attemptCandidates<T>(
  signal: AbortSignal | undefined,
  once: () => Promise<{ value?: T; sawResponse: boolean }>,
): Promise<T | undefined> {
  const first = await once();
  if (first.value !== undefined || first.sawResponse || signal?.aborted) return first.value;

  log.warn('候选地址一个 HTTP 响应都没拿到（本地服务 / 网络可能没就绪），稍后重试一次');
  await sleep(NETWORK_RETRY_DELAY_MS, signal);
  if (signal?.aborted) return undefined;
  return (await once()).value;
}

/* ------------------------------------------------------------------ */
/* 协作笔记的联网同步                                                  */
/* ------------------------------------------------------------------ */

/**
 * 应用与 Service Worker 同步协作笔记时，SW 会把 ksURL 带在
 * `wiz-ds-editor-sync-doc` 消息里。顺手记下来，导出时就能用它主动触发同步。
 */
let cachedKsUrl: string | undefined;

export function watchServiceWorkerMessages(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; ksURL?: string } | null | undefined;
    if (data?.type === 'wiz-ds-editor-sync-doc' && typeof data.ksURL === 'string' && data.ksURL) {
      cachedKsUrl = data.ksURL;
      log.debug('捕获到协作笔记服务地址 ksURL =', cachedKsUrl);
    }
  });
}

/**
 * 已知的协作笔记服务地址（ksURL）。
 *
 * 拿不到就返回 undefined —— **不要拿 `location.origin` 去猜**：
 * `syncOfflineDoc` 会先做一次 `GET {origin}/editor/{kb}/{doc}/auth` 握手，
 * 猜错只会得到 404 + `http auth error`，白等一轮超时。
 */
export function resolveKsUrl(note?: NoteRef): string | undefined {
  if (cachedKsUrl) return cachedKsUrl;
  const hosts = note
    ? [...knownResourceHosts, ...discoverResourceHosts(note.docGuid)]
    : [...knownResourceHosts];
  return hosts[0];
}

/**
 * 开一条只读 WebSocket 把协作笔记同步到本地。
 * 成功后 `getOfflineDocData` 就能读到内容，图片资源也会落到本地缓存。
 */
export async function syncCollabDoc(
  ksUrl: string,
  kbGuid: string,
  docGuid: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const liveEditor = getLiveEditor();
  if (!liveEditor?.syncOfflineDoc) {
    log.warn('编辑器未导出 syncOfflineDoc，无法联网同步');
    return false;
  }

  try {
    const ok = await liveEditor.syncOfflineDoc(ksUrl, kbGuid, docGuid, timeoutMs);
    log.debug('syncOfflineDoc 结果', { ksUrl, ok });
    return ok;
  } catch (error) {
    log.warn('syncOfflineDoc 异常', { ksUrl, error });
    return false;
  }
}

/**
 * 让 Service Worker 帮忙把文档从服务端拉到本地。
 *
 * 请求 `/ks/note/view/…/index.html` 时，SW 的拦截器会先跑 `getDoc(kb, doc)`——
 * 这一步会把文档下载并写进本地库。返回的 HTML 对协作笔记是
 * “当前客户端版本较低，无法编辑协作笔记”的占位页，**不能用**，
 * 但下载这个副作用是真有用的：之后 `getOfflineDocData` 就有内容了。
 *
 * 另外这条下载链路对协作笔记还会让 SW 向所有客户端广播
 * `wiz-ds-editor-sync-doc`，那正是捕获 ksURL 的时机。
 */
export async function triggerRemoteDocFetch(note: NoteRef, signal?: AbortSignal): Promise<void> {
  const html = await fetchText(noteViewPath(note.kbGuid, note.docGuid, 'index.html'), signal);
  log.debug('触发服务端拉取文档', { docGuid: note.docGuid, gotHtml: Boolean(html) });
}

/* ------------------------------------------------------------------ */
/* 定位笔记：列表项 / 笔记详情都用 <NoteItem note={note} /> 渲染       */
/* ------------------------------------------------------------------ */

const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];

function getFiber(el: Element): unknown {
  const key = Object.keys(el).find((k) => FIBER_PREFIXES.some((p) => k.startsWith(p)));
  return key ? (el as unknown as Record<string, unknown>)[key] : undefined;
}

function isNoteRef(value: unknown): value is NoteRef {
  if (!value || typeof value !== 'object') return false;
  const note = value as NoteRef;
  return typeof note.docGuid === 'string' && typeof note.kbGuid === 'string';
}

interface FiberNode {
  memoizedProps?: Record<string, unknown>;
  return?: FiberNode;
}

/** 沿 fiber 向上找第一个满足条件的 prop */
function findPropUpFiber<T>(fiber: FiberNode | undefined, pick: (props: Record<string, unknown>) => T | undefined): T | undefined {
  let current = fiber;
  let depth = 0;
  while (current && depth < 120) {
    const props = current.memoizedProps;
    if (props) {
      const found = pick(props);
      if (found !== undefined) return found;
    }
    current = current.return;
    depth += 1;
  }
  return undefined;
}

/**
 * React 只保证“经过 React 渲染的节点”带 fiber，右键目标可能是纯文本节点或
 * 未挂 fiber 的子元素，所以先沿 DOM 向上找到第一个有 fiber 的节点再走 fiber 链。
 */
function pickUpFrom<T>(
  target: EventTarget | null,
  pick: (props: Record<string, unknown>) => T | undefined,
): T | undefined {
  if (!(target instanceof Element)) return undefined;
  let element: Element | null = target;
  let hops = 0;
  while (element && hops < 30) {
    const found = findPropUpFiber(getFiber(element) as FiberNode | undefined, pick);
    if (found !== undefined) return found;
    element = element.parentElement;
    hops += 1;
  }
  return undefined;
}

/** 列表项 / 笔记详情都是 <NoteItem note={note} />，所以直接找 note 这个 prop */
export function findNoteFromElement(target: EventTarget | null): NoteRef | undefined {
  return pickUpFrom(target, (props) => (isNoteRef(props.note) ? props.note : undefined));
}

/**
 * 读取列表当前选中的笔记。
 * 虚拟列表组件拿到的就是 `selectedItems: selectedNotes`。
 */
export function findSelectedNotes(target: EventTarget | null): NoteRef[] | undefined {
  return pickUpFrom(target, (props) => {
    const items = props.selectedItems;
    return Array.isArray(items) && items.length > 0 && items.every(isNoteRef)
      ? (items as NoteRef[])
      : undefined;
  });
}

/* ------------------------------------------------------------------ */
/* 内容与资源地址                                                      */
/* ------------------------------------------------------------------ */

export function noteViewPath(kbGuid: string, docGuid: string, file: string): string {
  return `/ks/note/view/${kbGuid}/${docGuid}/${file}`;
}

/* --- 资源地址：doc 里的资源名有“两种”约定，必须按原样区分 --- */

function extensionOf(name: string): string {
  const clean = name.split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

/**
 * 有魔数可校验的图片扩展名。
 *
 * 嗅不出图片格式时，这些扩展名**不允许**“按长度放行”—— 否则一张 HTML 残页、
 * 一段 CSS 都可能被当成图片写进产物。
 */
const MAGIC_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg']);

/** 按内容嗅探出来的图片格式 */
type ImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'ico' | 'svg';

function isGifBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  );
}

/** 1×1 的 GIF（逻辑屏幕宽高在文件头 6..9 字节，小端） */
function isBlankGif(bytes: Uint8Array): boolean {
  return (
    isGifBytes(bytes) && bytes.length >= 10 && bytes[6] === 1 && bytes[7] === 0 && bytes[8] === 1 && bytes[9] === 0
  );
}

/**
 * 是不是 SVG 文本。
 *
 * 只认明确的 XML / SVG 开头：`text/html` 的错误页同样以 `<` 开头，放进来就会把
 * 一张“HTML 残页”存成图片（实测服务端对缺失资源会返回 146 / 169 字节的 `<htm…`）。
 */
function looksLikeSvgText(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.slice(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype svg');
}

/**
 * 按**内容**认图片格式，不看扩展名。
 *
 * ⚠️ 为什么不能按“扩展名对应的那一种魔数”校验：实测（2026-10-07）拿到的资源里有一批
 * **扩展名与内容不符**的真图 —— `x.png` 实际是 JPEG、`x.jpg` 实际是 PNG、
 * `x.gif` 实际是 PNG、`x.bmp` 实际是 WOFF 字体。按扩展名查表会把
 * 它们全部判成“取不到”（用户看到缺图，而图本身是好的，在应用里也显示得出来）。
 * 所以这里只认内容；落盘**仍用原来的文件名**（图片解码按内容嗅探，扩展名不影响显示）。
 */
function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (isGifBytes(bytes)) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';
  if (looksLikeSvgText(bytes)) return 'svg';
  return undefined;
}

/*
 * 路径段的编码是 `encodePathSegment()`，在 `./markdown-inline.ts`（零依赖，好让
 * `npm run check:markdown` 直接喂字符集测；这一条实测翻过两次车）。
 */

/**
 * 资源名的两种约定（与应用的 onBuildResourceUrl / 编辑器 buildResourceUrl 一致）：
 *
 *   1. `index_files/xxx.png` —— 老笔记、Lite 笔记、以及渲染端上传的资源，
 *      走 `/ks/note/view/{kb}/{doc}/index_files/xxx.png`
 *   2. 不带前缀的哈希名 `xxxx.png` —— 协作笔记自己的资源，
 *      走 `{apiServer}/editor/{kb}/{doc}/resources/xxxx`（apiServer 即虚拟域）
 *
 * ⚠️ 千万不要给不带前缀的名字硬补 `index_files/`，那会走到老笔记的路径上。
 */
export function resourcePaths(note: NoteRef, name: string): string[] {
  // 远程渲染出来的 HTML 里，图片可能已经是可直接访问的地址
  // （协议相对 `//wiznote-desktop/...` 或根相对 `/...`），直接用，不要再拼路径。
  if (/^(\/\/|\/)/.test(name)) return [name];

  const kb = encodeURIComponent(note.kbGuid);
  const doc = encodeURIComponent(note.docGuid);
  const bare = name.replace(/^(index_files|images)\//, '');
  const encoded = encodePathSegment(bare);

  const ksPath = noteViewPath(note.kbGuid, note.docGuid, `index_files/${encoded}`);
  const editorPath = `/editor/${kb}/${doc}/resources/${encoded}`;

  return name.startsWith('index_files/') ? [ksPath, editorPath] : [editorPath, ksPath];
}

/* ------------------------------------------------------------------ */
/* 协作笔记资源的真实源站                                              */
/* ------------------------------------------------------------------ */

/**
 * 协作笔记的图片存在编辑器服务上，地址是
 * `${apiServer}/resources/${name}`，`apiServer` 形如
 * `https://vipkshttpsN.wiz.cn/editor/{kb}/{doc}`。
 *
 * ⚠️ 不能用 `//wiznote-desktop/...` 去取！Service Worker 的资源处理逻辑是
 * “先按文件名查本地缓存，未命中就用**请求自身的 host** 去网络拉”——
 * 打到 `wiznote-desktop` 时那个 fetch 会 DNS 失败（`TypeError: Failed to fetch`）。
 * 所以只有当编辑器**已经**把图片拉过一遍、缓存里有名字之后，虚拟主机才碰巧能用。
 * 想冷启动成功，必须直接打真实源站。
 */
const knownResourceHosts = new Set<string>();
let knownResourceToken: string | undefined;

/** 记录编辑器的 apiServer / token（编辑器产出的 doc 上带这两个字段） */
export function rememberResourceSource(apiServer: unknown, token: unknown): void {
  if (typeof apiServer === 'string' && /^https?:\/\//.test(apiServer)) {
    try {
      const { origin } = new URL(apiServer);
      if (origin !== location.origin && !knownResourceHosts.has(origin)) {
        knownResourceHosts.add(origin);
        log.info('记录协作笔记资源源站', origin);
      }
    } catch {
      /* 忽略非法地址 */
    }
  }
  if (typeof token === 'string' && token) knownResourceToken = token;
}

/**
 * 从页面已经发生的请求里反查源站。
 * 编辑器渲染图片时会直接访问 `https://{kbServer}/editor/...`，
 * 这些地址会出现在资源计时条目或已经渲染出来的 `<img>` 上。
 */
function discoverResourceHosts(docGuid: string): string[] {
  const found: string[] = [];
  const consider = (raw: string): void => {
    if (!raw.includes('/editor/') || (docGuid && !raw.includes(docGuid))) return;
    try {
      const { origin } = new URL(raw, location.href);
      if (origin !== location.origin && !knownResourceHosts.has(origin) && !found.includes(origin)) {
        found.push(origin);
      }
    } catch {
      /* 忽略非法地址 */
    }
  };

  try {
    for (const entry of performance.getEntriesByType('resource')) consider(entry.name);
  } catch {
    /* 忽略 */
  }
  for (const img of document.images) consider(img.src);

  return found;
}

/**
 * 只看 note.type 里的协作笔记标记。
 * 这里不引 `getNoteType`，避免 app-bridge 与 note-content 互相依赖。
 */
function isCollaborationNote(note: NoteRef): boolean {
  const type = (note as unknown as { type?: unknown }).type;
  return /collab/i.test(String(type ?? ''));
}

/**
 * 某个资源名可能对应的所有抓取地址（**顺序即优先级**）。
 *
 * 两条路各自服务一类笔记，顺序是实测调出来的：
 *
 * | 路径 | 谁的资源在这儿 | SW 先查哪个本地库 |
 * | --- | --- | --- |
 * | `//wiznote-desktop/ks/note/view/…/index_files/…` | 普通笔记 / 保存网页 / Lite / 大纲 … | 本地数据服务（笔记数据 + `wiz-note-resource`），按**裸名**查 |
 * | `{真实源站}/editor/…/resources/…` | 协作笔记 | OT 资源缓存，按**文件名**查（与 host/path 无关） |
 *
 * ⚠️ 关键结论（实测 2026-10-04）：**两条路都会被 Service Worker 接住、先查本地**，
 * 区别只在查的是哪个库。所以“打网络地址”并不等于“真的走网络”——
 * 顺序决定的是**有没有先走对那条路**：
 *
 * - **协作笔记**：`/editor/…` 命中本地 OT 缓存就直接返回（实测 20 ms、字节与缓存一致，
 *   没走网络），所以真实源站放最前，一条都不浪费。
 * - **普通笔记**：`/editor/…` 查的是 OT 库，对它**永远 miss** → SW 带 token 真去打源站 →
 *   **404，实测 268 ms/张**（一篇 20 张图白跑 5 秒 + 服务端 20 条 404 日志）。
 *   它的资源只在 `/ks/…` 那条路的本地库里，所以 `/ks/…` 必须放最前。
 *
 * 假图不会挡住后一条候选：`/ks/…` 本地没有时服务端会返回 807 B 占位图，
 * 校验（`looksLikePlaceholder`）会把 200 但内容不对的响应拒掉并继续往下试。
 */
async function resourceUrls(note: NoteRef, name: string): Promise<string[]> {
  const collab = isCollaborationNote(note);
  /** 虚拟域下的 `/editor/…/resources/…`（协作笔记的本地 OT 缓存就在这条路上） */
  const virtualEditor: string[] = [];
  /** 虚拟域下的 `/ks/note/view/…`（本地数据服务） */
  const virtualKs: string[] = [];
  /** 真实源站，以及当前编辑器直接给出的地址 */
  const remote: string[] = [];

  // 完全不知道源站时问一次账号服务（结果按知识库缓存，不会反复请求）
  if (knownResourceHosts.size === 0) {
    const kbServer = await fetchKbServer(note.kbGuid);
    if (kbServer) rememberResourceSource(kbServer, undefined);
  }

  // 最权威的是当前打开的笔记：直接问编辑器
  try {
    const fromEditor = getActiveEditor()?.buildResourceUrl?.(name);
    if (fromEditor && /^(https?:)?\/\//.test(fromEditor)) remote.push(fromEditor);
  } catch {
    /* 编辑器不可用就跳过 */
  }

  // 协作笔记：真实源站是图片尚未被编辑器加载过时唯一可行的路径
  if (!/^(\/\/|\/)/.test(name)) {
    const bare = name.replace(/^(index_files|images)\//, '');
    const editorPath =
      `/editor/${encodeURIComponent(note.kbGuid)}/${encodeURIComponent(note.docGuid)}` +
      `/resources/${encodePathSegment(bare)}`;
    const query = knownResourceToken ? `?token=${encodeURIComponent(knownResourceToken)}` : '';
    for (const host of [...knownResourceHosts, ...discoverResourceHosts(note.docGuid)]) {
      remote.push(`${host}${editorPath}${query}`);
    }
  }

  for (const path of resourcePaths(note, name)) {
    // 协作笔记的图片不在 index_files 下：那条路径会返回 200 + 一个伪造的小图。
    // 实测同一个文件走 index_files 只有 807 B 占位图，走真实源站才是真图。
    if (collab && path.includes('/index_files/')) continue;
    const url = `${VIRTUAL_HOST}${path}`;
    if (path.includes('/ks/note/view/')) virtualKs.push(url);
    else virtualEditor.push(url);
  }

  const urls = collab
    ? [...remote, ...virtualEditor, ...virtualKs]
    : [...virtualKs, ...virtualEditor, ...remote];

  return [...new Set(urls)];
}

/**
 * 本地缓存未命中时，服务端对不存在的资源会返回 **200 + 一张 1×1 的 GIF 占位图**
 * （实测 807 字节，content-type 还会跟着请求的扩展名撒谎，见 docs/site-internals.md §2.6），
 * 所以“拿到 200”不代表拿到真文件。
 *
 * 两种识别方式，缺一不可：
 * 1. **精确命中**：1×1 且正好 807 字节 —— `.gif` 名字的资源只能靠它认出来
 *    （那种情况下扩展名与内容一致，魔数校验挡不住，是文档里记过的残留风险）；
 * 2. 旧规则兜底：体积很小 + GIF 头 + 目标扩展名不是 `.gif`（非 GIF 名字不需要精确匹配，
 *    这样即便上游换了占位图大小也仍然挡得住）。
 *
 * 附件（任意类型、没有魔数可校验）同样只用这个函数把关。
 */
const PLACEHOLDER_GIF_SIZE = 807;

function looksLikePlaceholder(bytes: Uint8Array, name: string): boolean {
  if (!isGifBytes(bytes)) return false;
  if (bytes.length === PLACEHOLDER_GIF_SIZE && isBlankGif(bytes)) return true;
  if (bytes.length > 2048) return false;
  return extensionOf(name) !== 'gif';
}

/**
 * 取**附件**（PDF / Office 文档 / DrawIO 图等非图片文件）。
 *
 * 与 `fetchResource` 共用候选地址，但**不能共用那套图片校验**：
 * 附件的 content-type 是 `application/pdf` 之类，会被图片白名单直接判死；
 * 扩展名也没有魔数，`sniffImageFormat` 对它们只会返回空。所以这里只用
 * “非空 + 不是占位图”把关。
 */
export async function fetchAttachment(
  note: NoteRef,
  name: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const urls = await resourceUrls(note, name);

  const once = async (): Promise<{ value?: Uint8Array; sawResponse: boolean }> => {
    let sawResponse = false;
    for (const url of urls) {
      try {
        const res = await pacedFetch(url, signal);
        sawResponse = true;
        if (!res.ok) {
          log.debug('附件请求非 200', url, res.status);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) continue;
        if (looksLikePlaceholder(bytes, name)) {
          log.debug('附件拿到的是占位图，跳过', { url, bytes: bytes.length });
          continue;
        }
        log.debug('附件命中', { url, bytes: bytes.length });
        return { value: bytes, sawResponse };
      } catch (error) {
        log.debug('附件请求异常', url, error);
      }
    }
    return { sawResponse };
  };

  const bytes = await attemptCandidates(signal, once);
  if (bytes) return bytes;

  // 中止时这条请求注定拿不到东西：别把“被中止”记成“取不到”（调用方会整篇作废）
  if (signal?.aborted) return undefined;
  log.warn('附件取不到有效内容', { name, tried: urls });
  return undefined;
}

/**
 * 取**图片**。
 *
 * 校验顺序（每一步都有实测依据，别调换）：
 * 1. **先挡占位图** —— 本地服务对缺失资源返回的 807 B GIF，content-type 还会跟着
 *    请求的扩展名撒谎；不先挡掉，下一步的“按内容认格式”会把它当成真 GIF 收下；
 * 2. **按内容认格式**（`sniffImageFormat`）—— 内容确实是图片就收，扩展名与内容不符也收
 *    （实测这类“名不副实”的真图不少：`.png` 里是 JPEG、`.jpg` 里是 PNG、`.bmp` 里是字体）；
 * 3. 嗅不出格式时**退化**：只有“扩展名本来就没有魔数可校验”（如 `.tif` / `.heic`）
 *    且 content-type 看着像文件时才按长度放行，其余一律判为不是图片并继续试下一个候选。
 */
export async function fetchResource(
  note: NoteRef,
  name: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const urls = await resourceUrls(note, name);

  const once = async (): Promise<{ value?: Uint8Array; sawResponse: boolean }> => {
    let sawResponse = false;
    for (const url of urls) {
      try {
        const res = await pacedFetch(url, signal);
        sawResponse = true;
        if (!res.ok) {
          log.debug('资源请求非 200', url, res.status);
          continue;
        }
        const contentType = res.headers.get('content-type') ?? '';
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) continue;
        if (looksLikePlaceholder(bytes, name)) {
          log.debug('资源拿到的是占位图，跳过', { url, bytes: bytes.length });
          continue;
        }
        const format = sniffImageFormat(bytes);
        if (format) {
          log.debug('资源命中', { url, format, contentType, bytes: bytes.length });
          return { value: bytes, sawResponse };
        }
        const typeOk =
          !contentType || contentType.startsWith('image/') || contentType.startsWith('application/octet-stream');
        if (typeOk && !MAGIC_EXTENSIONS.has(extensionOf(name)) && bytes.length > 8) {
          log.debug('资源命中（扩展名无魔数可校验，按长度放行）', { url, contentType, bytes: bytes.length });
          return { value: bytes, sawResponse };
        }
        log.debug('资源不是有效图片', { url, contentType, bytes: bytes.length });
      } catch (error) {
        log.debug('资源请求异常', url, error);
      }
    }
    return { sawResponse };
  };

  const bytes = await attemptCandidates(signal, once);
  if (bytes) return bytes;

  // 中止时这条请求注定拿不到东西：别把“被中止”记成“取不到”（调用方会整篇作废）
  if (signal?.aborted) return undefined;
  log.warn('资源取不到有效内容', { name, tried: urls });
  return undefined;
}

/**
 * 按 BOM 判断编码。**不能直接用 `res.text()`** ——
 * 保存的网页资源里 CSS 往往是 UTF-16（实测知乎的 `share.css` 是 `FF FE` + UTF-16LE），
 * 按 UTF-8 解会得到一堆乱码，内联进 HTML 后整篇样式都是废的。
 */
function decodeResourceText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * 取**文本类**资源（目前只有外链样式表用）。
 *
 * 和 `fetchResource` 共用候选地址，但**不做图片校验** —— 校验里那套 content-type
 * 白名单和文件头特征都是为图片写的，`text/css` 会被直接判死。
 */
export async function fetchResourceText(
  note: NoteRef,
  name: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const urls = await resourceUrls(note, name);

  const once = async (): Promise<{ value?: string; sawResponse: boolean }> => {
    let sawResponse = false;
    for (const url of urls) {
      try {
        const res = await pacedFetch(url, signal);
        sawResponse = true;
        if (!res.ok) {
          log.debug('文本资源请求非 200', url, res.status);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) continue;
        const text = decodeResourceText(bytes);
        // 本地没有时服务端会返回 807 B 占位图（GIF）；它解出来到处是 NUL，
        // 直接当 CSS 内联进去整篇样式都是废的，所以这里挡一道。
        if (text.includes('\u0000')) {
          log.debug('文本资源解出来是二进制（疑似占位图）', { url, bytes: bytes.length });
          continue;
        }
        log.debug('文本资源命中', { url, bytes: bytes.length });
        return { value: text, sawResponse };
      } catch (error) {
        log.debug('文本资源请求异常', url, error);
      }
    }
    return { sawResponse };
  };

  const text = await attemptCandidates(signal, once);
  if (text !== undefined) return text;

  // 中止时这条请求注定拿不到东西：别把“被中止”记成“取不到”（调用方会整篇作废）
  if (signal?.aborted) return undefined;
  log.warn('文本资源取不到', { name, tried: urls });
  return undefined;
}

export async function fetchText(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await pacedFetchWithRetry(`${VIRTUAL_HOST}${path}`, signal);
    if (res.ok) return res.text();
    log.debug('文本请求非 200', path, res.status);
  } catch (error) {
    log.debug('文本请求异常', path, error);
  }
  return undefined;
}

function readRecord<T>(db: IDBDatabase, store: string, key: IDBKeyRange): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(store)) {
        resolve(undefined);
        return;
      }
      const request = db.transaction([store], 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result ?? undefined) as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function readAllRecords(db: IDBDatabase, store: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(store)) {
        resolve([]);
        return;
      }
      const request = db.transaction([store], 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as Record<string, unknown>[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function pickKbServer(rows: Record<string, unknown>[], kbGuid: string): string | undefined {
  const hit = rows.find((row) => row.kbGuid === kbGuid);
  const value = hit?.kbServer;
  return typeof value === 'string' && value ? value.replace(/\/+$/, '') : undefined;
}

const kbServerCache = new Map<string, string>();

/**
 * 查知识库的服务器地址（`kbServer`，形如 `https://vipkshttpsN.wiz.cn`）。
 *
 * 这是同步协作笔记正文和下载图片的**前置条件**。实测（2026-10-03，xapp 0.1.107）
 * 它就在应用的 IndexedDB 里，页面同源可直读，零请求零猜测：
 *
 * - `wiz-account` → `accounts` → `{ kbGuid, kbServer, serverUrl, token, ... }`
 * - `wiz-<guid>`（每个知识库一个库）→ `kbs` → 每条知识库记录也带 `kbServer`
 *
 * ⚠️ 别走 `/as/**` 接口：它**不**被 Service Worker 代理，
 * `//wiznote-desktop/as/user/groups` 会直接 `ERR_NAME_NOT_RESOLVED`。
 */
export async function fetchKbServer(kbGuid: string): Promise<string | undefined> {
  const cached = kbServerCache.get(kbGuid);
  if (cached) return cached;

  const fromAccount = await readKbServerFromAccount(kbGuid);
  if (fromAccount) return rememberKbServer(kbGuid, fromAccount, 'wiz-account/accounts');

  const fromKbDatabases = await readKbServerFromKbDatabases(kbGuid);
  if (fromKbDatabases) return rememberKbServer(kbGuid, fromKbDatabases, 'wiz-*/kbs');

  log.warn('没能从 IndexedDB 里查到知识库服务器地址', kbGuid);
  return undefined;
}

function rememberKbServer(kbGuid: string, host: string, source: string): string {
  kbServerCache.set(kbGuid, host);
  log.info('查到知识库服务器', { kbGuid, kbServer: host, source });
  return host;
}

async function readKbServerFromAccount(kbGuid: string): Promise<string | undefined> {
  const db = await openDb('wiz-account');
  if (!db) return undefined;
  return pickKbServer(await readAllRecords(db, 'accounts'), kbGuid);
}

/** 商务 / 共享知识库不在 `wiz-account` 里，得扫各知识库自己的库 */
async function readKbServerFromKbDatabases(kbGuid: string): Promise<string | undefined> {
  // accountDbNames() 已按 indexedDB.databases() 过滤出真实存在的 wiz-* 库
  for (const name of await accountDbNames()) {
    const db = await openDb(name);
    if (!db) continue;
    const found = pickKbServer(await readAllRecords(db, 'kbs'), kbGuid);
    if (found) return found;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 普通笔记的附件（attachments 表 + /ks/attachment/download）           */
/* ------------------------------------------------------------------ */

/** 普通笔记的一个附件 */
export interface NoteAttachment {
  /** 附件 guid，下载时用它 */
  attGuid: string;
  /** 上传时的原始文件名 */
  name: string;
}

/**
 * 全库附件索引：`{kbGuid}\n{docGuid}` → 该笔记的附件。
 *
 * ⚠️ 必须**整表读一次然后缓存**，不能按笔记逐篇查：批量导出几千篇时，
 * 每篇都全表扫一遍 `attachments` 是平方级开销。
 */
let attachmentIndex: Promise<Map<string, NoteAttachment[]>> | undefined;

async function loadAttachmentIndex(): Promise<Map<string, NoteAttachment[]>> {
  const byDoc = new Map<string, NoteAttachment[]>();

  for (const dbName of await accountDbNames()) {
    const db = await openDb(dbName);
    if (!db) continue;
    for (const row of await readAllRecords(db, 'attachments')) {
      const kbGuid = typeof row.kbGuid === 'string' ? row.kbGuid : '';
      const docGuid = typeof row.docGuid === 'string' ? row.docGuid : '';
      const attGuid = typeof row.attGuid === 'string' ? row.attGuid : '';
      if (!kbGuid || !docGuid || !attGuid) continue;

      const key = `${kbGuid}\n${docGuid}`;
      const list = byDoc.get(key) ?? [];
      list.push({ attGuid, name: typeof row.name === 'string' && row.name ? row.name : attGuid });
      byDoc.set(key, list);
    }
  }

  log.debug('附件索引已建立', { docs: byDoc.size });
  return byDoc;
}

/**
 * 从服务端取这篇笔记的附件清单（**要 token**）。
 *
 * ```
 * GET {kbServer}/ks/note/attachments/{kbGuid}/{docGuid}?token=<token>
 * ```
 *
 * 实测（2026-10-04，xapp 0.1.107）：`200` + `{ result: [{ attGuid, name, dataSize, … }] }`，
 * 没有附件时 `result` 为 `null`；不带 token 与 `info` 接口一样是
 * `200 + { returnCode: 301, "Invalid token" }`（所以不能只看 HTTP 状态码）。
 *
 * 这是应用自己附件面板的数据源，因此它是**清单的权威来源**；本地 `attachments` 表只是它的缓存。
 */
export async function fetchNoteAttachments(
  note: NoteRef,
  signal?: AbortSignal,
): Promise<NoteAttachment[] | undefined> {
  const kbServer = await fetchKbServer(note.kbGuid);
  const token = await readAccountToken(note.kbGuid);
  if (!kbServer || !token) {
    log.debug('查不到服务器地址或令牌，附件清单取不到');
    return undefined;
  }

  const path =
    `/ks/note/attachments/${encodeURIComponent(note.kbGuid)}/${encodeURIComponent(note.docGuid)}`;

  try {
    const res = await pacedFetchWithRetry(`${kbServer}${path}?token=${encodeURIComponent(token)}`, signal);
    if (!res.ok) {
      log.debug('附件清单请求非 200', { docGuid: note.docGuid, status: res.status });
      return undefined;
    }
    const payload = (await res.json()) as {
      returnCode?: number;
      result?: Array<{ attGuid?: unknown; name?: unknown }> | null;
    };
    if (typeof payload?.returnCode === 'number' && payload.returnCode !== 200) {
      log.debug('附件清单返回错误码', { docGuid: note.docGuid, returnCode: payload.returnCode });
      return undefined;
    }

    const list = Array.isArray(payload.result) ? payload.result : [];
    return list.flatMap((row) => {
      const attGuid = typeof row.attGuid === 'string' ? row.attGuid : '';
      if (!attGuid) return [];
      return [{ attGuid, name: typeof row.name === 'string' && row.name ? row.name : attGuid }];
    });
  } catch (error) {
    log.debug('附件清单请求异常', { docGuid: note.docGuid, error });
    return undefined;
  }
}

/**
 * 列出普通笔记的附件。
 *
 * 数据源有两个，**能用本地就不联网**：
 * - 本地 `attachments` 表（整表读一次建立的索引，零请求）—— 命中且看着完整就够用；
 * - 服务端 `/ks/note/attachments/…`（要 token）—— 本地没有这篇笔记的行、或行数明显少于
 *   笔记自带的 `attachmentCount`、或某行的名字是缺的（只有 guid）时，才补一次请求。
 *
 * 实测（2026-10-04，xapp 0.1.107）：普通笔记的附件**在正文 HTML 里只有“引用”，没有清单**。
 * 所以两边都要看：**清单回答“有哪些附件”，正文 HTML 回答“哪里引用了它”**（见 note-content）。
 *
 * ⚠️ `dataSize` 不可信：本地行里是 `0`，服务端 list 接口也返回 `0`，
 * 而真实文件是有字节的。不要拿它做校验或提前报大小。
 */
export async function listNoteAttachments(
  note: NoteRef,
  options: { allowNetwork?: boolean; declared?: number } = {},
  signal?: AbortSignal,
): Promise<NoteAttachment[]> {
  attachmentIndex ??= loadAttachmentIndex();
  const byDoc = await attachmentIndex;
  const key = `${note.kbGuid}\n${note.docGuid}`;
  const local = byDoc.get(key) ?? [];

  // 本地这一份可信吗？行数够、且每行都有真名字，才算够用
  const declared = options.declared ?? 0;
  const nameUnknown = local.some((item) => item.name === item.attGuid);
  const covered = local.length > 0 && local.length >= declared && !nameUnknown;
  if (covered || !options.allowNetwork) return local;

  const remote = await fetchNoteAttachments(note, signal);
  if (!remote) return local;

  // 合并而不是覆盖：本地行是应用自己同步下来的，服务端清单万一被截断/分页，
  // 覆盖会**静默丢附件**；合并最坏也只是多试一个已失效的 guid（下载会 404 并被报出来）。
  const merged = new Map<string, NoteAttachment>();
  for (const item of local) merged.set(item.attGuid.toLowerCase(), item);
  for (const item of remote) merged.set(item.attGuid.toLowerCase(), item);

  const list = [...merged.values()];
  if (list.length !== local.length) {
    log.debug('附件清单：本地与服务端不一致，已合并', {
      docGuid: note.docGuid,
      local: local.length,
      remote: remote.length,
    });
  }
  byDoc.set(key, list);
  return list;
}

/**
 * 下载普通笔记附件的**原始文件**。
 *
 * 实测（2026-10-04，xapp 0.1.107）：
 *
 * ```
 * GET {kbServer}/ks/attachment/download/{kbGuid}/{docGuid}/{attGuid}
 * ```
 *
 * - **必须带 token**：带 token → 200 + 原始字节（实测文件头 `89 50 4E 47`）；
 *   不带 token → **500**（`text/plain`，21 字节）。attGuid 不存在时 **404**。
 *   ⚠️ “同一个 token 校验”在不同接口上的表现并不一致，别只按 HTTP 状态码判断：
 *   `/ks/attachment/info/…`、`/ks/note/attachments/…` 不带 token 是 HTTP 200 +
 *   `returnCode: 301 Invalid token`，而这个下载接口是 HTTP 500。
 * - 代码**先带 token 试**，失败再退回不带 token —— 平时一次命中，provider 版本差异时也有兜底。
 * - **虚拟域 `//wiznote-desktop` 走不通**：SW 的本地数据服务只实现了 `/ks/note/view/**` 一类路由，
 *   这条路径不在其中，miss 之后 SW 拿请求自身的 host 去拉 → DNS 失败（实测 `Failed to fetch`）。
 *
 * ⚠️ 正文里的 `index_files/{attGuid}_image.png` **不是**这个文件：那是服务端重新编码过的预览图
 * （实测预览图经过重编码，字节数与原始文件并不一致、甚至更大），不能拿它冒充附件。
 */
export async function fetchNoteAttachment(
  note: NoteRef,
  attGuid: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const kbServer = await fetchKbServer(note.kbGuid);
  if (!kbServer) {
    log.warn('查不到知识库服务器地址，附件取不到', { attGuid });
    return undefined;
  }

  const path =
    `/ks/attachment/download/${encodeURIComponent(note.kbGuid)}/${encodeURIComponent(note.docGuid)}` +
    `/${encodeURIComponent(attGuid)}`;
  // 带 token 的优先：不带 token 实测稳定 500，先试它等于每篇附件白跑一次请求
  const token = await readAccountToken(note.kbGuid);
  const urls = token ? [`${kbServer}${path}?token=${encodeURIComponent(token)}`] : [];
  urls.push(kbServer + path);

  const once = async (): Promise<{ value?: Uint8Array; sawResponse: boolean }> => {
    let sawResponse = false;
    for (const url of urls) {
      try {
        const res = await pacedFetch(url, signal);
        sawResponse = true;
        if (!res.ok) {
          log.debug('附件请求非 200', { attGuid, status: res.status });
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) continue;
        // 附件是任意类型，没有魔数可校验，只能反过来挡 807 B 占位图
        if (looksLikePlaceholder(bytes, attGuid)) {
          log.debug('附件拿到的是占位图，跳过', { attGuid, bytes: bytes.length });
          continue;
        }
        log.debug('附件命中', { attGuid, bytes: bytes.length });
        return { value: bytes, sawResponse };
      } catch (error) {
        log.debug('附件请求异常', { attGuid, error });
      }
    }
    return { sawResponse };
  };

  const bytes = await attemptCandidates(signal, once);
  if (bytes) return bytes;

  // 中止时这条请求注定拿不到东西：别把“被中止”记成“取不到”（调用方会整篇作废）
  if (signal?.aborted) return undefined;
  log.warn('附件下载失败', { attGuid, tried: urls.length });
  return undefined;
}

/**
 * 问一次服务端这条附件的元数据，**只为拿到原始文件名**。
 *
 * ```
 * GET {kbServer}/ks/attachment/info/{kbGuid}/{docGuid}/{attGuid}?token=<token>
 * ```
 *
 * 实测（2026-10-04，xapp 0.1.107）：`200` + `{ result: { name: '<原始文件名>', … } }`。
 * 这个接口**要 token**（不带 → `returnCode: 301 Invalid token`）；attGuid 不存在时
 * `returnCode: 2004` 且 `result` 缺失 —— 所以**不能只看 HTTP 200，必须看 `returnCode`**。
 *
 * 只在“正文引用了附件、但本地 `attachments` 表里没有它的行”时才用得上：那种情况下
 * 这是唯一能还原文件名的途径，否则只能拿 attGuid 当名字 —— 一个没有扩展名的文件。
 */
export async function fetchNoteAttachmentName(
  note: NoteRef,
  attGuid: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const kbServer = await fetchKbServer(note.kbGuid);
  const token = await readAccountToken(note.kbGuid);
  if (!kbServer || !token) {
    log.debug('查不到服务器地址或令牌，拿不到附件名', { attGuid });
    return undefined;
  }

  const path =
    `/ks/attachment/info/${encodeURIComponent(note.kbGuid)}/${encodeURIComponent(note.docGuid)}` +
    `/${encodeURIComponent(attGuid)}`;

  try {
    const res = await pacedFetchWithRetry(`${kbServer}${path}?token=${encodeURIComponent(token)}`, signal);
    if (!res.ok) {
      log.debug('附件详情请求非 200', { attGuid, status: res.status });
      return undefined;
    }
    const payload = (await res.json()) as { returnCode?: number; result?: { name?: unknown } };
    if (typeof payload?.returnCode === 'number' && payload.returnCode !== 200) {
      log.debug('附件详情返回错误码', { attGuid, returnCode: payload.returnCode });
      return undefined;
    }
    const name = payload?.result?.name;
    return typeof name === 'string' && name ? name : undefined;
  } catch (error) {
    log.debug('附件详情请求异常', { attGuid, error });
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 评论（旧版笔记的“评论区”）                                         */
/* ------------------------------------------------------------------ */

/** 评论接口返回的单条记录（实测 2026-10-04，xapp 0.1.107） */
export interface RemoteComment {
  /** 自增序号，也是回复关系里的父指针 */
  sn?: number;
  /** 回复的是哪条评论；顶层为 null */
  parentSN?: number | null;
  userName?: string;
  created: number;
  /** 纯文本正文，可含换行 */
  body?: string;
}

export type RemoteCommentsResult =
  | { ok: true; comments: RemoteComment[] }
  | { ok: false; detail: string };

const accountTokenCache = new Map<string, string>();

/**
 * 账号记录里的访问令牌。
 *
 * 调评论接口必须带它。页面上没有别的来源 —— 实测协作笔记的 `doc.meta`
 * 只有 `version / updatedBy / ctime / mtime`，既没有 token 也没有 apiServer。
 */
async function readAccountToken(kbGuid: string): Promise<string | undefined> {
  const cached = accountTokenCache.get(kbGuid);
  if (cached) return cached;

  const db = await openDb('wiz-account');
  if (!db) return undefined;
  const hit = (await readAllRecords(db, 'accounts')).find((row) => row.kbGuid === kbGuid);
  const token = typeof hit?.token === 'string' && hit.token ? hit.token : undefined;
  if (token) accountTokenCache.set(kbGuid, token);
  return token;
}

/**
 * 取旧版笔记的评论（“评论区”）。
 *
 * 实测（2026-10-04，xapp 0.1.107）：旧版笔记的评论**不在笔记内容里** ——
 * `index.html` 里没有任何评论标记，`html2Doc` 出来的 `doc.comments` 恒为 0，
 * 只能走这个独立接口：
 *
 * ```
 * GET {kbServer}/ks/note/comments/{kbGuid}/{docGuid}?token=<token>
 * ```
 *
 * 返回 `{ result: [...] }`，没有评论时 `result` 为 `null`。
 * ⚠️ 这不适用于协作笔记：它们的评论在 doc JSON 里，这个接口对它们返回 0 条
 * （实测同一篇协作笔记 count 接口返回 0）。
 */
export async function fetchNoteComments(note: NoteRef, signal?: AbortSignal): Promise<RemoteCommentsResult> {
  const kbServer = await fetchKbServer(note.kbGuid);
  if (!kbServer) return { ok: false, detail: '没能查到知识库服务器地址，取不到评论' };

  const token = await readAccountToken(note.kbGuid);
  if (!token) return { ok: false, detail: '没能拿到访问令牌，取不到评论' };

  const path =
    `/ks/note/comments/${encodeURIComponent(note.kbGuid)}/${encodeURIComponent(note.docGuid)}` +
    `?token=${encodeURIComponent(token)}`;

  try {
    const res = await pacedFetchWithRetry(`${kbServer}${path}`, signal);
    if (!res.ok) return { ok: false, detail: `评论接口返回 ${res.status}` };

    const payload = (await res.json()) as {
      returnCode?: number;
      returnMessage?: string;
      result?: RemoteComment[] | null;
    };
    if (typeof payload.returnCode === 'number' && payload.returnCode !== 200) {
      return { ok: false, detail: `评论接口报错：${payload.returnMessage || payload.returnCode}` };
    }

    const list = Array.isArray(payload.result) ? payload.result : [];
    return {
      ok: true,
      comments: list.map((item) => ({
        ...item,
        created: typeof item.created === 'number' ? item.created : 0,
      })),
    };
  } catch (error) {
    // 被中止打断的请求不是“异常”：它是用户喊停的副作用，调用方会把整篇作废
    // （见 task.ts）。在这里报一条 warn 只会让中止时的控制台多一条误导性噪音。
    if (signal?.aborted) return { ok: false, detail: '已中止' };
    log.warn('取评论请求异常', note.docGuid, error);
    return { ok: false, detail: '取评论时请求失败' };
  }
}

/* ------------------------------------------------------------------ */
/* 标签路径解析                                                        */
/* ------------------------------------------------------------------ */

const tagPathCache = new Map<string, Map<string, string>>();

/**
 * guid → **完整路径**（`父/子/孙`，拍平规则见 tag-path.ts）。
 *
 * 笔记对象上的 `tags` 是 `guid1*guid2` 形式的 **guid 列表**，不是名字；
 * 而主库的 `tags` 表是**树**（每行带 `parentGuid`），只取 `name` 会把层级丢掉 ——
 * 带标签的笔记里多级标签很常见（占比见 docs/private.local/library-stats.md）。表很小，
 * 读一次按知识库缓存即可，批量导出几千篇不会重复读。
 */
export async function resolveTagPaths(kbGuid: string): Promise<Map<string, string>> {
  const cached = tagPathCache.get(kbGuid);
  if (cached) return cached;

  const rows: TagRow[] = [];
  for (const name of await accountDbNames()) {
    const db = await openDb(name);
    if (!db) continue;
    for (const row of await readAllRecords(db, 'tags')) {
      if (row.kbGuid !== kbGuid) continue;
      rows.push({ tagGuid: row.tagGuid, name: row.name, parentGuid: row.parentGuid });
    }
  }

  const paths = buildTagPaths(rows);
  log.debug('标签表已加载', { kbGuid, rows: rows.length, paths: paths.size });
  tagPathCache.set(kbGuid, paths);
  return paths;
}

/**
 * 从**本地 `docs` 行**取这篇笔记的标签原文（`guid1*guid2`），零网络。
 *
 * 为什么需要它（实测 2026-10-04）：从**列表**右键导出时，我们拿到的是列表接口给的 DTO，
 * 它上面的 `tags` 是**空串** —— 同一篇笔记的 `docs` 行里却明明有标签。只信笔记对象
 * 会让标签**静默消失**（front matter 里连 `tags` 键都不出现），所以调用方在对象上
 * 取不到时用这个兜底。
 */
export async function readNoteTags(note: NoteRef): Promise<string | undefined> {
  const range = IDBKeyRange.only([note.kbGuid, note.docGuid]);
  for (const name of await accountDbNames()) {
    const db = await openDb(name);
    if (!db) continue;
    const row = await readRecord<Record<string, unknown>>(db, 'docs', range);
    const tags = row?.tags;
    if (typeof tags === 'string' && tags.trim()) return tags;
  }
  log.debug('本地 docs 行里没有标签', { docGuid: note.docGuid });
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 笔记标题索引（内链 / 双链 → wikilink 用）                            */
/* ------------------------------------------------------------------ */

const noteTitleCache = new Map<string, Map<string, string>>();

/**
 * `docGuid`（小写）→ 这篇笔记**当前**的标题。
 *
 * 改写成 wikilink 时（正文里的笔记内链 `wiz://open_document?guid=…`、协作笔记的
 * 双链 `[[名称 id=guid]]`）**必须用目标笔记当前的名字**，不能用链接里自带的那份快照：
 * 实测（2026-10-12）抽查里就有快照已经和目标当前标题对不上的双链 ——
 * 目标改名之后，链接里存的 `name` 不会跟着变。而 wikilink 是按名字匹配的，
 * 名字错一个字符就是一条悬空链接。
 *
 * 数据就在本地主库的 `docs` 表里（主键 `[kbGuid, docGuid]`，行上有 `title`），
 * 零网络零猜测。与 `resolveTagPaths()` 同一套路：整表读一次、按知识库缓存 ——
 * 批量导出几千篇不会重复读（每篇笔记只在首次遇到链接时查一次）。
 *
 * 查不到（目标不在本地、或在别的知识库）时**返回的表里就没有这一项**，
 * 调用方据此退回链接自带的名字。
 */
export async function resolveNoteTitles(kbGuid: string): Promise<Map<string, string>> {
  const cached = noteTitleCache.get(kbGuid);
  if (cached) return cached;

  const titles = new Map<string, string>();
  for (const name of await accountDbNames()) {
    const db = await openDb(name);
    if (!db) continue;
    for (const row of await readAllRecords(db, 'docs')) {
      if (row.kbGuid !== kbGuid) continue;
      const docGuid = typeof row.docGuid === 'string' ? row.docGuid.toLowerCase() : '';
      const title = typeof row.title === 'string' ? row.title : '';
      if (docGuid && title) titles.set(docGuid, title);
    }
  }

  log.debug('笔记标题表已加载', { kbGuid, titles: titles.size });
  noteTitleCache.set(kbGuid, titles);
  return titles;
}

/* ------------------------------------------------------------------ */
/* 本地内容存在性检查                                                  */
/* ------------------------------------------------------------------ */

const IGNORED_DBS = new Set(['wiz-account', 'wiz-global', 'wiz-editor-db-store']);

let cachedAccountDbNames: string[] | undefined;

/**
 * 主库名是 `wiz-${accountKey}`，但 accountKey 拿不到，只能枚举。
 * 必须用 indexedDB.databases() 先确认真实存在的库，
 * 否则 indexedDB.open(name) 会以 version 1 建出一个空库。
 */
async function accountDbNames(): Promise<string[]> {
  if (cachedAccountDbNames) return cachedAccountDbNames;
  try {
    const databases = await indexedDB.databases();
    cachedAccountDbNames = databases
      .map((d) => d.name ?? '')
      .filter((name) => name.startsWith('wiz-') && !IGNORED_DBS.has(name));
  } catch (error) {
    log.warn('枚举 IndexedDB 失败', error);
    cachedAccountDbNames = [];
  }
  return cachedAccountDbNames;
}

/** 连接缓存：导出前要逐篇查本地是否存在，每篇开关一次连接会明显变慢 */
const dbCache = new Map<string, Promise<IDBDatabase | undefined>>();

function openDb(name: string): Promise<IDBDatabase | undefined> {
  const cached = dbCache.get(name);
  if (cached) return cached;

  const opening = new Promise<IDBDatabase | undefined>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name);
    } catch {
      resolve(undefined);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });

  dbCache.set(name, opening);
  return opening;
}

function countInStore(db: IDBDatabase, store: string, range: IDBKeyRange): Promise<number> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve(0);
      return;
    }
    try {
      const request = db.transaction(store, 'readonly').objectStore(store).count(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

/**
 * 判断笔记内容是否已经在本地。
 * 返回 'yes' / 'no' / 'unknown'，unknown 表示判断不出来（调用方需自行决定策略）。
 */
export async function isNoteStoredLocally(
  kbGuid: string,
  docGuid: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const names = await accountDbNames();
  if (names.length === 0) return 'unknown';

  const range = IDBKeyRange.only([kbGuid, docGuid]);
  let checked = false;
  for (const name of names) {
    const db = await openDb(name);
    if (!db) continue;
    checked = true;
    const inDocs = await countInStore(db, 'docs', range);
    const inData = inDocs > 0 ? 1 : await countInStore(db, 'data', range);
    if (inDocs > 0 || inData > 0) return 'yes';
  }
  return checked ? 'no' : 'unknown';
}

/**
 * 本地“虚拟域”数据服务是否已就绪。
 *
 * `//wiznote-desktop/**` 由 **Service Worker 的 fetch 事件**接管（见 site-internals §2）。
 * SW 没接管当前页面时（硬刷新之后的瞬间、或 SW 正在更新），所有这些请求都会
 * `Failed to fetch` —— 现象是“笔记取不到正文”，但原因在环境而不在笔记。
 *
 * 实测（2026-10-04）：`navigator.serviceWorker.controller` 为 `null` 时，连本地已缓存的
 * 笔记（Cache Storage 里就有 `index.html`）也会全部失败；刷新一次页面就恢复正常。
 * 所以调用方在报错时可以靠它给出“刷新一次”的提示，而不是让用户以为笔记没同步。
 */
export function isLocalDataServiceReady(): boolean {
  try {
    return Boolean(navigator.serviceWorker?.controller);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 保存文件                                                            */
/* ------------------------------------------------------------------ */

/** 与应用里 requestSaveFile 完全一致的下载方式，不依赖任何桌面 API */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (document.body ?? document.documentElement).appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function textToBlob(text: string, type = 'text/markdown;charset=utf-8'): Blob {
  return new Blob([text], { type });
}
