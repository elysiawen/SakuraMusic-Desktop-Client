import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * 主进程/预加载走 Vite 打包，渲染进程单独一套。
 *
 * dev / release 的页面都从 `sakura://app` 加载：dev 时协议层把静态请求转发给
 * Vite dev server，release 时直接读 out/renderer。API / 媒体 / SSE 一律由协议层
 * 转发给进程内 BFF，所以 Vite 不需要配置代理。
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
