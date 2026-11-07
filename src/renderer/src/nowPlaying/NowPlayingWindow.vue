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
</script>

<template>
  <div class="npwin" :class="{ 'npwin--dark': stageDark }">
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
