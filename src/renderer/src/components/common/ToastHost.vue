<script setup lang="ts">
import { useToast } from '@/composables/useToast';
import AppIcon from './AppIcon.vue';

const toast = useToast();
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-host">
    <div v-for="item in toast.items.value" :key="item.id" class="toast" :class="`is-${item.kind}`">
      <AppIcon
        :name="item.kind === 'success' ? 'check' : item.kind === 'error' ? 'alert' : 'sparkles'"
        :size="16"
      />
      <span class="toast-message">{{ item.message }}</span>
      <button class="toast-close" type="button" aria-label="关闭提示" @click="toast.dismiss(item.id)">
        <AppIcon name="close" :size="13" />
      </button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 22px;
  bottom: calc(var(--player-h) + 22px);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  padding: 11px 12px 11px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-strong);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(20px);
  pointer-events: auto;
}

.toast.is-success :deep(svg) {
  color: var(--success);
}

.toast.is-error :deep(svg) {
  color: var(--danger);
}

.toast.is-info :deep(svg) {
  color: var(--accent);
}

.toast-message {
  flex: 1;
  font-size: 13px;
  line-height: 1.45;
}

.toast-close {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
}

.toast-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
