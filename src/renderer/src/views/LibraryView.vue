<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import GridSkeleton from '@/components/skeleton/GridSkeleton.vue';
import type { Platform, PlaylistSummary } from '@/api/types';
import { useDelayedLoading } from '@/composables/useDelayedLoading';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { usePreferencesStore } from '@/stores/preferences';
import { cachedImage } from '@/utils/cacheImage';
import { platformName } from '@/utils/format';

/**
 * 音乐库 = 平台账号的歌单入口。
 *
 * 「本地」那一套（收藏 / 歌单 / 下载 / 历史）现在各有独立页面，
 * 这里只负责浏览网易云与 QQ 音乐账号里的歌单，并把它们「导入」成本地歌单。
 */
const library = useLibraryStore();
const preferences = usePreferencesStore();
const router = useRouter();
const toast = useToast();

const PLATFORMS: Platform[] = ['netease', 'qq'];

/** 已绑定、且没在设置里关掉「账号歌单」的平台。 */
const boundPlatforms = computed<Platform[]>(() =>
  PLATFORMS.filter(
    (platform) => library.isBound(platform) && preferences.isEnabled(platform, 'library'),
  ),
);

const source = ref<Platform | null>(null);
const platformError = ref('');

const platformItems = computed<PlaylistSummary[]>(() =>
  source.value ? library.platformPlaylists[source.value] : [],
);
const platformLoading = computed(() =>
  Boolean(source.value && library.platformLoading[source.value]),
);
const skeletonVisible = useDelayedLoading(platformLoading);

onMounted(async () => {
  source.value = boundPlatforms.value[0] ?? null;
  await reloadPlatform();
});

/** 绑定状态变了（在账户中心绑定 / 解绑）：自动落到第一个可用平台。 */
watch(boundPlatforms, (items) => {
  if (source.value && items.includes(source.value)) return;
  source.value = items[0] ?? null;
  void reloadPlatform();
});

async function selectSource(next: Platform): Promise<void> {
  if (source.value === next) return;
  source.value = next;
  await reloadPlatform();
}

/** 切来源就重新读一遍：上游有缓存，不会打穿；也免得停在别人的旧数据上。 */
async function reloadPlatform(): Promise<void> {
  const platform = source.value;
  platformError.value = '';
  if (!platform) return;
  try {
    await library.loadPlatformPlaylists(platform);
  } catch (error) {
    platformError.value = error instanceof Error ? error.message : '读取平台歌单失败';
  }
}

function openCollection(item: PlaylistSummary): void {
  void router.push({ name: 'collection', params: { platform: item.platform, id: item.id } });
}

