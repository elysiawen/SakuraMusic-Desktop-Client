<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import PlaylistDialog from '@/components/library/PlaylistDialog.vue';
import PlaylistMoreMenu from '@/components/library/PlaylistMoreMenu.vue';
import type { Playlist } from '@/api/types';
import { usePopoverDragGuard } from '@/composables/usePopoverDragGuard';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { useOfflineStore } from '@/stores/offline';
import { useRoomStore } from '@/stores/room';
import { cachedImage } from '@/utils/cacheImage';
// 品牌标识直接用应用图标（与安装包、任务栏图标同一份资源）。
import brandIcon from '../../../../../build/icon.png';

interface NavItem {
  name: string;
  label: string;
  icon: string;
  to?: string;
  badge?: string;
}

/**
 * 侧边栏只留「去哪听什么」的入口。
 *
 * 搜索页没有页内输入框了，搜索统一走顶栏，所以这里不再需要「搜索」；
 * 设备（遥控）挪到播放条上；一起听只留这一个入口，房间进行中时在入口上挂房间码。
 */
const navItems: NavItem[] = [
  { name: 'home', label: '发现', icon: 'home', to: '/' },
  { name: 'library', label: '音乐库', icon: 'library', to: '/library' },
  { name: 'together', label: '一起听', icon: 'users', to: '/together' },
];

const route = useRoute();
const router = useRouter();
const toast = useToast();
const room = useRoomStore();
const library = useLibraryStore();
const offline = useOfflineStore();

type LibraryTab = 'favorites' | 'history' | 'downloads';

/** 快捷入口直接复用音乐库的四个分栏，不另建数据源。 */
const shortcuts = computed<Array<{ tab: LibraryTab; label: string; icon: string; count: number }>>(
  () => [
    { tab: 'favorites', label: '喜欢', icon: 'heart', count: library.favorites.length },
    { tab: 'history', label: '最近播放', icon: 'clock', count: library.history.length },
    { tab: 'downloads', label: '本地和下载', icon: 'download', count: offline.items.length },
  ],
);

/** 侧栏不依赖「音乐库」页先被打开过，自己拉一次数据。 */
onMounted(() => {
  if (library.playlists.length === 0) {
    library.loadPlaylists().catch(() => {
      // 网关不可达时侧栏不显示歌单组。
    });
  }
  if (library.favorites.length === 0) library.loadFavorites().catch(() => {});
  if (library.history.length === 0) library.loadHistory().catch(() => {});
  if (offline.items.length === 0) void offline.load();
});

/** 新建 / 编辑歌单共用一个弹窗：不传 playlist 是新建，传了就是编辑。 */
const dialogOpen = ref(false);
const dialogPlaylist = ref<Playlist | null>(null);

function openCreate(): void {
  dialogPlaylist.value = null;
  dialogOpen.value = true;
}

function closeDialog(): void {
  dialogOpen.value = false;
  dialogPlaylist.value = null;
}

function onPlaylistCreated(playlist: Playlist): void {
  openPlaylist(playlist.id);
}

function onPlaylistSaved(): void {
  toast.success('歌单信息已更新');
}

/** macOS 的红绿灯占着左上角，品牌行要给它让位。 */
const isMac = window.sakura.platform === 'darwin';

const activeName = computed(() => String(route.name ?? ''));

function go(item: NavItem): void {
  if (item.to) {
    void router.push(item.to);
    return;
  }
  // 兜底：没有 `to` 的项还没做，点一下给个明确说法（当前各项都已接入）。
  toast.info(`${item.label}即将接入`);
}

function openPlaylist(id: string): void {
  void router.push({ name: 'playlist', params: { id } });
}

function isActivePlaylist(id: string): boolean {
  return activeName.value === 'playlist' && String(route.params.id ?? '') === id;
}

/* ----------------------- 歌单右键 / 三点菜单 ----------------------- */
interface PlaylistMenuState {
  id: number;
  playlist: Playlist;
  x: number;
  y: number;
}

const menu = ref<PlaylistMenuState | null>(null);
// 侧栏歌单菜单同理：菜单开着时把顶栏的拖动区降级，点它才能收起菜单。
usePopoverDragGuard(() => menu.value !== null);
let menuSeq = 0;
const MENU_WIDTH = 170;
const MENU_GAP = 6;

function openMenu(playlist: Playlist, x: number, y: number): void {
  menu.value = { id: ++menuSeq, playlist, x, y };
}

