import { createStore } from './utils/store';

/** 全局配置，改动会持久化到油猴存储中 */
export const store = createStore({
  debug: false,
  /** 用脚本内置的 MathJax 渲染公式，修复离线看不到公式的问题，改动后需刷新页面 */
  offlineMathJax: true,
  /** 导出时把图片下载到 zip 的 images/ 目录 */
  exportIncludeImages: true,
  /** 导出时把附件（PDF / Office 文档等）下载到 zip 的 attachments/ 目录 */
  exportIncludeAttachments: true,
  /** 导出时把笔记评论追加到 Markdown 正文末尾（不标注位置） */
  exportKeepComments: true,
  /** 允许联网补全本地没有内容的笔记 */
  exportAllowNetworkFetch: true,
  /** 导出笔记元数据（创建/修改时间、分类、标签、来源链接 等） */
  exportMetadata: true,
  /** 元数据形态：写进正文的 YAML front matter，还是同名 .meta.json */
  exportMetadataFormat: 'yaml' as 'yaml' | 'json',
  /** 元数据里附带 WizNote 原始字段（docGuid / 原始 type 等，供排查） */
  exportMetadataRaw: false,
  /** 同时导出原始 HTML，作为有损转换的保真备份 */
  exportHtml: false,
  /**
   * 悬浮任务条的位置（距视口右边 / 下边的像素）。
   *
   * 记下来是因为**拖它的理由**通常很具体：右下角正好压着为知的某个控件。
   * 只在这个会话里生效的话，用户每次都得重拖一遍。`null` = 用默认的右下角。
   */
  exportBarPos: null as { right: number; bottom: number } | null,
});

export type AppStore = typeof store;
