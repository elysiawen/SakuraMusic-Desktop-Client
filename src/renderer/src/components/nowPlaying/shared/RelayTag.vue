<script setup lang="ts">
import { usePlayerStore } from '@/stores/player';

/**
 * 全屏播放页统一的「缓存 / 直连 / 中转」标签。
 * 优先级：缓存 > 直连 > 中转。
 */
const player = usePlayerStore();
</script>

<template>
  <span v-if="player.audioCache === 'full'" class="tag cache">缓存</span>
  <span v-else-if="player.usingDirect" class="tag direct">直连</span>
  <span v-else-if="!player.loading && player.current" class="tag relay">中转</span>
</template>