/** 点三点：贴着按钮下方、右边缘对齐；再点同一行就收起。 */
function openFromButton(playlist: Playlist, event: Event): void {
  if (menu.value?.playlist.id === playlist.id) {
    menu.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(playlist, rect.right - MENU_WIDTH, rect.bottom + MENU_GAP);
}

/** 右键：菜单直接落在鼠标位置。 */
function openFromContext(playlist: Playlist, event: MouseEvent): void {
  openMenu(playlist, event.clientX, event.clientY);
}

function closeMenu(): void {
  menu.value = null;
}

function onMenuOpen(playlist: Playlist): void {
  openPlaylist(playlist.id);
}

function onMenuEdit(playlist: Playlist): void {
  dialogPlaylist.value = playlist;
  dialogOpen.value = true;
}

/** 删除走确认弹窗，和歌单详情页一致；停在已删歌单页时回音乐库。 */
const deleteTarget = ref<Playlist | null>(null);
const deleteOpen = ref(false);
const deleting = ref(false);

const deleteMessage = computed(() => {
  const target = deleteTarget.value;
  if (!target) return '';
  return `「${target.name}」以及里面的 ${target.trackCount} 首记录会一并移除，该操作不可恢复。`;
});

function onMenuDelete(playlist: Playlist): void {
  deleteTarget.value = playlist;
  deleteOpen.value = true;
}

function closeDelete(): void {
  if (deleting.value) return;
  deleteOpen.value = false;
  deleteTarget.value = null;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;

  deleting.value = true;
  try {
    await library.deletePlaylist(target.id);
    toast.success('歌单已删除');
    deleteOpen.value = false;
    deleteTarget.value = null;
    if (isActivePlaylist(target.id)) void router.replace({ name: 'library' });
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '删除歌单失败');
  } finally {
    deleting.value = false;
  }
}

/** 三个快捷入口现在各有独立页面。 */
function openShortcut(tab: LibraryTab): void {
  void router.push({ name: tab });
}

function isActiveShortcut(tab: LibraryTab): boolean {
  return activeName.value === tab;
}
</script>

<template>
  <aside class="sidebar">
    <!--
      品牌行跟着侧边栏走，而不是单独占一条横贯窗口的标题栏：
      整窗只有「侧边栏 | 内容区」这一道竖线，顶部不再有横线切一刀。
    -->
    <div class="brand drag" :class="{ 'is-mac': isMac }">
      <img class="brand-mark" :src="brandIcon" alt="" draggable="false" />
      <span class="brand-name">Sakura Music</span>
    </div>

    <nav class="nav" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.name"
        type="button"
        class="nav-item"
        :class="{ active: activeName === item.name, upcoming: !item.to }"
        :aria-current="activeName === item.name ? 'page' : undefined"
        @click="go(item)"
      >
        <span class="nav-indicator" />
        <AppIcon :name="item.icon" :size="18" />
        <span class="nav-label">{{ item.label }}</span>
        <!-- 一起听进行中时只挂一个状态点：在房间里 / 正在播放 -->
        <span
          v-if="item.name === 'together' && room.active"
          class="room-live"
          :class="{ playing: room.playing }"
          :title="room.playing ? '一起听 · 正在播放' : '一起听 · 房间进行中'"
          aria-hidden="true"
        />
      </button>
    </nav>

    <!-- 与 QQ / web 端一致的快捷入口：喜欢、最近播放、本地和下载，带数量 -->
    <nav class="nav shortcuts" aria-label="我的音乐">
      <button
        v-for="entry in shortcuts"
        :key="entry.tab"
        type="button"
        class="nav-item"
        :class="{ active: isActiveShortcut(entry.tab) }"
        @click="openShortcut(entry.tab)"
      >
        <span class="nav-indicator" />
        <AppIcon :name="entry.icon" :size="18" />
        <span class="nav-label">{{ entry.label }}</span>
        <span v-if="entry.count > 0" class="nav-count">{{ entry.count }}</span>
      </button>
    </nav>

    <!-- 我的歌单：侧栏直接列出并可新建，音乐库页只保留平台账号 -->
    <section class="playlist-group">
      <div class="group-head">
        <p class="group-title">我的歌单</p>
        <button type="button" class="group-add" title="新建歌单" @click="openCreate">
          <AppIcon name="plus" :size="12" />
        </button>
      </div>

      <nav v-if="library.playlists.length > 0" class="playlist-nav" aria-label="我的歌单">
        <button
          v-for="playlist in library.playlists"
          :key="playlist.id"
          type="button"
          class="playlist-item"
          :class="{
            active: isActivePlaylist(playlist.id),
            'menu-open': menu?.playlist.id === playlist.id,
          }"
          :title="playlist.name"
          @click="openPlaylist(playlist.id)"
          @contextmenu.prevent="openFromContext(playlist, $event)"
        >
          <span class="playlist-cover" :class="{ empty: !playlist.cover }">
            <img
              v-if="playlist.cover"
              :src="cachedImage(playlist.cover)"
              alt=""
              loading="lazy"
            />
            <AppIcon v-else name="list" :size="12" />
          </span>
          <span class="playlist-name">{{ playlist.name }}</span>
          <!-- span 而非 button：外层已是 button，嵌套按钮是非法 HTML。 -->
          <span
            class="playlist-more-trigger"
            role="button"
            tabindex="0"
            :aria-label="`「${playlist.name}」的更多操作`"
            @click.stop="openFromButton(playlist, $event)"
            @keydown.enter.stop.prevent="openFromButton(playlist, $event)"
            @keydown.space.stop.prevent="openFromButton(playlist, $event)"
          >
            <AppIcon name="more" :size="14" />
          </span>
        </button>
      </nav>

      <p v-else class="group-empty">还没有歌单，点右上角的 + 新建一个。</p>
    </section>

    <PlaylistDialog
      :visible="dialogOpen"
      :playlist="dialogPlaylist"
      @close="closeDialog"
      @created="onPlaylistCreated"
      @saved="onPlaylistSaved"
    />

    <ConfirmDialog
      :visible="deleteOpen"
      title="删除歌单"
      :message="deleteMessage"
      confirm-label="删除"
      danger
      :busy="deleting"
      @close="closeDelete"
      @confirm="confirmDelete"
    />

    <!-- 菜单自己 Teleport 到 body，这里只按 key 控制开关。 -->
    <PlaylistMoreMenu
      v-if="menu"
      :key="menu.id"
      :playlist="menu.playlist"
      :x="menu.x"
      :y="menu.y"
      @close="closeMenu"
      @open="onMenuOpen"
      @edit="onMenuEdit"
      @delete="onMenuDelete"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  min-height: 0;
  /* 顶部不留内边距：品牌行自己撑满 --titlebar-h，与右侧顶栏同高。 */
  padding: 0 14px 16px;
  border-right: 1px solid var(--border);
  /* 明确的浅灰底：整窗只有左右分层，靠这道色差把两列分开（不靠顶栏横线）。 */
  background: var(--bg-soft);
}

