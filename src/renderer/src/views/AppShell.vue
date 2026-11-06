<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SakuraPetals from '@/components/common/SakuraPetals.vue';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import { nowPlayingModeDef } from '@/components/nowPlaying/nowPlayingModes';
import { initNowPlayingHost } from '@/nowPlaying/host';
import PlayerBar from '@/components/layout/PlayerBar.vue';
import TitleBar from '@/components/layout/TitleBar.vue';
import { useTransport } from '@/composables/useTransport';
import { useDevicesStore } from '@/stores/devices';
import { useLibraryStore } from '@/stores/library';
import { useOfflineStore } from '@/stores/offline';
import { usePlayerStore } from '@/stores/player';
import { usePreferencesStore } from '@/stores/preferences';
import { useRoomStore } from '@/stores/room';
import { useThemeStore } from '@/stores/theme';
import { useUiStore } from '@/stores/ui';

const theme = useThemeStore();
const player = usePlayerStore();
const transport = useTransport();
const library = useLibraryStore();
const offline = useOfflineStore();
const devices = useDevicesStore();
const preferences = usePreferencesStore();
const room = useRoomStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

// 弹出式播放窗口的宿主桥：推快照、收命令、接管「打开全屏歌词」的入口
// （独立窗口开着时点封面是把它叫到最前，播放页全局只有一份）。
initNowPlayingHost();

/** 起播时写一条播放历史；记录失败不影响播放，store 内部已吞掉异常。 */
watch(
  () => (player.playing ? player.current : null),
  (track) => {
    if (track) void library.recordPlay(track);
  },
);

/** 输入框或按钮上按空格应该走各自的默认行为，不该被全局快捷键抢走。 */
function ownsSpace(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    element.isContentEditable
  );
}

function focusSearch(): void {
  window.dispatchEvent(new CustomEvent('sakura:focus-search'));
}

async function onKeydown(event: KeyboardEvent): Promise<void> {
  // 全屏歌词页自己接管键盘（Esc 收起、空格播放、左右跳转），这里不要再抢一遍。
  if (ui.lyricsOpen) return;

  if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'k')) {
    event.preventDefault();
    if (route.name === 'search') {
      focusSearch();
      return;
    }
    // 搜索页是懒加载的，等它挂上 focus-search 的监听再派发。
    await router.push({ name: 'search' });
    window.setTimeout(focusSearch, 90);
    return;
  }

  if (event.repeat || ownsSpace(event.target)) return;

  switch (event.code) {
    case 'Space':
      event.preventDefault();
      transport.toggle();
      return;
    case 'ArrowLeft':
      event.preventDefault();
      transport.seek(Math.max(0, player.currentTime - 5));
      return;
    case 'ArrowRight':
      event.preventDefault();
      transport.seek(player.currentTime + 5);
      return;
    case 'ArrowUp':
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      player.setVolume(Math.min(1, player.volume + 0.05));
      return;
    case 'ArrowDown':
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      player.setVolume(Math.max(0, player.volume - 0.05));
      return;
    case 'KeyM':
      player.toggleMute();
      return;
    case 'KeyN':
      transport.next();
      return;
    case 'KeyP':
      transport.prev();
      return;
    case 'KeyL':
      ui.toggleLyrics();
      return;
    case 'KeyQ':
      ui.toggleQueue();
      return;
    default:
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  // 平台开关与静态能力：拉一次云端配置，失败时用本地快照顶着。
  void preferences.ensureInitialized();
  // 本地下载索引：播放器据此决定是走本地文件还是在线取流。
  void offline.load();
  // 下载进度 SSE：只在主壳活着时订阅，退出时断开。
  offline.connectProgress();
  // 一起听：先挂上房间事件的订阅与「重连后对账」，再连设备（房间事件走同一条 SSE）。
  room.init();
  // 设备长连接：在线即代表可被遥控，同时每秒上报本机播放状态。
  void devices.connect();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  offline.disconnectProgress();
  devices.disconnect();
});
</script>

<template>
  <div class="app-shell">
    <SakuraPetals v-if="theme.petals" />

    <!--
      左右分层：侧边栏（含品牌行）占左边一整列，右边是「顶栏 + 内容」。
      顶部不再有横线把窗口切成上下两半，整窗只有侧边栏那道竖线。
    -->
    <div class="app-body">
      <AppSidebar />

      <div class="app-main">
        <TitleBar />
        <main class="app-content">
          <RouterView v-slot="{ Component }">
            <!--
              只缓存搜索页：用户从搜索跳到歌手主页、再点返回时，搜索词、结果、
              当前 tab 和分页都要原封不动。其它详情页（artist/album/collection）
              不在 include 里，照常卸载重建 —— 参数变了本来就要重新拉数据。
            -->
            <keep-alive include="SearchView">
              <component :is="Component" />
            </keep-alive>
          </RouterView>
        </main>
      </div>
    </div>

    <PlayerBar />

    <!--
      全屏歌词：盖住整个窗口（含品牌行与顶栏），页内自带一条同高的标题栏。
      样式（经典 / 沉浸 / 以后追加的）由注册表驱动，页内顶栏的菜单即时切换。
    -->
    <component :is="nowPlayingModeDef(ui.nowPlayingMode).component" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  flex-direction: column;
  overflow: hidden;
}

/* 右侧常驻面板已取消：歌词走全屏覆盖层，队列走播放条弹出的浮层。 */
.app-body {
  display: grid;
  flex: 1;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  min-height: 0;
}

/* 右侧列：顶栏与内容纵向排，顶栏不参与滚动。 */
.app-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.app-content {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 24px 32px 44px;
}

@media (max-width: 1120px) {
  .app-content {
    padding-right: 26px;
  }
}
</style>
