import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * 主进程/预加载走 Vite 打包，渲染进程单独一套。
 *
 * 开发时渲染进程由 Vite 提供（:5173），`/api` 代理到主进程里的本地 BFF（:3210）。
 * 生产时主进程 BFF 同时托管 `out/renderer` 与 `/api`，渲染进程只访问同源地址。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [vue()],
    server: {
      port: 5173,
      strictPort: true,
      // 页面走 sakura://app，API 由主进程协议层转发到 BFF，Vite 不再做代理。
      // HMR 必须显式给地址：client 的 import.meta.url 是 sakura://app，
      // 靠它推不出 WebSocket 该连哪里。
      hmr: { host: 'localhost', port: 5173, protocol: 'ws' },
    },
  },
});
