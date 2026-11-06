import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import LyricWindow from './lyric/LyricWindow.vue';
import NowPlayingWindow from './nowPlaying/NowPlayingWindow.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/index.css';

// 桌面歌词窗口用同一个入口：`?window=lyric` 时只挂歌词视图，不加载整个应用。
if (new URLSearchParams(window.location.search).get('window') === 'lyric') {
  createApp(LyricWindow).mount('#app');
} else if (new URLSearchParams(window.location.search).get('window') === 'nowplaying') {
  // 弹出式播放窗口：只挂播放页样式，但壳层组件（RouterLink/样式菜单）用到
  // 路由与 store，所以 pinia / router 照常装上。
  const pinia = createPinia();
  useThemeStore(pinia).init();

  const app = createApp(NowPlayingWindow);
  app.use(pinia);
  app.use(router);
  app.mount('#app');
} else {
  const pinia = createPinia();

  // 主题必须在挂载前写到 <html> 上，否则首帧会闪一下默认配色。
  useThemeStore(pinia).init();

  const app = createApp(App);
  app.use(pinia);
  app.use(router);
  app.mount('#app');
}
