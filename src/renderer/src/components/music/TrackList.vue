<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { useOfflineStore } from '@/stores/offline';
import { usePlayerStore } from '@/stores/player';
import { formatTime, platformName } from '@/utils/format';
import { trackQualityLabel } from '@/utils/track';

const props = withDefaults(
  defineProps<{
    tracks: UnifiedTrack[];
    title?: string;
    emptyText?: string;
    showCover?: boolean;
    /** 歌单详情里用「移除」，其它地方用「下一首播放」。 */
    removable?: boolean;
    showFavorite?: boolean;
  }>(),
  {
    title: '曲目',
    emptyText: '这里还没有曲目',
    showCover: true,
    removable: false,
    showFavorite: true,
  },
);

const emit = defineEmits<{ remove: [track: UnifiedTrack] }>();

const player = usePlayerStore();
const library = useLibraryStore();
const offline = useOfflineStore();
const toast = useToast();

const currentKey = computed(() => player.current?.key ?? '');

/** 行内「更多」菜单：下一首播放、加入歌单。同一时刻只开一个。 */
const menuKey = ref<string | null>(null);
const menuTrack = ref<UnifiedTrack | null>(null);

function toggleMenu(track: UnifiedTrack): void {
  if (menuKey.value === track.key) {
    menuKey.value = null;
    return;
  }
  menuKey.value = track.key;
  menuTrack.value = track;
  if (library.playlists.length === 0) void library.loadPlaylists().catch(() => undefined);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!menuKey.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.row-menu, .menu-trigger')) return;
  menuKey.value = null;
}

async function addToPlaylist(id: string, name: string): Promise<void> {
  const track = menuTrack.value;
  if (!track) return;
  try {
    const added = await library.addToPlaylist(id, track);
    toast.success(added ? `已加入「${name}」` : `「${name}」里已经有这首了`);
    menuKey.value = null;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '加入歌单失败');
  }
}

function playNextFromMenu(track: UnifiedTrack): void {
  player.playNext(track);
  menuKey.value = null;
}

async function downloadFromMenu(track: UnifiedTrack): Promise<void> {
  menuKey.value = null;
  try {
    await offline.download(track, player.quality);
    toast.success(`「${track.title}」已下载到本地`);
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '下载失败');
  }
}

function downloadLabel(track: UnifiedTrack): string {
  if (offline.isDownloading(track.key)) {
    const percent = offline.percentOf(track.key);
    return percent > 0 ? `下载中… ${percent}%` : '下载中…';
  }
  return offline.has(track.key) ? '重新下载' : '下载到本地';
}

async function removeDownload(track: UnifiedTrack): Promise<void> {
  menuKey.value = null;
  try {
    await offline.remove(track.key);
    toast.info('已删除本地文件');
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '删除失败');
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});

function playAt(at: number): void {
  void player.playQueue(props.tracks, at);
}

function playAll(): void {
  if (props.tracks.length === 0) return;
  void player.playQueue(props.tracks, 0);
}

async function toggleFavorite(track: UnifiedTrack): Promise<void> {
  try {
    const next = await library.toggleFavorite(track);
    toast.success(next ? '已收藏' : '已取消收藏');
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '收藏失败');
  }
}
</script>

