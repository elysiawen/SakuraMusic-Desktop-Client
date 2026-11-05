<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { useLibraryStore } from '@/stores/library';

/**
 * 「最近播放」独立页：冷色 hero + 倒序曲目列表。
 * 记录没有精确时间戳，所以不做日期分组，只保证最新在最上面。
 */
const library = useLibraryStore();
const transport = useTransport();
const toast = useToast();

const loading = ref(false);
const error = ref('');
const clearOpen = ref(false);
const clearing = ref(false);

const count = computed(() => library.history.length);

onMounted(() => void load());

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await library.loadHistory();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载播放记录失败';
  } finally {
    loading.value = false;
  }
}

function playAll(): void {
  if (count.value === 0) return;
  transport.playList(library.history);
}

async function clearHistory(): Promise<void> {
  clearing.value = true;
  try {
    await library.clearHistory();
    toast.success('播放记录已清空');
    clearOpen.value = false;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '清空失败');
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="history-view">
    <header class="hero">
      <span class="hero-icon"><AppIcon name="clock" :size="24" :stroke-width="1.8" /></span>
      <div class="hero-copy">
        <p class="eyebrow">我的音乐</p>
        <h1>最近播放</h1>
        <p class="hero-sub">共 {{ count }} 首 · 最新的排在最前面</p>
      </div>

      <div class="hero-actions">
        <button type="button" class="hero-play" :disabled="count === 0" @click="playAll">
          <AppIcon name="play" :size="13" />
          播放全部
        </button>
        <button
          type="button"
          class="hero-clear"
          :disabled="count === 0 || clearing"
          @click="clearOpen = true"
        >
          清空记录
        </button>
      </div>
    </header>

    <PageState :loading="loading" :error="error" text="正在读取播放记录…" @retry="load" />

    <TrackList
      v-if="!loading && !error"
      :tracks="library.history"
      :show-head="false"
      empty-text="还没有播放记录。随便放一首歌，它就会留在这里。"
    />

    <ConfirmDialog
      :visible="clearOpen"
      title="清空播放记录"
      message="最近播放的曲目会被全部移除，这不会影响你的收藏。"
      confirm-label="清空"
      danger
      :busy="clearing"
      @confirm="clearHistory"
      @close="clearOpen = false"
    />
  </div>
</template>

<style scoped>
.history-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 18px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* 冷色区分于「喜欢」的粉色，两个页面一眼能分开。 */
.hero {
  --tint: #6ba6d6;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      480px 200px at 4% 0%,
      color-mix(in srgb, var(--tint) 20%, transparent),
      transparent 70%
    ),
    linear-gradient(135deg, var(--surface-strong), color-mix(in srgb, var(--surface) 40%, transparent));
  box-shadow: var(--shadow-sm);
}

.hero-icon {
  display: grid;
  flex: none;
  width: 58px;
  height: 58px;
  place-items: center;
  border-radius: 18px;
  background: color-mix(in srgb, var(--tint) 18%, var(--surface));
  color: var(--tint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tint) 34%, transparent);
}

.hero-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.eyebrow {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.14em;
}

.hero-copy h1 {
  font-size: 23px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.hero-sub {
  color: var(--text-muted);
  font-size: 12px;
}

.hero-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.hero-play {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 18px;
  border-radius: var(--radius-pill);
  background: var(--tint);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--tint) 85%, transparent);
  transition:
    transform var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}

.hero-play:hover:not(:disabled) {
  transform: translateY(-1px);
}

.hero-play:disabled {
  opacity: 0.5;
  cursor: default;
}

.hero-clear {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--danger);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}

.hero-clear:hover:not(:disabled) {
  border-color: var(--danger);
}

.hero-clear:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (max-width: 720px) {
  .hero {
    flex-wrap: wrap;
  }

  .hero-actions {
    width: 100%;
  }

  .hero-play {
    flex: 1;
    justify-content: center;
  }
}
</style>
