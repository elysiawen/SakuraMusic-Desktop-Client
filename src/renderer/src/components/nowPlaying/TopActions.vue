<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import QueueButton from '@/components/layout/QueueButton.vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import { cachedImage } from '@/utils/cacheImage';
import ModePicker from './ModePicker.vue';
import { nowPlayingModeDef } from './nowPlayingModes';

/**
 * 全屏播放页的顶栏内容：左边「收起 + 播放状态徽标 + 弹出」，右边「样式菜单 /
 * 队列 / 窗口按钮」。所有播放页样式共享，唯一的一份。
 *
 * 播放页样式的约定是「一个文件自治整个页面」——背景、歌词排版、底部播放条
 * 都归样式自己发挥；唯独顶栏这条保持统一，新样式把 `<TopActions />`
 * 放进自己的 `<header class="... drag">` 就行，不要自己重写。样式自己的额外
 * 动作走 `#extra` 插槽，统一排在样式菜单左边。
 *
 * 根元素刻意不带 `no-drag`：两侧操作区之间的留白仍是窗口拖动区，标题栏上的
 * 双击最大化也照常；两个操作区各自 `no-drag` 并拦下双击，免得点按钮触发最大化。
 *
 * 窗口按钮只在 Windows/Linux 出现（macOS 的红绿灯在左边，由系统画）。
 */
const ui = useUiStore();
const player = usePlayerStore();
const room = useRoomStore();
const router = useRouter();

const isMac = window.sakura.platform === 'darwin';
/** 弹出式播放窗口里不显示播放列表以外的页面动作。 */
const isPopOut = new URLSearchParams(window.location.search).get('window') === 'nowplaying';
/** 深色场景（沉浸/雾笺/绘光/町景）的浮层要跟着场景走深色，不是跟全局主题。 */
const stageTone = computed(() => nowPlayingModeDef(ui.nowPlayingMode).stageTone);
const maximized = ref(false);
let unsubscribeMaximized: (() => void) | null = null;

/** 徽标文案的状态口径与各模式的播放按钮一致：占着一起听席位就看房间的状态。 */
const roomSeat = computed(() => room.seatActive);
const shownPlaying = computed(() => (roomSeat.value ? room.playing : player.playing));

/** 头像取昵称首字兜底（对方没设置头像时）。 */
function initial(nickname: string): string {
  return nickname.trim().slice(0, 1) || '友';
}

/* ---------------- 悬浮窗 ---------------- */

const tipOpen = ref(false);
const tipTick = ref(0);
let tipTimer: number | undefined;

const partnerOnline = computed(() => room.partner?.online === true);

