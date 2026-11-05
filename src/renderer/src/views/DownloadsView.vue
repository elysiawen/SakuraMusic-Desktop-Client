<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import type { Quality, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { useOfflineStore } from '@/stores/offline';
import type { OfflineItem } from '@shared/offline';

/**
 * 「本地和下载」独立页：只负责用户主动下载的音频。
 * 和设置页的流媒体缓存是两回事——这里的文件在下载目录里能直接看到，删掉就是删文件。
 */
const offline = useOfflineStore();
const transport = useTransport();
const toast = useToast();

const downloadDir = ref('');
const clearOpen = ref(false);
const clearing = ref(false);

/** 离线条目还原成可播放的曲目：播放器认出 key 后会直接读本地文件。 */
function toPlayable(item: OfflineItem): UnifiedTrack {
  return {
    key: item.key,
    title: item.title,
    artists: item.artists.map((name) => ({ name })),
    album: { name: item.albumName, cover: item.albumCover },
    durationMs: item.durationMs,
    sources: [{ platform: item.platform, id: item.id }],
    qualities: [item.quality as Quality],
  };
}

const tracks = computed<UnifiedTrack[]>(() => offline.items.map(toPlayable));
const count = computed(() => offline.items.length);

onMounted(async () => {
  void offline.load();
  try {
    downloadDir.value = (await window.sakura.getConfig()).downloadDir;
  } catch {
    downloadDir.value = '';
  }
});

function playAll(): void {
  if (count.value === 0) return;
  transport.playList(tracks.value);
}

function openFolder(): void {
  if (downloadDir.value) void window.sakura.showItemInFolder(downloadDir.value);
}

async function clearAll(): Promise<void> {
  clearing.value = true;
  try {
    await offline.clear();
    toast.success('本地下载已清空');
    clearOpen.value = false;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '清空失败');
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="downloads-view">
    <header class="hero">
      <span class="hero-icon"><AppIcon name="download" :size="24" :stroke-width="1.8" /></span>
      <div class="hero-copy">
        <p class="eyebrow">我的音乐</p>
        <h1>本地和下载</h1>
        <p class="hero-sub">
          {{ count }} 首 · 占用 {{ offline.usedText }}
          <template v-if="offline.activeDownloads > 0">
            · 正在下载 {{ offline.activeDownloads }} 首
          </template>
        </p>
      </div>

      <div class="hero-actions">
        <button type="button" class="hero-play" :disabled="count === 0" @click="playAll">
          <AppIcon name="play" :size="13" />
          播放全部
        </button>
        <button
          type="button"
          class="hero-ghost"
          :disabled="!downloadDir"
          title="在文件管理器中打开下载目录"
          @click="openFolder"
        >
          <AppIcon name="folder" :size="13" />
          打开目录
        </button>
        <button
          type="button"
          class="hero-ghost is-danger"
          :disabled="count === 0 || clearing"
          @click="clearOpen = true"
        >
          清空
        </button>
      </div>
    </header>

    <PageState
      :loading="offline.loading && count === 0"
      :error="offline.error"
      text="正在读取本地文件…"
      @retry="offline.load()"
    />

    <TrackList
      v-if="!offline.loading || count > 0"
      :tracks="tracks"
      :show-head="false"
      empty-text="还没有下载。在任意曲目上点行尾的「…」，选「下载到本地」，下载好的文件会出现在这里。"
    />

    <ConfirmDialog
      :visible="clearOpen"
      title="清空本地下载"
      :message="`当前 ${count} 首本地下载会被删除，之后需要重新下载才能离线播放。该操作不可恢复。`"
      confirm-label="清空"
      danger
      :busy="clearing"
      @confirm="clearAll"
      @close="clearOpen = false"
    />
  </div>
</template>

<style scoped>
.downloads-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 18px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* 绿色呼应「已存到本地」，和喜欢（粉）、最近播放（蓝）都不撞。 */
.hero {
  --tint: #5fb98c;
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

.hero-ghost {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-hover);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}

.hero-ghost:hover:not(:disabled) {
  border-color: var(--tint);
  color: var(--text);
}

.hero-ghost.is-danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.hero-ghost:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (max-width: 820px) {
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
