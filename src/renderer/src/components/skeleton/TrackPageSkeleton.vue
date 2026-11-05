<script setup lang="ts">
import TrackRowsSkeleton from '@/components/skeleton/TrackRowsSkeleton.vue';

/** 详情页骨架：左侧封面 + 右侧信息（标题 / 副标题 / 按钮），下面复用曲目行骨架。 */
withDefaults(defineProps<{ rows?: number; cover?: number }>(), {
  rows: 8,
  cover: 132,
});
</script>

<template>
  <div class="page" aria-hidden="true">
    <div class="hero">
      <span class="sk cover" :style="{ width: `${cover}px`, height: `${cover}px` }" />
      <div class="info">
        <span class="sk line eyebrow" />
        <span class="sk line title" />
        <span class="sk line meta" />
        <div class="actions">
          <span class="sk pill" />
          <span class="sk pill ghost" />
        </div>
      </div>
    </div>

    <TrackRowsSkeleton :rows="rows" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
}

.cover {
  flex: none;
  border-radius: var(--radius-lg);
}

.info {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 10px;
}

.line {
  display: block;
  height: 10px;
}

.eyebrow {
  width: 64px;
  height: 7px;
}

.title {
  width: min(42%, 300px);
  height: 20px;
}

.meta {
  width: 28%;
  max-width: 190px;
  height: 8px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.pill {
  width: 96px;
  height: 30px;
  border-radius: 999px;
}

.ghost {
  width: 78px;
}
</style>
