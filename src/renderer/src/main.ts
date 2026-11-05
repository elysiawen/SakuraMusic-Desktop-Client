import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/index.css';

const pinia = createPinia();

// 主题必须在挂载前写到 <html> 上，否则首帧会闪一下默认配色。
useThemeStore(pinia).init();

const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount('#app');
