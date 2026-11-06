<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import TrackMoreMenu from './TrackMoreMenu.vue';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { cachedImage } from '@/utils/cacheImage';
import { formatTime, platformName } from '@/utils/format';
import { trackQualityLabel } from '@/utils/track';

const props = withDefaults(
  defineProps<{
    tracks: UnifiedTrack[];
    title?: string;
    emptyText?: string;
    showCover?: boolean;
    /** 本地歌单详情：更多菜单里额外给一项「从歌单移除」。 */
    removable?: boolean;
    showFavorite?: boolean;
    /** 外层自己画标题栏时关掉组件自带的「N 首 / 播放全部」。 */
    showHead?: boolean;
  }>(),
  {
    title: '曲目',
    emptyText: '这里还没有曲目',
    showCover: true,
    removable: false,
    showFavorite: true,
    showHead: true,
  },
);

const emit = defineEmits<{ remove: [track: UnifiedTrack] }>();

const player = usePlayerStore();
const transport = useTransport();
const library = useLibraryStore();
const toast = useToast();

const currentKey = computed(() => player.current?.key ?? '');

/**
 * 「更多」菜单：点行尾三点或在行上右键都能开，同一个列表同时只开一个。
 * 浮层挂在 body 下（见 TrackMoreMenu），这里只记曲目与落点；id 每次打开都变，
 * 保证组件重新挂载、二级菜单不会带着上一次的展开状态。
 */
interface MenuState {
  id: number;
  track: UnifiedTrack;
  x: number;
  y: number;
}

const menu = ref<MenuState | null>(null);
let menuSeq = 0;
const MENU_WIDTH = 200;
const MENU_GAP = 6;

function openMenu(track: UnifiedTrack, x: number, y: number): void {
  menu.value = { id: ++menuSeq, track, x, y };
}

/** 点三点：贴着按钮下方、右边缘对齐；再点同一行就收起。 */
function openFromButton(track: UnifiedTrack, event: MouseEvent): void {
  if (menu.value?.track.key === track.key) {
    menu.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(track, rect.right - MENU_WIDTH, rect.bottom + MENU_GAP);
}

/** 右键：菜单直接落在鼠标位置。 */
function openFromContext(track: UnifiedTrack, event: MouseEvent): void {
  openMenu(track, event.clientX, event.clientY);
}

function closeMenu(): void {
  menu.value = null;
}

function onMenuRemove(track: UnifiedTrack): void {
  closeMenu();
  emit('remove', track);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!menu.value) return;
  const target = event.target;
  if (target instanceof Element && target.closest('.track-more-menu, .menu-trigger')) return;
  menu.value = null;
}

/** Esc 只收菜单：捕获阶段拦下，别让全屏歌词页跟着一起关掉。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !menu.value) return;
  event.stopImmediatePropagation();
  menu.value = null;
}

/** 页面滚动 / 窗口缩放后 fixed 菜单的落点就过期了，直接收起；菜单内部滚动不算。 */
function onViewportChange(event: Event): void {
  if (!menu.value) return;
  const target = event.target;
  if (target instanceof Element && target.closest('.track-more-menu')) return;
  menu.value = null;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  window.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});

function playAt(at: number): void {
  const track = props.tracks[at];
  if (!track) return;
  transport.playTrack(track, props.tracks);
}

/** 行尾平台圆点的悬停说明：合并曲目会列出全部来源。 */
function sourcesTitle(track: UnifiedTrack): string {
  return track.sources.map((source) => platformName(source.platform)).join(' / ');
}

function playAll(): void {
  transport.playList(props.tracks);
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
    <header v-if="showHead && tracks.length > 0" class="list-head">
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
        @contextmenu.prevent="openFromContext(track, $event)"
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
            <img v-if="track.album.cover" :src="cachedImage(track.album.cover)" alt="" loading="lazy" />
            <AppIcon v-else name="music" :size="15" :stroke-width="1.5" />
            <span class="cover-hover" aria-hidden="true">
              <AppIcon name="play" :size="16" filled />
            </span>
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
            <span v-if="trackQualityLabel(track)" class="tag">{{ trackQualityLabel(track) }}</span>
          </span>

          <span class="row-time">{{ formatTime(track.durationMs / 1000) }}</span>

          <!--
            平台来源用彩色圆点标注：跨平台合并的曲目会有多个点
            （网易云红 / QQ 绿），一眼看出这首歌在哪些平台存在。
          -->
          <span class="row-sources" :title="sourcesTitle(track)">
            <span
              v-for="source in track.sources"
              :key="`${source.platform}-${source.id}`"
              class="source-dot"
              :class="`dot-${source.platform}`"
            />
          </span>
        </div>

        <!-- 所有列表的行尾都是同一套：收藏 + 三点更多；移除、加入歌单等都收在菜单里。 -->
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
            type="button"
            class="btn-icon row-action menu-trigger"
            title="更多操作（也可以在曲目上右键）"
            aria-label="更多操作"
            @click.stop="openFromButton(track, $event)"
          >
            <AppIcon name="more" :size="16" />
          </button>
        </span>
      </li>
    </ul>

    <!-- 菜单挂到 body：列表容器有 overflow / z-index，留在行里会被裁掉或盖住。 -->
    <Teleport to="body">
      <TrackMoreMenu
        v-if="menu"
        :key="menu.id"
        :track="menu.track"
        :x="menu.x"
        :y="menu.y"
        :removable="removable"
        @close="closeMenu"
        @remove="onMenuRemove"
      />
    </Teleport>
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
  grid-template-columns:
    26px 40px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 112px) 42px
    46px;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  text-align: left;
  cursor: pointer;
}

/*
 * 专辑页这种不显示封面的列表，必须把封面那一列也去掉：
 * 网格列是写死的，少一个子元素只会让后面的内容整体左移一格 ——
 * 歌名被挤进 40px 的封面列、专辑占掉歌名那一列，看起来就是「歌名和专辑叠在一起」。
 */
.row-main.no-cover {
  grid-template-columns:
    26px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 112px) 42px
    46px;
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
  position: relative;
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

/* 平台来源圆点列：定宽、靠右，多个来源横向排开 */
.row-sources {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.source-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--text-faint);
}

.source-dot.dot-netease {
  background: #e0413f;
}

.source-dot.dot-qq {
  background: #3cc77f;
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

@media (max-width: 1080px) {
  .row-main {
    grid-template-columns: 24px 40px minmax(0, 1fr) auto 42px 46px;
  }

  .row-main.no-cover {
    grid-template-columns: 24px minmax(0, 1fr) auto 42px 46px;
  }

  .row-album {
    display: none;
  }
}
</style>
