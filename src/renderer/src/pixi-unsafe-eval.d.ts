/*
 * pixi.js 的 `./unsafe-eval` 子路径在 exports 里只指向 `lib/unsafe-eval/init.mjs`，
 * 包内没有可被 TS 解析的声明文件（只有一份 `init.d.ts`，不跟 .mjs 后缀配对）。
 * 这里补上声明：它只是个副作用模块，没有导出值，导入只为安装不依赖 eval 的实现。
 */
declare module 'pixi.js/unsafe-eval';
