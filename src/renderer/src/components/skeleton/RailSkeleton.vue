<script setup lang="ts">
/** 首页横向轨道骨架：板块标题 + 一排固定宽度的卡片。 */
withDefaults(defineProps<{ cards?: number }>(), { cards: 6 });
</script>

<template>
  <div class="rail" aria-hidden="true">
    <div class="head">
      <span class="sk line section" />
      <span class="sk line action" />
    </div>
    <div class="cards">
      <div v-for="index in cards" :key="index" class="card">
        <span class="sk cover" />
        <span class="sk line title" />
        <span class="sk line sub" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 4px 10px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.line {
  display: block;
}

.section {
  width: 108px;
  height: 14px;
}

.action {
  width: 62px;
  height: 9px;
}

.cards {
  display: flex;
  gap: 14px;
  overflow: hidden;
}

.card {
  display: flex;
  flex: 0 0 168px;
  flex-direction: column;
  gap: 8px;
}

.cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
}

.title {
  width: 84%;
  height: 10px;
}

.sub {
  width: 46%;
  height: 7px;
}
</style>
