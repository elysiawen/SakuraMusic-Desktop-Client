<script setup lang="ts">
import { computed } from 'vue';
import { nowPlayingModeDef } from '@/components/nowPlaying/nowPlayingModes';
import { useUiStore } from '@/stores/ui';
import { initNowPlayingRemote } from './remote';

/**
 * 弹出式播放窗口的根组件。
 *
 * 只挂当前播放页样式（和主窗口覆盖层里是同一套组件），壳层（导航栏 /
 * 播放条）不进来；状态与控制全靠 `remote.ts` 的镜像桥。
 */
const ui = useUiStore();
initNowPlayingRemote();

/** 夜色场景的样式（雾笺/绘光/沉浸）：窗口底色也用深色，首帧前不闪白 */
const stageDark = computed(() => nowPlayingModeDef(ui.nowPlayingMode).stageTone === 'dark');

/**
 * 弹出窗口里的歌手/专辑链接：本窗口没有详情页，也不该因此关掉自己。
 * 在捕获阶段截下站内路由链接，原样交给主窗口（主进程会把它叫出来并导航）。
 * 封面按钮、Esc、收起按钮不是 `a[href^="#/"]`，照旧走 closeLyrics 关窗。
 */
function onRootClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const link = target?.closest<HTMLAnchorElement>('a[href^="#/"]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.sakura.nowPlaying.sendCommand({ type: 'navigate', path: href.slice(1) });
}
</script>

<template>
  <div class="npwin" :class="{ 'npwin--dark': stageDark }" @click.capture="onRootClick">
    <Transition name="mode-switch">
      <div :key="ui.nowPlayingMode" class="npwin-item">
        <component :is="nowPlayingModeDef(ui.nowPlayingMode).component" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 窗口底色：页面首帧渲染出来之前也不会闪一格白 */
.npwin {
  position: fixed;
  inset: 0;
  background: var(--bg);
}

.npwin--dark {
  background: #05070a;
}

/* 切换样式时两个覆盖层交叉淡化，和主窗口里的播放页保持一致 */
.npwin-item {
  position: absolute;
  inset: 0;
}

.mode-switch-enter-active {
  transition: opacity 0.32s ease;
}

.mode-switch-leave-active {
  transition: opacity 0.22s ease;
}

.mode-switch-enter-from,
.mode-switch-leave-to {
  opacity: 0;
}
</style>