/** 秒 → 「30 分钟」/「7 小时 11 分钟」：悬浮窗里的时长口径，不是播放进度那种 0:30。 */
function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return '不到 1 分钟';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes} 分钟`;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** 悬浮窗里的两段时长：本次 / 累计，悬停期间每秒跟一下。 */
const tipSession = computed(() => {
  void tipTick.value;
  return formatSpan(room.togetherSessionLive());
});
const tipTotal = computed(() => {
  void tipTick.value;
  return formatSpan(room.togetherLive());
});

function showTip(): void {
  tipOpen.value = true;
  if (tipTimer !== undefined) return;
  tipTimer = window.setInterval(() => {
    tipTick.value += 1;
  }, 1000);
}

function hideTip(): void {
  tipOpen.value = false;
  if (tipTimer === undefined) return;
  window.clearInterval(tipTimer);
  tipTimer = undefined;
}

/**
 * 点一起听徽标去一起听页面。
 *
 * 覆盖层里顺手收起播放页；弹出窗口里自己做不了主，只把路由交给主窗口，
 * 自己保持开着（播放页全局只有一份，别点一下徽标就把播放窗口关掉）。
 */
function openTogether(): void {
  if (isPopOut) {
    window.sakura.nowPlaying.sendCommand({ type: 'navigate', path: '/together' });
    return;
  }
  ui.closeLyrics();
  void router.push('/together');
}

/**
 * 收起按钮，覆盖层与弹出窗口共用（行为按窗口区分）：
 * 覆盖层里 =「收起歌词（Esc）」，关掉覆盖层而已；
 * 弹出窗口里 =「缩回播放器」——弹出模式结束，播放页回到主程序的覆盖层里。
 * 只关窗口（X / Esc）不算数：下次打开还是弹出。
 */
function collapse(): void {
  if (!isPopOut) {
    ui.closeLyrics();
    return;
  }
  // 缩回播放器：先告诉主窗口收摊（清弹出模式、开覆盖层），再关掉自己。
  window.sakura.nowPlaying.sendCommand({ type: 'popIn' });
  void window.sakura.nowPlaying.closeWindow();
}

/** 弹出为独立窗口：播放页全局只有一份，弹出后主窗口里的覆盖层随即收起。 */
async function popOut(): Promise<void> {
  // 先记住弹出模式：此后封面点击 / L 一律去独立窗口，不再叠覆盖层。
  ui.nowPlayingPoppedOut = true;
  await window.sakura.nowPlaying.open(nowPlayingModeDef(ui.nowPlayingMode).stageTone === 'dark');
  ui.closeLyrics();
}

function minimize(): void {
  void window.sakura.windowControls.minimize();
}

async function toggleMaximize(): Promise<void> {
  if (isMac) return;
  maximized.value = await window.sakura.windowControls.toggleMaximize();
}

function close(): void {
  void window.sakura.windowControls.close();
}

onMounted(() => {
  if (!isMac) {
    void window.sakura.windowControls.isMaximized().then((value) => {
      maximized.value = value;
    });
    unsubscribeMaximized = window.sakura.windowControls.onMaximizedChange((value) => {
      maximized.value = value;
    });
  }
});

onBeforeUnmount(() => {
  unsubscribeMaximized?.();
  hideTip();
});
</script>

<template>
  <!-- 根元素是标题栏的拖动区，两簇按钮各自 no-drag 接管点按 -->
  <div class="np-topbar">
    <div class="np-top-left no-drag" @dblclick.stop>
      <button
        type="button"
        class="btn-icon"
        :title="isPopOut ? '缩回播放器' : '收起歌词（Esc）'"
        @click="collapse"
      >
        <AppIcon :name="isPopOut ? 'pop-in' : 'chevron-down'" :size="isPopOut ? 18 : 20" />
      </button>
      <!-- 一起听：两个头像 + 回形针连接，点了去一起听页面；其余状态仍是「播放中 / 暂停」小胶囊 -->
      <span v-if="roomSeat" class="np-together-wrap" @mouseenter="showTip" @mouseleave="hideTip">
        <button
          type="button"
          class="np-together"
          aria-haspopup="true"
          @click="openTogether"
          @focus="showTip"
          @blur="hideTip"
        >
          <span class="np-avatar is-me">
            <img
              v-if="room.accountMember?.avatar"
              :src="cachedImage(room.accountMember.avatar)"
              alt=""
            />
            <template v-else>{{ initial(room.accountMember?.nickname ?? '我') }}</template>
          </span>
          <span class="np-clip" aria-hidden="true">
            <AppIcon name="paperclip" :size="13" />
          </span>
          <span class="np-avatar" :class="{ 'is-empty': !room.partner }">
            <img v-if="room.partner?.avatar" :src="cachedImage(room.partner.avatar)" alt="" />
            <template v-else-if="room.partner">{{ initial(room.partner.nickname) }}</template>
            <AppIcon v-else name="user" :size="11" />
          </span>
        </button>
        <!-- 悬浮窗：两人对置 + 链接状态 + 本次/累计时长，和一起听页面同一套信息 -->
        <transition name="np-tip">
          <span
            v-if="tipOpen"
            class="np-tip popover"
            :class="{ 'is-dark': stageTone === 'dark' }"
            role="tooltip"
          >
            <span class="np-tip-pair">
              <span class="np-tip-side">
                <span class="np-tip-avatar is-me">
                  <img
                    v-if="room.accountMember?.avatar"
                    :src="cachedImage(room.accountMember.avatar)"
                    alt=""
                  />
                  <template v-else>{{ initial(room.accountMember?.nickname ?? '我') }}</template>
                </span>
                <strong>{{ room.accountMember?.nickname ?? '我' }}</strong>
                <small>{{ room.accountMember?.deviceName ?? '本机' }}</small>
              </span>

              <span class="np-tip-link" :class="{ live: partnerOnline }">
                <AppIcon name="link" :size="12" />
                <span>{{ partnerOnline ? '同步中' : room.partner ? '等待重连' : '等待中' }}</span>
              </span>

              <span class="np-tip-side">
                <template v-if="room.partner">
                  <span class="np-tip-avatar" :class="{ offline: !partnerOnline }">
                    <img v-if="room.partner.avatar" :src="cachedImage(room.partner.avatar)" alt="" />
                    <template v-else>{{ initial(room.partner.nickname) }}</template>
                    <span class="np-tip-dot" :class="{ on: partnerOnline }" />
                  </span>
                  <strong>{{ room.partner.nickname }}</strong>
                  <small>{{ partnerOnline ? room.partner.deviceName : '暂时离线' }}</small>
                </template>
                <template v-else>
                  <span class="np-tip-avatar is-empty">
                    <AppIcon name="user" :size="14" />
                  </span>
                  <strong>等待好友</strong>
                  <small>把房间码发给 TA</small>
                </template>
              </span>
            </span>

            <span class="np-tip-stats">
              <span class="np-tip-stat">
                <span class="np-tip-stat-label">
                  <AppIcon name="clock" :size="12" />
                  本次
                </span>
                <b>{{ tipSession }}</b>
              </span>
              <span class="np-tip-stat">
                <span class="np-tip-stat-label">
                  <AppIcon name="refresh" :size="12" />
                  累计
                </span>
                <b>{{ tipTotal }}</b>
              </span>
            </span>
          </span>
        </transition>
      </span>
      <span v-else class="np-badge">
        <span class="eq" :class="{ 'is-playing': shownPlaying }" aria-hidden="true">
          <i /><i /><i />
        </span>
        {{ shownPlaying ? '播放中' : '暂停' }}
      </span>
      <button
        v-if="!isPopOut"
        type="button"
        class="btn-icon"
        title="弹出为独立窗口"
        @click="popOut"
      >
        <AppIcon name="external" :size="18" />
      </button>
    </div>

    <div class="np-top-actions no-drag" @dblclick.stop>
      <!-- 样式自己的动作（如町景的取景）：排在样式菜单左边，以后有多余按钮就往这里加 -->
      <slot name="extra" />
      <!-- 样式菜单：注册表里有多少种播放页样式，这里就列多少种 -->
      <ModePicker :stage-tone="stageTone" />
      <!-- 队列：这里在页面顶部，面板必须向下弹（弹出窗口里也保留） -->
      <QueueButton placement="down" :size="18" :stage-tone="stageTone" />

      <template v-if="!isMac">
        <span class="action-divider" aria-hidden="true" />
        <div class="window-controls">
          <button class="window-button" type="button" aria-label="最小化" @click="minimize">
            <AppIcon name="minimize" :size="15" />
          </button>
          <button
            class="window-button"
            type="button"
            :aria-label="maximized ? '还原' : '最大化'"
            @click="toggleMaximize"
          >
            <AppIcon :name="maximized ? 'restore' : 'maximize'" :size="13" />
          </button>
          <button class="window-button is-close" type="button" aria-label="关闭" @click="close">
            <AppIcon name="close" :size="15" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 整条顶栏内容铺满标题栏：两侧收着按钮，中间留白归拖动区。 */
.np-topbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
}

.np-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 播放状态徽标：常驻的「播放中 / 暂停 / 一起听中」小胶囊，带一个跳动的均衡器。 */
.np-badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 14px 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-strong) 72%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

/* 悬浮窗的定位锚点：卡片挂在胶囊下方。 */
.np-together-wrap {
  position: relative;
  display: inline-flex;
}

/* 一起听徽标：和小胶囊同款外框，里面是两个圆形头像 + 中间竖立的回形针。 */
.np-together {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-strong) 72%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.np-together:hover {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-strong) 88%, transparent);
}

.np-together:active {
  transform: scale(0.97);
}

.np-avatar {
  display: grid;
  width: 28px;
  height: 28px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
}

/* 本机头像描一圈主题色边，和对方区分开。 */
.np-avatar.is-me {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.np-avatar.is-empty {
  border-style: dashed;
  color: var(--text-faint);
}

.np-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.np-clip {
  display: inline-flex;
  color: var(--text-muted);
}

/*
 * 悬浮窗：和 .popover 一样的分层背景（surface-strong 叠在 bg-elevated 上），
 * 深色播放页走 is-dark，别让半透明的玻璃底透出背后的封面。
 * 布局是两人对置 + 链接状态 + 本次/累计时长；别挡鼠标，免得悬停抖动。
 */
.np-tip {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  display: flex;
  width: 272px;
  flex-direction: column;
  padding: 14px 16px 12px;
  border-radius: var(--radius-md);
  pointer-events: none;
}

/* is-dark 只带深色文字/边框变量，在线点用深色场景的绿。 */
.np-tip.is-dark {
  --success: var(--dark-success);
}

.np-tip-pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}

.np-tip-side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  text-align: center;
}

.np-tip-side strong {
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.np-tip-side small {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.np-tip-avatar {
  position: relative;
  display: grid;
  width: 42px;
  height: 42px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--accent);
  font-size: 15px;
  font-weight: 650;
}

.np-tip-avatar.is-me {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.np-tip-avatar.offline {
  opacity: 0.55;
}

.np-tip-avatar.is-empty {
  border-style: dashed;
  color: var(--text-faint);
}

.np-tip-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 头像右下角的在线点，和一起听页面的两人对置一致。 */
.np-tip-dot {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--surface-strong);
  border-radius: 50%;
  background: var(--border-strong);
}

.np-tip-dot.on {
  background: var(--success);
}

.np-tip-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

.np-tip-link.live {
  color: var(--accent);
}

/* 统计两行：标签在左、时长在右，数值用主题色强调。 */
.np-tip-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.np-tip-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.np-tip-stat-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.np-tip-stat b {
  margin-left: auto;
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 650;
}

.np-tip-enter-active,
.np-tip-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.np-tip-enter-from,
.np-tip-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.eq {
  display: inline-flex;
  height: 12px;
  align-items: flex-end;
  gap: 2.5px;
}

.eq i {
  width: 2.5px;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  transition: height 0.2s ease;
}

.eq.is-playing i {
  animation: eq-bounce 900ms ease-in-out infinite alternate;
}

.eq.is-playing i:nth-child(2) {
  animation-delay: 180ms;
}

.eq.is-playing i:nth-child(3) {
  animation-delay: 360ms;
}

@keyframes eq-bounce {
  from {
    height: 3px;
  }
  to {
    height: 12px;
  }
}

.np-top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 页面操作与窗口按钮之间的一道竖线 */
.action-divider {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--border-strong);
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-right: -2px;
}

.window-button {
  display: grid;
  width: 36px;
  height: 30px;
  place-items: center;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.window-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.window-button.is-close:hover {
  background: #e5484d;
  color: #fff;
}
</style>
