<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';

/**
 * 全屏播放页统一的曲目封面。
 * 有封面图时显示图，没有时回退到音符图标。
 */
withDefaults(
  defineProps<{
    cover: string;
    title: string;
    /** 回退图标尺寸。 */
    iconSize?: number;
    iconStrokeWidth?: number;
  }>(),
  { iconSize: 16, iconStrokeWidth: 1.4 },
);
</script>

<template>
  <img v-if="cover" :src="cover" :alt="title" />
  <AppIcon v-else name="music" :size="iconSize" :stroke-width="iconStrokeWidth" />
</template>
