import { ref } from 'vue';
import { defineStore } from 'pinia';
import { musicApi } from '@/api';
import type { DiscoverFeed } from '@/api/types';
import { usePreferencesStore } from '@/stores/preferences';

/**
 * 主页推荐流的会话级缓存。
 *
 * 主页每次进出都挂在 `onMounted` 里重新拉推荐，返回时整页重载、闪一遍骨架。
 * 推荐内容本身不追求实时，所以改成：本次应用生命周期内只拉一次，
 * 想看新的就点主页右上角的「刷新」（force）。
 */
export const useHomeStore = defineStore('home', () => {
  const feed = ref<DiscoverFeed | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 是否已经成功拉到过一次（拉过就不再自动重拉）。 */
  const loaded = ref(false);
  /** 进行中的请求去重：快速来回进出页面时不重复发。 */
  let inflight: Promise<void> | null = null;

  async function load(force = false): Promise<void> {
    if (inflight) return inflight;
    if (loaded.value && !force) return;

    const run = (async () => {
      loading.value = true;
      error.value = '';
      try {
        const preferences = usePreferencesStore();
        await preferences.ensureInitialized();
        feed.value = await musicApi.discoverFeed(preferences.enabledParam('discover'));
        loaded.value = true;
      } catch (caught) {
        feed.value = null;
        error.value = caught instanceof Error ? caught.message : '加载推荐失败';
      } finally {
        loading.value = false;
        inflight = null;
      }
    })();

    inflight = run;
    return run;
  }

  return { feed, loading, error, loaded, load };
});
