<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import TrackList from '@/components/music/TrackList.vue';
import TrackRowsSkeleton from '@/components/skeleton/TrackRowsSkeleton.vue';
import { useDelayedLoading } from '@/composables/useDelayedLoading';
import { useTransport } from '@/composables/useTransport';
import { useLibraryStore } from '@/stores/library';

/**
 * 「喜欢的音乐」独立页：不再复用音乐库的分栏，只做收藏这一件事——
 * 顶部一块 hero 交代来源和数量，下面直接是可播放的曲目列表。
 */
const library = useLibraryStore();
const transport = useTransport();

const loading = ref(false);
const error = ref('');
const skeletonVisible = useDelayedLoading(loading);

const count = computed(() => library.favorites.length);
/** 收藏的曲目通常带多个平台来源，把出现过的平台数出来。 */
const sources = computed(() => {
  const seen = new Set<string>();
  for (const track of library.favorites) {
    for (const item of track.sources) seen.add(item.platform);
  }
  return seen.size;
});

onMounted(() => void load());

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await library.loadFavorites();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载喜欢的音乐失败';
  } finally {
    loading.value = false;
  }
}

function playAll(): void {
  if (count.value === 0) return;
  transport.playList(library.favorites);
}
</script>

<template>
  <div class="favorites-view">
    <header class="hero">
      <span class="hero-icon"><AppIcon name="heart" :size="24" :stroke-width="1.8" /></span>
      <div class="hero-copy">
        <p class="eyebrow">我的音乐</p>
        <h1>喜欢的音乐</h1>
        <p class="hero-sub">
          共 {{ count }} 首<template v-if="sources > 0"> · 来自 {{ sources }} 个平台</template>
        </p>
      </div>
      <button type="button" class="hero-play" :disabled="count === 0" @click="playAll">
        <AppIcon name="play" :size="13" />
        播放全部
      </button>
    </header>

    <ErrorState v-if="error" :message="error" @retry="load" />
    <TrackRowsSkeleton v-else-if="skeletonVisible" :rows="8" />

    <TrackList
      v-if="!loading && !error"
      :tracks="library.favorites"
      :show-head="false"
      empty-text="还没有收藏。在歌曲行右侧点亮爱心，它就会出现在这里。"
    />
  </div>
</template>

<style scoped>
.favorites-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 18px;
  animation: fade-up var(--dur-slow) var(--ease);
}

.hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      480px 200px at 4% 0%,
      color-mix(in srgb, var(--accent) 20%, transparent),
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
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent);
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

.hero-play {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 18px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--accent) 85%, transparent);
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

@media (max-width: 720px) {
  .hero {
    flex-wrap: wrap;
  }

  .hero-play {
    width: 100%;
    justify-content: center;
  }
}
</style>