/*
 * 品牌行：既显示 logo，也承担窗口拖动区（负 margin 让它铺满侧边栏整个宽度，
 * 否则左右各 12px 是真空的，拖不动窗口）。
 */
.brand {
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: center;
  /* 图标缩小后收一点间距，品牌行的视觉重心不会散。 */
  gap: 10px;
  /*
   * 负 margin 铺满侧边栏整宽（拖动区）。
   * 上下不对称：上 16px 让 logo 离窗口顶边更远一点，下留 6px 收住，
   * 品牌块重心略低于右侧顶栏，和网易云那种「logo 稍微靠下」的观感一致。
   */
  margin: 0 -14px 14px;
  padding: 18px 18px 6px;
}

.brand.is-mac {
  padding-left: 88px;
}

/*
 * 品牌标识：直接显示应用图标，不再另加渐变底板。
 * 投影用 drop-shadow 而不是 box-shadow——前者跟着图片的 alpha 走，
 * 图标圆角外的透明区域不会被投成方块阴影。
 */
.brand-mark {
  width: 36px;
  height: 36px;
  flex: none;
  filter: drop-shadow(0 4px 9px rgba(15, 23, 42, 0.16));
  user-select: none;
}

.brand-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.015em;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 快捷入口与主导航之间用淡线分隔，和「我的歌单」那一层保持一致。 */
.shortcuts {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 42px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 620;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.nav-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--text);
}

.nav-item.active :deep(svg) {
  color: var(--accent);
}

.nav-indicator {
  position: absolute;
  left: -12px;
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.nav-item.active .nav-indicator {
  opacity: 1;
}

.nav-label {
  flex: 1;
}

/* 快捷入口的数量：弱化到注脚级，不抢主导航的注意力。 */
.nav-count {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.nav-item.active .nav-count {
  color: var(--text-muted);
}

.nav-badge {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.nav-item.upcoming {
  color: var(--text-faint);
}

.nav-item.upcoming .nav-badge {
  color: var(--text-faint);
}

/* ---------------------------- 我的歌单 ---------------------------- */
.playlist-group {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  margin-top: 6px;
  /* 与上方主导航之间用一条淡线分隔，视觉上成为独立一层。 */
  border-top: 1px solid var(--border);
}

.group-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 14px 6px 8px 10px;
}

.group-title {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.group-add {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.group-add:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.group-empty {
  padding: 2px 10px 8px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.6;
}

/* 歌单再多也只让这一段滚，品牌与主导航不动。 */
.playlist-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding-bottom: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.playlist-item {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 600;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.playlist-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.playlist-item.active {
  background: var(--accent-soft);
  color: var(--text);
}

.playlist-cover {
  display: grid;
  flex: none;
  width: 26px;
  height: 26px;
  place-items: center;
  overflow: hidden;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-faint);
  /* 细内描边让浅色封面不至于糊进侧栏背景。 */
  box-shadow: inset 0 0 0 1px var(--border);
}

/* 没有封面的歌单：用强调色做一层很淡的渐变底，比纯灰块更有点缀感。 */
.playlist-cover.empty {
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--accent) 24%, var(--surface)),
    var(--surface)
  );
  color: color-mix(in srgb, var(--accent) 65%, var(--text));
}

.playlist-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.playlist-name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 三点与曲目行统一：平时藏着，hover / 聚焦 / 菜单打开时才显形。 */
.playlist-more-trigger {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.playlist-item:hover .playlist-more-trigger,
.playlist-item:focus-within .playlist-more-trigger,
.playlist-item.menu-open .playlist-more-trigger {
  opacity: 1;
}

.playlist-more-trigger:hover,
.playlist-more-trigger:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
}

/* 房间状态点：灰色 = 房间在但没在放，强调色 = 正在播放 */
.room-live {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--text-faint);
}

.room-live.playing {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
</style>
