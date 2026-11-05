import { onScopeDispose, ref, watch, type Ref } from 'vue';

/**
 * 骨架屏延迟显示。
 *
 * 接口几十毫秒就回来时（多数请求都走了磁盘缓存），直接闪一下骨架反而更晃眼；
 * 等 `delay` 毫秒还没加载完再显示，快请求就完全没有加载画面。
 */
export function useDelayedLoading(source: Ref<boolean>, delay = 140): Ref<boolean> {
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  watch(
    source,
    (loading) => {
      stop();
      if (!loading) {
        visible.value = false;
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        visible.value = source.value;
      }, delay);
    },
    { immediate: true },
  );

  onScopeDispose(stop);
  return visible;
}
