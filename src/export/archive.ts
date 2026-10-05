import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { invariant } from '../utils/invariant';
import { createYielder } from '../utils/yield';
import type { ArchiveEntry } from './types';

/** Uint8Array → ArrayBuffer，规避 BlobPart 的类型摩擦 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function bytesToBlob(data: Uint8Array, type: string): Blob {
  return new Blob([toArrayBuffer(data)], { type });
}

/** 未预压缩内容的 deflate 档位；改它等于改产物体积与打包耗时 */
const ZIP_LEVEL = 6;

/**
 * **本身已经压过**的格式：再 deflate 一遍几乎压不小，只是白烧 CPU。
 *
 * 为什么值得单独列：几百篇笔记的字节大头就是这些图片与附件，而打包是同步 CPU 活 ——
 * 中止或收尾时用户等的那几秒，多半就花在给 PNG/PDF 做无用功上。fflate 的 README
 * 也是这个建议（“zip 里放 PNG/JPEG/PDF 就该按文件覆盖压缩级别”）。
 */
const STORED_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  // 压缩包
  'zip', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2',
  // 文档（都是 zip 容器或已压缩）
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
  // 音视频
  'mp3', 'mp4', 'm4a', 'mov', 'webm', 'ogg', 'opus', 'flac', 'aac',
  // 字体
  'woff', 'woff2',
]);

/** 路径按扩展名判断是否跳过 deflate */
function isStored(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return STORED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface ZipProgress {
  /** 已写进 zip 的文件数 */
  done: number;
  total: number;
}

export interface BuildZipHooks {
  /** 进度回调（按百分比节流，不会每个文件都报） */
  onProgress?: (progress: ZipProgress) => void;
}

/**
 * 打包成 zip。
 *
 * 走 **fflate 的流式接口而不是 `zipSync`**，只为了一件事：能**边打边让出主线程**。
 * `zipSync` 是一个不可中断的同步大循环 —— 几百篇（尤其带图片）时它会独占主线程好几秒，
 * 界面完全冻住、连“正在打包”都画不出来；流式接口下每写完一个文件我们就有机会
 * 报一次进度、让出一帧，用户看得见它在动。
 *
 * 已经压过的格式直接存储（`ZipPassThrough`），其余走 deflate —— 见 `STORED_EXTENSIONS`。
 */
export async function buildZip(entries: ArchiveEntry[], hooks: BuildZipHooks = {}): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((error, chunk) => {
    if (error) {
      // 这个回调是 fflate 在 add() / push() 内部调的，在这里抛出去会穿进它的状态机里，
      // 更难收拾。先记下来，等循环结束再统一抛（见下面的 invariant）。
      failure ??= error;
      return;
    }
    chunks.push(chunk);
  });

  const paths = new Set<string>();
  // 到点才让出（见 utils/yield.ts）：打包是几百上千个文件的循环，这里每 ~16ms 停一帧
  const breathe = createYielder();
  let lastPercent = -1;

  for (const [index, entry] of entries.entries()) {
    // zip 内路径唯一性由 naming.ts 保证（archive 级分配器 + 每篇目录级分配器）。
    // 这里还能撞上，就说明分配逻辑有 bug —— 按统一姿势处理：dev 抛错、生产记 error。
    // 生产环境仍然照旧写入（后者覆盖前者），不为了一个“不该发生”的 bug 作废整份导出。
    invariant(!paths.has(entry.path), 'zip 内出现重复路径', { path: entry.path });
    paths.add(entry.path);

    /*
     * ⚠️ stored 这条是**引用转发**，不是复制：`ZipPassThrough.process()` 把 `entry.data`
     * 这块内存原样交给 sink，`Zip` 又原样推进 `chunks`。也就是说图片 / 附件的字节
     * 从 `entries` 到输出分片始终只有**一份**（两个引用），一直活到 `new Blob()` 把它
     * 交给 blob storage 为止。
     *
     * 由此得到两条别搞反的结论（详见 docs/export-pipeline.md §1.9）：
     *   - 渲染进程峰值 ≈ 原始字节之和，不是“原始 + zip”两份；
     *   - 想省内存，“边导边写、随即释放”是没用的（省掉的只有走 deflate 的正文），
     *     只有把**输出**写进磁盘（OPFS / 保存位置句柄）才能真正降下来。
     */
    const file = isStored(entry.path)
      ? new ZipPassThrough(entry.path)
      : new ZipDeflate(entry.path, { level: ZIP_LEVEL });
    zip.add(file);
    file.push(entry.data, true);

    if (failure) break;

    const done = index + 1;
    // 按百分比节流上报：几百个文件逐个报会让视图每一帧都把整张笔记列表重排一遍
    const percent = Math.floor((done / entries.length) * 100);
    if (percent !== lastPercent || done === entries.length) {
      lastPercent = percent;
      hooks.onProgress?.({ done, total: entries.length });
    }

    /*
     * 按**时间**让出，不是按文件数：单个大文件（比如一个几十 MB 的附件）本身就能压很久。
     *
     * ⚠️ 让出粒度止步于“一个文件” —— `file.push()` 是一整块同步活（CRC + deflate）。
     * 真要连这一块也切碎，fflate 支持分次 push（`push(slice, false)` … `push(rest, true)`），
     * 但那要等真的出现“单个超大附件把界面顶住”再说（见 §十二 TODO）。
     */
    await breathe();
  }

  if (failure) {
    // 没有可用的产出，两种环境都只能往上抛（dev 抛错、生产最多记一条 error）
    invariant(false, '打包 zip 失败', { error: failure });
    throw failure;
  }

  zip.end();
  /*
   * 直接把分片数组交给 Blob，**不要**先 `concat` 或 `map(toArrayBuffer)`：
   * 那两种写法都会在渲染进程里再抄一份完整的 zip（每片 `slice()` 一遍 —— 几百 MB 的
   * 导出里就是几百 MB）。交给 Blob 之后字节就归 blob storage 了，不再占我们的内存。
   * `BlobPart[]` 允许 `Uint8Array`，所以这里只需要过一个 lib.dom 的类型关
   * （它要求 `ArrayBufferView<ArrayBuffer>`，而 fflate 给我们的是 `Uint8Array<ArrayBufferLike>`）。
   */
  return new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' });
}

export function mimeOf(filename: string): string {
  if (filename.endsWith('.md')) return 'text/markdown;charset=utf-8';
  if (filename.endsWith('.html')) return 'text/html;charset=utf-8';
  if (filename.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}
