<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';

withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string;
    text?: string;
  }>(),
  { loading: false, error: '', text: '正在加载…' },
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading || error" class="page-state">
    <template v-if="loading">
      <span class="spinner" />
      <p>{{ text }}</p>
    </template>

    <template v-else-if="error">
      <span class="state-icon">
        <AppIcon name="alert" :size="22" :stroke-width="1.5" />
      </span>
      <p class="error-text">{{ error }}</p>
      <button type="button" class="retry" @click="emit('retry')">
        <AppIcon name="refresh" :size="13" />
        重试
      </button>
    </template>
  </div>
</template>

<style scoped>
.page-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 72px 20px;
  text-align: center;
}

.page-state p {
  max-width: 380px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.spinner {
  width: 26px;
  height: 26px;
  margin-bottom: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

.state-icon {
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

.error-text {
  color: #e0453a;
}

.retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  margin-top: 14px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.retry:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
