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
      proxy: {
        // 页面、API、音频与离线库在开发时也要同源：这些都转发给主进程里的 BFF。
        '/api': {
          target: 'http://127.0.0.1:3210',
          changeOrigin: false,
        },
        '/media': {
          target: 'http://127.0.0.1:3210',
          changeOrigin: false,
        },
        '/offline': {
          target: 'http://127.0.0.1:3210',
          changeOrigin: false,
        },
        '/connect': {
          target: 'http://127.0.0.1:3210',
          changeOrigin: false,
        },
      },
    },
  },
});
