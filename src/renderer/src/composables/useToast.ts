import { ref } from 'vue';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const items = ref<ToastItem[]>([]);
const timers = new Map<number, number>();
let sequence = 0;

function dismiss(id: number): void {
  items.value = items.value.filter((item) => item.id !== id);
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
}

function push(kind: ToastKind, message: string, duration = 3200): number {
  const id = ++sequence;
  items.value = [...items.value, { id, kind, message }];
  timers.set(id, window.setTimeout(() => dismiss(id), duration));
  return id;
}

/** 全局轻提示；由 App.vue 里的 ToastHost 统一渲染。 */
export function useToast() {
  return {
    items,
    dismiss,
    info: (message: string, duration?: number) => push('info', message, duration),
    success: (message: string, duration?: number) => push('success', message, duration),
    error: (message: string, duration?: number) => push('error', message, duration),
  };
}
