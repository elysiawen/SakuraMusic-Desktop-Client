<script setup lang="ts">
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
</script>

<template>
  <component :is="nowPlayingModeDef(ui.nowPlayingMode).component" />
</template>
