<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';

/**
 * 通用确认弹窗，交互和 web 端 ConfirmHost 对齐：
 * Esc / 点遮罩取消、打开后焦点落在确认按钮（回车即确认）、危险操作用红色按钮。
 * 组件只负责问，做什么由使用方在 @confirm 里决定。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmLabel: '确定', cancelLabel: '取消' },
);
const emit = defineEmits<{ (event: 'confirm'): void; (event: 'close'): void }>();

const confirmButton = ref<HTMLButtonElement | null>(null);

function close(): void {
  if (props.busy) return;
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.visible) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }

  if (event.key === 'Enter') {
    // 弹窗里没有输入框，但别把别处正在编辑的文本域回车吞掉。
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
    event.preventDefault();
    if (!props.busy) emit('confirm');
  }
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    await nextTick();
    confirmButton.value?.focus();
  },
);

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay" @click.self="close">
      <div class="dialog glass-strong" role="alertdialog" aria-modal="true" :aria-label="title">
        <header class="dialog-head">
          <div>
            <p class="eyebrow">请确认</p>
            <h2>{{ title }}</h2>
          </div>
          <button type="button" class="btn-icon" aria-label="取消" @click="close">
            <AppIcon name="close" :size="15" />
          </button>
        </header>

        <p v-if="message" class="message">{{ message }}</p>

        <div class="actions">
          <button type="button" class="btn-cancel" :disabled="busy" @click="close">
            {{ cancelLabel }}
          </button>
          <button
            ref="confirmButton"
            type="button"
            class="btn-confirm"
            :class="{ danger }"
            :disabled="busy"
            @click="emit('confirm')"
          >
            {{ busy ? '处理中…' : confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(6px);
}

.dialog {
  display: flex;
  width: min(420px, 100%);
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border-radius: var(--radius-xl);
  animation: fade-up var(--dur) var(--ease);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dialog-head .eyebrow {
  margin: 0 0 2px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.dialog-head h2 {
  font-size: 17px;
  font-weight: 700;
}

.message {
  margin: 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.7;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.btn-cancel,
.btn-confirm {
  height: 32px;
  padding: 0 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    filter var(--dur) var(--ease);
}

.btn-cancel {
  color: var(--text-muted);
}

.btn-cancel:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.btn-confirm {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.btn-confirm.danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}

.btn-confirm:hover:not(:disabled) {
  filter: brightness(1.06);
}

.btn-cancel:disabled,
.btn-confirm:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
