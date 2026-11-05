<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import PageState from '@/components/common/PageState.vue';
import TrackList from '@/components/music/TrackList.vue';
import PlaylistDialog from '@/components/library/PlaylistDialog.vue';
import { libraryApi } from '@/api/library';
import type { OfflineItem } from '@shared/offline';
import type { Platform, Playlist, PlaylistSummary, Quality, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { useOfflineStore } from '@/stores/offline';
import { usePlayerStore } from '@/stores/player';
import { usePreferencesStore } from '@/stores/preferences';
import { platformName } from '@/utils/format';

type Tab = 'favorites' | 'playlists' | 'downloads' | 'history';

/**
 * 音乐库（与 web 端同一套结构）：
 *
 * 顶部先选「听谁的库」——本地 / 网易云 / QQ 音乐，只列已绑定的平台；
 * 本地再分收藏、歌单、下载、历史四栏。两边数据完全独立，不做合并展示，
 * 平台那一侧只读，想要就「导入」成自己的歌单。
 */
const library = useLibraryStore();
const offline = useOfflineStore();
const preferences = usePreferencesStore();
const player = usePlayerStore();
const router = useRouter();
const toast = useToast();

const PLATFORMS: Platform[] = ['netease', 'qq'];
/** 已绑定、且没在设置里关掉「账号歌单」的平台：没绑就没得看，关掉了就是不想看。 */
const boundPlatforms = computed<Platform[]>(() =>
  PLATFORMS.filter(
    (platform) => library.isBound(platform) && preferences.isEnabled(platform, 'library'),
  ),
);

const tab = ref<Tab>('favorites');
const source = ref<Platform | null>(null);
const createOpen = ref(false);

const platformError = ref('');
/** 待确认删除的歌单 id（桌面端习惯：再点一次才真删）。 */
const confirmDelete = ref('');
const confirmingHistory = ref(false);
const confirmingDownloads = ref(false);

const tabs = computed<Array<{ id: Tab; label: string; icon: string; count: number }>>(() => [
  { id: 'favorites', label: '收藏', icon: 'heart', count: library.favorites.length },
  { id: 'playlists', label: '歌单', icon: 'list', count: library.playlists.length },
  { id: 'downloads', label: '下载', icon: 'download', count: offline.items.length },
  { id: 'history', label: '最近播放', icon: 'clock', count: library.history.length },
]);

const platformItems = computed<PlaylistSummary[]>(() =>
  source.value ? library.platformPlaylists[source.value] : [],
);
const platformLoading = computed(() => Boolean(source.value && library.platformLoading[source.value]));

/** 离线条目还原成可播放的曲目：播放时 player 会认出 key 并走本地文件。 */
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

const downloadTracks = computed<UnifiedTrack[]>(() => offline.items.map(toPlayable));
const lastPlayed = computed(() => {
  const value = library.history[0]?.playedAt;
  return value ? new Date(value).toLocaleString() : '';
});

onMounted(() => {
  void library.loadAll();
  void offline.load();
});

/** 切来源就重新读一遍：上游有缓存，不会打穿；也免得停在别人的旧数据上。 */
async function selectSource(next: Platform | null): Promise<void> {
  source.value = next;
  confirmDelete.value = '';
  confirmingHistory.value = false;
  confirmingDownloads.value = false;
  if (!next) return;
  await reloadPlatform();
}

async function reloadPlatform(): Promise<void> {
  const platform = source.value;
  if (!platform) return;
  platformError.value = '';
  try {
    await library.loadPlatformPlaylists(platform);
  } catch (error) {
    platformError.value = error instanceof Error ? error.message : '读取平台歌单失败';
  }
}

/** 绑定状态变了（在账户中心解绑）之后，别把用户留在空白的平台页上。 */
watch(boundPlatforms, (items) => {
  if (source.value && !items.includes(source.value)) {
    source.value = null;
  }
});

watch(tab, () => {
  confirmDelete.value = '';
  confirmingHistory.value = false;
  confirmingDownloads.value = false;
});

function openPlaylist(id: string): void {
  void router.push({ name: 'playlist', params: { id } });
}

function openCollection(item: PlaylistSummary): void {
  void router.push({ name: 'collection', params: { platform: item.platform, id: item.id } });
}

function onCreated(playlist: Playlist): void {
  // 建完直接进歌单页，方便马上往里加歌。
  openPlaylist(playlist.id);
}

function playAllFavorites(): void {
  if (library.favorites.length === 0) return;
  void player.playQueue(library.favorites, 0);
}

/** 卡片上的「播放」：直接开播，进详情页交给封面与歌名。 */
async function playPlaylist(item: Playlist): Promise<void> {
  if (item.trackCount === 0) {
    toast.info(`「${item.name}」还是空的，先加几首歌`);
    return;
  }
  try {
    const result = await libraryApi.getPlaylist(item.id);
    if (result.items.length === 0) {
      toast.info(`「${item.name}」还是空的，先加几首歌`);
      return;
    }
    await player.playQueue(result.items, 0);
    toast.success(`正在播放「${item.name}」`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '歌单加载失败');
  }
}

async function removePlaylist(item: Playlist): Promise<void> {
  if (confirmDelete.value !== item.id) {
    confirmDelete.value = item.id;
    return;
  }
  confirmDelete.value = '';
  try {
    await library.deletePlaylist(item.id);
    toast.info('歌单已删除');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除歌单失败');
  }
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

async function clearHistory(): Promise<void> {
  if (!confirmingHistory.value) {
    confirmingHistory.value = true;
    return;
  }
  confirmingHistory.value = false;
  try {
    await library.clearHistory();
    toast.info('播放历史已清空');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '清空历史失败');
  }
}

async function clearDownloads(): Promise<void> {
  if (!confirmingDownloads.value) {
    confirmingDownloads.value = true;
    return;
  }
  confirmingDownloads.value = false;
  try {
    await offline.clear();
    toast.info('已清空本地下载');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '清空下载失败');
  }
}
</script>

