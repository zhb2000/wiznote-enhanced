/// <reference types="vite/client" />
/// <reference types="vite-plugin-monkey/global" />

/** 构建时由 vite.config.ts 的 define 注入，唯一来源是 package.json 的 version */
declare const __APP_VERSION__: string;

/** 构建时由 vite.config.ts 的 define 注入，唯一来源是 vite.config.ts 顶部的 REPO（`owner/repo`） */
declare const __APP_REPO__: string;
