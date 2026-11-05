<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';

/**
 * 错误状态：和 EmptyState 同一套视觉，只是图标、文案和动作不同。
 * 单独拆出来，页面才不会把「加载中」和「加载失败」塞进同一个组件。
 */
withDefaults(
  defineProps<{
    message: string;
    icon?: string;
    retryLabel?: string;
    busy?: boolean;
  }>(),
  { icon: 'alert', retryLabel: '重试', busy: false },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="error-state">
    <span class="error-icon">
      <AppIcon :name="icon" :size="20" :stroke-width="1.6" />
    </span>
    <strong>加载失败</strong>
    <p>{{ message }}</p>
    <button type="button" class="retry" :disabled="busy" @click="$emit('retry')">
      <AppIcon name="refresh" :size="12" :class="{ spin: busy }" />
      {{ retryLabel }}
    </button>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 20px;
  text-align: center;
}

.error-icon {
  display: grid;
  width: 50px;
  height: 50px;
  margin-bottom: 13px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--border));
  border-radius: 50%;
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  color: var(--danger);
}

.error-state strong {
  font-size: 14px;
  font-weight: 700;
}

.error-state p {
  max-width: 400px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}

.retry {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 5px;
  margin-top: 16px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}

.retry:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.retry:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
