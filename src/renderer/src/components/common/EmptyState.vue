<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';

/**
 * 空状态：图标 + 一句话 + 可选说明 + 一个动作。
 *
 * 音乐库的几栏（收藏 / 歌单 / 历史 / 平台歌单）空的时候长得一样，
 * 抽出来免得每处各写一份，改文案时也只改一处。
 */
withDefaults(defineProps<{ icon?: string; title: string; description?: string }>(), {
  icon: 'music',
  description: '',
});
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon">
      <AppIcon :name="icon" :size="22" :stroke-width="1.5" />
    </span>
    <strong>{{ title }}</strong>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.default" class="empty-actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 56px 20px;
  text-align: center;
}

.empty-icon {
  display: grid;
  width: 54px;
  height: 54px;
  margin-bottom: 14px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-faint);
}

.empty-state strong {
  font-size: 14px;
  font-weight: 700;
}

.empty-state p {
  max-width: 400px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}

.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