<template>
  <section class="track-list">
    <header v-if="tracks.length > 0" class="list-head">
      <span class="faint">{{ title }} · {{ tracks.length }} 首</span>
      <button type="button" class="play-all" @click="playAll">
        <AppIcon name="play" :size="12" />
        播放全部
      </button>
    </header>

    <p v-if="tracks.length === 0" class="empty-copy">{{ emptyText }}</p>

    <ul v-else class="rows">
      <li
        v-for="(track, at) in tracks"
        :key="track.key"
        class="row"
        :class="{ active: currentKey === track.key }"
      >
        <!--
          行本身不再是 <button>：歌手、专辑要做成链接，交互元素不能嵌在按钮里
          （浏览器会把里面的点击吞掉）。改成 role=button 的 div，键盘仍可操作。
        -->
        <div
          class="row-main"
          :class="{ 'no-cover': !showCover }"
          role="button"
          tabindex="0"
          :title="`播放 ${track.title}`"
          @click="playAt(at)"
          @keydown.enter.self="playAt(at)"
          @keydown.space.self.prevent="playAt(at)"
        >
          <span class="row-index">
            <AppIcon
              v-if="currentKey === track.key && player.playing"
              name="volume"
              :size="13"
            />
            <template v-else>{{ at + 1 }}</template>
          </span>

          <span v-if="showCover" class="row-cover">
            <img v-if="track.album.cover" :src="track.album.cover" alt="" loading="lazy" />
            <AppIcon v-else name="music" :size="15" :stroke-width="1.5" />
          </span>

          <span class="row-meta">
            <!-- VIP 紧贴歌名：它说明的是「这首歌要不要会员」，不是平台/音质那一类信息 -->
            <span class="row-title">
              <strong>{{ track.title }}</strong>
              <span v-if="track.vip" class="tag vip">VIP</span>
            </span>
            <small class="row-artists">
              <template v-if="track.artists.length === 0">未知歌手</template>
              <template v-for="(artist, artistIndex) in track.artists" :key="`${artist.name}-${artistIndex}`">
                <RouterLink
                  v-if="artist.id && artist.platform"
                  class="row-link"
                  :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
                  @click.stop
                >
                  {{ artist.name }}
                </RouterLink>
                <span v-else>{{ artist.name }}</span>
                <span v-if="artistIndex < track.artists.length - 1"> / </span>
              </template>
            </small>
          </span>

          <RouterLink
            v-if="track.album.id && track.album.platform"
            class="row-album row-link"
            :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
            :title="track.album.name"
            @click.stop
          >
            {{ track.album.name }}
          </RouterLink>
          <span v-else class="row-album">{{ track.album.name }}</span>

          <span class="row-tags">
            <span v-for="source in track.sources" :key="`${source.platform}-${source.id}`" class="tag">
              {{ platformName(source.platform) }}
            </span>
            <span v-if="trackQualityLabel(track)" class="tag">{{ trackQualityLabel(track) }}</span>
          </span>

          <span class="row-time">{{ formatTime(track.durationMs / 1000) }}</span>
        </div>

        <span class="row-actions">
          <button
            v-if="showFavorite"
            type="button"
            class="btn-icon row-action"
            :class="{ faved: library.isFavorite(track) }"
            :title="library.isFavorite(track) ? '取消收藏' : '收藏'"
            :aria-label="library.isFavorite(track) ? '取消收藏' : '收藏'"
            @click.stop="toggleFavorite(track)"
          >
            <AppIcon name="heart" :size="14" :filled="library.isFavorite(track)" />
          </button>

          <button
            v-if="removable"
            type="button"
            class="btn-icon row-action danger"
            title="从歌单移除"
            aria-label="从歌单移除"
            @click.stop="emit('remove', track)"
          >
            <AppIcon name="close" :size="14" />
          </button>

          <button
            v-else
            type="button"
            class="btn-icon row-action menu-trigger"
            title="更多操作"
            aria-label="更多操作"
            @click.stop="toggleMenu(track)"
          >
            <AppIcon name="plus" :size="14" />
          </button>
        </span>

        <span v-if="menuKey === track.key" class="row-menu">
          <button type="button" class="menu-item" @click.stop="playNextFromMenu(track)">
            <AppIcon name="next" :size="13" />
            下一首播放
          </button>

          <button
            type="button"
            class="menu-item"
            :disabled="offline.isDownloading(track.key)"
            @click.stop="downloadFromMenu(track)"
          >
            <AppIcon name="download" :size="13" />
            {{ downloadLabel(track) }}
          </button>

          <button
            v-if="offline.has(track.key)"
            type="button"
            class="menu-item danger"
            @click.stop="removeDownload(track)"
          >
            <AppIcon name="close" :size="13" />
            删除本地下载
          </button>
          <p v-if="library.playlists.length === 0" class="menu-empty">还没有本地歌单</p>
          <button
            v-for="item in library.playlists"
            :key="item.id"
            type="button"
            class="menu-item"
            @click.stop="addToPlaylist(item.id, item.name)"
          >
            <AppIcon name="plus" :size="13" />
            <span class="menu-name">{{ item.name }}</span>
          </button>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.track-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 4px;
  font-size: 11px;
}

.play-all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  transition: filter var(--dur) var(--ease);
}

.play-all:hover {
  filter: brightness(1.06);
}

.empty-copy {
  padding: 28px 4px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

/* ul 自带 40px 左内边距与上下外边距，不清掉的话整列会平白缩进一大截。 */
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--radius-sm);
  transition: background var(--dur) var(--ease);
}

.row:hover {
  background: var(--surface-hover);
}

.row.active {
  background: var(--accent-soft);
}

/*
 * 各列宽度必须每行都一致：标签列之前是 `auto`，标签多的行会把它撑宽、
 * 于是专辑列在每行的起始位置都不一样，整列看下来就是歪的。这里改成定宽，
 * 标签超了就换行（行高由 40px 的封面撑着，两行标签也不会把行撑高）。
 */
.row-main {
  display: grid;
  flex: 1;
  min-width: 0;
  grid-template-columns: 26px 40px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 112px) 42px;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  text-align: left;
}

/*
 * 专辑页这种不显示封面的列表，必须把封面那一列也去掉：
 * 网格列是写死的，少一个子元素只会让后面的内容整体左移一格 ——
 * 歌名被挤进 40px 的封面列、专辑占掉歌名那一列，看起来就是「歌名和专辑叠在一起」。
 */
.row-main.no-cover {
  grid-template-columns: 26px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 112px) 42px;
}

.row-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.row.active .row-index {
  color: var(--accent);
}

.row-cover {
  display: grid;
  width: 40px;
  height: 40px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--text-faint);
}

.row-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.row-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.4;
}

/* 歌名那一行：标题吃掉剩余宽度并截断，VIP 徽标固定宽度跟在后面 */
.row-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.row-title .tag {
  flex: none;
}

.row-meta strong {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.active .row-meta strong {
  color: var(--accent);
}

.row-meta small {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 歌手 / 专辑链接：平时与正文同色，悬停才亮起并加下划线 */
.row-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}

.row-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.row-album {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  overflow: hidden;
}

.tag {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 650;
  white-space: nowrap;
}

.tag.vip {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}

.row-time {
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.row-actions {
  display: flex;
  flex: none;
  gap: 2px;
  margin-right: 6px;
}

.row-action {
  width: 28px;
  height: 28px;
  flex: none;
  opacity: 0;
}

.row:hover .row-action,
.row-action.faved {
  opacity: 1;
}

.row-action.faved {
  color: var(--accent);
}

.row-action.danger:hover {
  color: #e0453a;
}

.row-menu {
  position: absolute;
  top: calc(100% - 4px);
  right: 40px;
  z-index: var(--z-overlay);
  display: flex;
  width: 190px;
  max-height: 240px;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11px;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.menu-item:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.menu-item:disabled {
  opacity: 0.55;
  cursor: default;
}

.menu-item.danger {
  color: #e0453a;
}

.menu-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-empty {
  padding: 8px 9px;
  color: var(--text-faint);
  font-size: 10px;
}

@media (max-width: 1080px) {
  .row-main {
    grid-template-columns: 24px 40px minmax(0, 1fr) auto 42px;
  }

  .row-album {
    display: none;
  }
}
</style>
