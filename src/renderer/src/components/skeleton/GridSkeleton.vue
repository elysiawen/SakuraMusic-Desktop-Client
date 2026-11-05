<script setup lang="ts">
/**
 * 卡片网格骨架：正方形封面 + 两行文字。
 * `round` 用于歌手头像，`pad` 对齐带内边距的卡片（搜索页的卡片是 10px）。
 */
withDefaults(defineProps<{ count?: number; min?: number; round?: boolean; pad?: number }>(), {
  count: 8,
  min: 136,
  round: false,
  pad: 0,
});
</script>

<template>
  <div class="grid" :style="{ '--min': `${min}px` }" aria-hidden="true">
    <div
      v-for="index in count"
      :key="index"
      class="tile"
      :style="pad > 0 ? { padding: `${pad}px`, gap: '5px' } : undefined"
    >
      <span class="sk cover" :class="{ round }" />
      <span class="sk line title" />
      <span class="sk line sub" />
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
  gap: 14px;
  padding: 2px 4px;
}

.tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--radius-lg);
}

.cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
}

.cover.round {
  border-radius: 50%;
}

.title {
  width: 82%;
  height: 10px;
}

.sub {
  width: 44%;
  height: 7px;
}
</style>
