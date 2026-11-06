/// <reference types="vite/client" />

import type { DesktopApi } from '@shared/ipc';

/*
 * `*.vue` 模块声明：vue-tsc 认识 .vue 文件用不着它，但 IDE 的内置 TS 服务
 * （没挂 Vue 语言插件时）按普通 tsc 解析，.vue 导入会报「找不到模块」。
 * 真实文件的解析优先级高于这条通配声明，不影响 vue-tsc 的类型检查。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare global {
  interface Window {
    sakura: DesktopApi;
  }
}

export {};
