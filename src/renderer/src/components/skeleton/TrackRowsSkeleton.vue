<script setup lang="ts">
/**
 * 曲目列表骨架，列宽与 TrackList 的行完全一致（序号 / 封面 / 歌名 / 专辑 / 平台 / 时长），
 * 这样加载完成时不会跳版。`head` 用来补上列表标题栏。
 */
withDefaults(defineProps<{ rows?: number; cover?: boolean; head?: boolean }>(), {
  rows: 8,
  cover: true,
  head: false,
});
</script>

<template>
  <div class="rows" aria-hidden="true">
    <div v-if="head" class="head">
      <span class="sk line head-label" />
      <span class="sk head-pill" />
    </div>

    <div v-for="index in rows" :key="index" class="row" :class="{ 'no-cover': !cover }">
      <span class="sk line index" />
      <span v-if="cover" class="sk cover" />
      <div class="cell">
        <span class="sk line title" />
        <span class="sk line sub" />
      </div>
      <span class="sk line album" />
      <span class="sk line platform" />
      <span class="sk line time" />
    </div>
  </div>
</template>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 4px;
}

.head-label {
  width: 96px;
  height: 9px;
}

.head-pill {
  width: 84px;
  height: 24px;
  border-radius: 999px;
}

.row {
  display: grid;
  grid-template-columns: 26px 40px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 112px) 42px;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
}

.row.no-cover {
  grid-template-columns: 26px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 112px) 42px;
}

.line {
  display: block;
  height: 8px;
}

.index {
  width: 12px;
  height: 8px;
  justify-self: center;
}

.cover {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-xs, 6px);
}

.cell {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.title {
  width: 46%;
  max-width: 220px;
  height: 10px;
}

.sub {
  width: 26%;
  max-width: 120px;
  height: 7px;
}

.album {
  width: 62%;
  height: 8px;
}

.platform {
  width: 44%;
  height: 8px;
}

.time {
  width: 26px;
  height: 8px;
  justify-self: end;
}

@media (max-width: 1080px) {
  .row {
    grid-template-columns: 24px 40px minmax(0, 1fr) auto 42px;
  }

  .row.no-cover {
    grid-template-columns: 24px minmax(0, 1fr) auto 42px;
  }

  .album {
    display: none;
  }

  .platform {
    width: 64px;
  }
}
</style>