async function importItem(item: PlaylistSummary): Promise<void> {
  if (library.importing) return;
  try {
    const result = await library.importPlaylist(item.platform, item.id);
    toast.success(
      `「${item.title}」已导入 ${result.added} 首${result.skipped > 0 ? `，跳过 ${result.skipped} 首` : ''}`,
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败');
  }
}
</script>

<template>
  <div class="library-view">
    <header class="head">
      <div>
        <p class="eyebrow">音乐库</p>
        <h1>{{ source ? `${platformName(source)} · 我的音乐` : '平台音乐库' }}</h1>
        <p v-if="source" class="head-desc">
          来自该平台账号，共 {{ platformItems.length }} 个歌单（收藏「我喜欢」也在其中）。
        </p>
        <p v-else class="head-desc">绑定网易云或 QQ 音乐后，这里会列出它们的自建与收藏歌单。</p>
      </div>

      <div v-if="source" class="head-actions">
        <button type="button" class="mini" :disabled="platformLoading" @click="reloadPlatform">
          <AppIcon name="refresh" :size="12" :class="{ spin: platformLoading }" />
          刷新列表
        </button>
      </div>
    </header>

    <!-- 来源只有平台账号：本地内容在各自的页面里 -->
    <div class="sources">
      <button
        v-for="platform in boundPlatforms"
        :key="platform"
        type="button"
        class="chip"
        :class="{ 'is-active': source === platform }"
        @click="selectSource(platform)"
      >
        {{ platformName(platform) }}
      </button>
      <RouterLink v-if="boundPlatforms.length === 0" class="bind-hint" :to="{ name: 'account' }">
        <AppIcon name="qr" :size="13" />
        绑定网易云 / QQ 音乐账号后，这里会多出它们的收藏与歌单
        <AppIcon name="chevron-right" :size="12" />
      </RouterLink>
    </div>

    <EmptyState
      v-if="!source"
      icon="library"
      title="还没有绑定音乐账号"
      description="在账户中心绑定网易云或 QQ 音乐，就能在这里浏览它们的自建与收藏歌单。"
    >
      <RouterLink class="mini primary" :to="{ name: 'account' }">去绑定</RouterLink>
    </EmptyState>

    <template v-else>
      <ErrorState v-if="platformError" :message="platformError" @retry="reloadPlatform" />
      <GridSkeleton v-else-if="skeletonVisible" :count="8" :min="150" />

      <template v-if="!platformLoading && !platformError">
        <div v-if="platformItems.length > 0" class="grid">
          <div v-for="item in platformItems" :key="item.id" class="tile">
            <div class="tile-cover">
              <button type="button" class="cover-btn" @click="openCollection(item)">
                <img v-if="item.cover" :src="cachedImage(item.cover)" alt="" loading="lazy" />
                <AppIcon v-else name="list" :size="24" :stroke-width="1.4" />
              </button>
              <button
                type="button"
                class="tile-action"
                :disabled="library.importing !== ''"
                :title="`把「${item.title}」复制成我的歌单（只复制，之后两边不同步）`"
                @click="importItem(item)"
              >
                <AppIcon
                  :name="library.importing === `${item.platform}:${item.id}` ? 'refresh' : 'download'"
                  :size="11"
                  :class="{ spin: library.importing === `${item.platform}:${item.id}` }"
                />
                {{ library.importing === `${item.platform}:${item.id}` ? '导入中' : '导入' }}
              </button>
            </div>

            <div class="tile-meta only-open">
              <button type="button" class="tile-open" @click="openCollection(item)">
                <strong :title="item.title">{{ item.title }}</strong>
                <small>{{ item.trackCount ?? 0 }} 首</small>
              </button>
            </div>
          </div>
        </div>

        <EmptyState
          v-else
          icon="list"
          title="这个账号还没有歌单"
          description="平台上的自建与收藏歌单会显示在这里。"
        />
      </template>

      <p class="footnote">
        这份列表取自该平台账号本身：可以点开看、也可以「导入」成本地歌单；在这里不会改动平台上的数据，
        导入之后两边各走各的，不会互相同步。
      </p>
    </template>
  </div>
</template>

<style scoped>
.library-view {
  display: flex;
  max-width: 1180px;
  margin: 0 auto;
  flex-direction: column;
  gap: 14px;
  animation: fade-up var(--dur-slow) var(--ease);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      520px 220px at 6% 0%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 72%
    ),
    linear-gradient(135deg, var(--surface-strong), color-mix(in srgb, var(--surface) 40%, transparent));
  box-shadow: var(--shadow-sm);
}

.head h1 {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.head-desc {
  max-width: 560px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.head-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* ---------------- 来源 ---------------- */

.sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}

.chip {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.chip.is-active {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.bind-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  transition: color var(--dur) var(--ease);
}

.bind-hint:hover {
  color: var(--accent);
}

/* ---------------- 卡片网格 ---------------- */

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
  padding: 2px 4px;
}

.tile {
  min-width: 0;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 44%, transparent);
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.tile:hover {
  border-color: var(--border-strong);
  background: var(--surface);
  transform: translateY(-2px);
}

/* 封面是定位容器：动作按钮浮在右上角，不占歌名那一行的宽度。 */
.tile-cover {
  position: relative;
}

.cover-btn {
  display: grid;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  place-items: center;
  border-radius: var(--radius-md);
  background:
    radial-gradient(circle at 34% 28%, var(--accent-soft), transparent 62%),
    var(--surface);
  color: var(--text-faint);
}

.cover-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-action {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  height: 24px;
  align-items: center;
  gap: 4px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface-strong);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow-sm);
  color: var(--text);
  font-size: 11px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.tile-action:hover:not(:disabled) {
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
}

.tile-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.tile-meta {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 9px;
}

.tile-meta.only-open {
  align-items: center;
}

.tile-open {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}

.tile-open strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-open small {
  color: var(--text-faint);
  font-size: 10.5px;
}

.tile-open:hover strong {
  color: var(--accent);
}

.footnote {
  padding: 6px 6px 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}

/* ---------------- 按钮 ---------------- */

.mini {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
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

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini:disabled {
  opacity: 0.55;
  cursor: default;
}

.mini.primary {
  border-color: transparent;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
}
</style>