<template>
  <div class="library-view">
    <header class="head">
      <div>
        <p class="eyebrow">音乐库</p>
        <h1>{{ source ? `${platformName(source)} · 我的音乐` : '我的音乐' }}</h1>
        <p v-if="!source" class="head-desc">
          共 {{ library.favorites.length }} 首收藏 · {{ library.playlists.length }} 个歌单 ·
          {{ library.history.length }} 条播放记录
        </p>
        <p v-else class="head-desc">
          来自该平台账号，共 {{ platformItems.length }} 个歌单（收藏「我喜欢」也在其中）
        </p>
      </div>

      <div class="head-actions">
        <template v-if="!source">
          <button
            v-if="tab === 'playlists'"
            type="button"
            class="mini primary"
            @click="createOpen = true"
          >
            <AppIcon name="plus" :size="13" />
            新建歌单
          </button>
          <button
            v-else-if="tab === 'favorites' && library.favorites.length > 0"
            type="button"
            class="mini primary"
            @click="playAllFavorites"
          >
            <AppIcon name="play" :size="12" filled />
            播放全部
          </button>
          <button
            v-else-if="tab === 'history' && library.history.length > 0"
            type="button"
            class="mini"
            :class="{ danger: confirmingHistory }"
            @click="clearHistory"
          >
            <AppIcon name="trash" :size="12" />
            {{ confirmingHistory ? '再点一次清空' : '清空历史' }}
          </button>
          <button
            v-else-if="tab === 'downloads' && offline.items.length > 0"
            type="button"
            class="mini"
            :class="{ danger: confirmingDownloads }"
            @click="clearDownloads"
          >
            <AppIcon name="trash" :size="12" />
            {{ confirmingDownloads ? '再点一次清空' : '清空下载' }}
          </button>
        </template>

        <button v-else type="button" class="mini" :disabled="platformLoading" @click="reloadPlatform">
          <AppIcon name="refresh" :size="12" :class="{ spin: platformLoading }" />
          刷新列表
        </button>
      </div>
    </header>

    <!-- 来源：本地 / 各平台账号。三套数据分开看，互不合并 -->
    <div class="sources">
      <button
        type="button"
        class="chip"
        :class="{ 'is-active': source === null }"
        @click="selectSource(null)"
      >
        本地
      </button>
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

    <!-- 本地四栏 -->
    <nav v-if="!source" class="tabs" role="tablist" aria-label="音乐库">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: tab === item.id }"
        :aria-selected="tab === item.id"
        @click="tab = item.id"
      >
        <AppIcon :name="item.icon" :size="13" />
        {{ item.label }}
        <span class="tab-count">{{ item.count }}</span>
      </button>
    </nav>

    <PageState
      :loading="library.loading"
      :error="library.error"
      text="正在读取音乐库…"
      @retry="library.loadAll"
    />

    <template v-if="!library.loading && !library.error">
      <!-- 收藏 -->
      <template v-if="!source && tab === 'favorites'">
        <TrackList
          v-if="library.favorites.length > 0"
          :tracks="library.favorites"
          title="收藏"
          empty-text="还没有收藏"
        />
        <EmptyState
          v-else
          icon="heart"
          title="还没有收藏歌曲"
          description="在任意歌曲右侧点那颗心就能收藏，收藏存在 Sakura 自己的库里。"
        >
          <RouterLink class="mini primary" :to="{ name: 'search' }">
            <AppIcon name="search" :size="12" />
            去搜索
          </RouterLink>
        </EmptyState>
      </template>

      <!-- 歌单 -->
      <template v-else-if="!source && tab === 'playlists'">
        <div v-if="library.playlists.length > 0" class="grid">
          <div v-for="item in library.playlists" :key="item.id" class="tile">
            <div class="tile-cover">
              <button type="button" class="cover-btn" @click="openPlaylist(item.id)">
                <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
                <AppIcon v-else name="list" :size="24" :stroke-width="1.4" />
              </button>
              <button
                type="button"
                class="tile-action"
                :title="item.trackCount === 0 ? '歌单还是空的' : `播放「${item.name}」`"
                @click="playPlaylist(item)"
              >
                <AppIcon name="play" :size="11" filled />
                播放
              </button>
            </div>

            <div class="tile-meta">
              <button type="button" class="tile-open" @click="openPlaylist(item.id)">
                <strong :title="item.name">{{ item.name }}</strong>
                <small>{{ item.trackCount }} 首</small>
              </button>
              <button
                type="button"
                class="tile-delete"
                :class="{ 'is-confirm': confirmDelete === item.id }"
                :title="confirmDelete === item.id ? '再点一次删除' : '删除歌单'"
                @click="removePlaylist(item)"
              >
                <template v-if="confirmDelete === item.id">删除</template>
                <AppIcon v-else name="trash" :size="14" />
              </button>
            </div>
          </div>
        </div>

        <EmptyState
          v-else
          icon="list"
          title="还没有歌单"
          description="创建歌单来整理你在两个平台找到的歌。"
        >
          <button type="button" class="mini primary" @click="createOpen = true">
            <AppIcon name="plus" :size="12" />
            新建歌单
          </button>
        </EmptyState>
      </template>

      <!-- 下载（桌面端独有：本地文件） -->
      <template v-else-if="!source && tab === 'downloads'">
        <div class="panel-note">
          <span>
            已用 {{ offline.usedText }} / 上限 {{ offline.limitText }} · {{ offline.items.length }} 首
            <template v-if="offline.activeDownloads > 0">
              · 正在下载 {{ offline.activeDownloads }} 首
            </template>
          </span>
          <button type="button" class="mini" :disabled="offline.loading" @click="offline.load()">
            <AppIcon name="refresh" :size="12" />
            刷新
          </button>
        </div>
        <p v-if="offline.overflow" class="notice danger">
          已超出设置里的上限（{{ offline.limitText }}），建议删掉一些不常听的下载。
        </p>
        <p v-if="offline.error" class="notice danger">{{ offline.error }}</p>

        <TrackList
          :tracks="downloadTracks"
          title="本地下载"
          empty-text="还没有下载。在曲目行右侧点「…」，选「下载到本地」。"
        />
      </template>

      <!-- 最近播放 -->
      <template v-else-if="!source">
        <TrackList
          v-if="library.history.length > 0"
          :tracks="library.history"
          title="最近播放"
          empty-text="还没有播放记录"
        />
        <EmptyState
          v-else
          icon="clock"
          title="还没有播放记录"
          description="听过的歌会自动出现在这里。"
        />
        <p v-if="lastPlayed" class="footnote">最近一次播放：{{ lastPlayed }}</p>
      </template>

      <!-- 平台账号 -->
      <template v-if="source">
        <PageState
          :loading="platformLoading"
          :error="platformError"
          :text="`正在读取${platformName(source)}账号…`"
          @retry="reloadPlatform"
        />

        <template v-if="!platformLoading && !platformError">
          <div v-if="platformItems.length > 0" class="grid">
            <div v-for="item in platformItems" :key="item.id" class="tile">
              <div class="tile-cover">
                <button type="button" class="cover-btn" @click="openCollection(item)">
                  <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
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
    </template>

    <PlaylistDialog :visible="createOpen" @close="createOpen = false" @created="onCreated" />
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

/* ---------------- 来源与分栏 ---------------- */

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

.tabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg) 40%, var(--surface));
}

.tab {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.tab:hover {
  color: var(--text-muted);
}

.tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.tab-count {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
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

.tile-delete {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.tile-delete:hover {
  background: color-mix(in srgb, #e0453a 12%, transparent);
  color: #e0453a;
}

.tile-delete.is-confirm {
  width: auto;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, #e0453a 14%, transparent);
  color: #e0453a;
}

/* ---------------- 说明与提示 ---------------- */

.panel-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 4px;
  color: var(--text-faint);
  font-size: 11px;
}

.notice {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.notice.danger {
  border-color: color-mix(in srgb, #e0453a 30%, transparent);
  color: #e0453a;
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

.mini.danger {
  border-color: color-mix(in srgb, #e0453a 42%, transparent);
  color: #e0453a;
}
</style>
