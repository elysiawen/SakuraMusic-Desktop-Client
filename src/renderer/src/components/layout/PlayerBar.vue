<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import { useDesktopLyric } from '@/composables/useDesktopLyric';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useUiStore } from '@/stores/ui';
import { cachedImage } from '@/utils/cacheImage';
import { formatTime, platformName } from '@/utils/format';
import QualityPicker from './QualityPicker.vue';
import QueueButton from './QueueButton.vue';

const player = usePlayerStore();
const room = useRoomStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();
const desktopLyric = useDesktopLyric();

/**
 * 房间里「播放」归服务端管：本机占着席位时，传输控制要提交给房间，
 * 而不是直接改本机播放器——否则两端会各放各的。
 */
const roomSeat = computed(() => room.seatActive);

/** 拖动进度条时的临时值：松手前不让 timeupdate 抢走滑块。 */
const seekDraft = ref<number | null>(null);

const track = computed(() => player.current);
const cover = computed(() => cachedImage(track.value?.album.cover));
const title = computed(() => track.value?.title ?? '未在播放');
const subtitle = computed(() => {
  if (!track.value) return '搜索一首歌开始';
  const names = track.value.artists.map((artist) => artist.name).join(' / ');
  return names || track.value.album.name;
});

const shownTime = computed(() => seekDraft.value ?? player.currentTime);
const duration = computed(() => player.duration || 0);
const progressPercent = computed(() =>
  duration.value > 0 ? Math.min(100, (shownTime.value / duration.value) * 100) : 0,
);

const sourceText = computed(() => {
  const platform = player.activeSource?.platform;
  return platform ? platformName(platform) : '';
});

/** 房间里的模式以房间为准（两端共享），其余情况读本机。 */
const currentMode = computed(() => (roomSeat.value ? room.playback?.mode ?? 'order' : player.mode));

const modeIcon = computed(() => {
  if (currentMode.value === 'one') return 'repeat-one';
  if (currentMode.value === 'all') return 'repeat';
  if (currentMode.value === 'shuffle') return 'shuffle';
  return 'list';
});
const modeLabel = computed(() => {
  if (currentMode.value === 'one') return '单曲循环';
  if (currentMode.value === 'all') return '列表循环';
  if (currentMode.value === 'shuffle') return '随机播放';
  return '顺序播放';
});

const shownPlaying = computed(() => (roomSeat.value ? room.playing : player.playing));

const volumePercent = computed(() => (player.muted ? 0 : Math.round(player.volume * 100)));

function onSeekInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  seekDraft.value = value;
  // 房间里拖动时不立刻改本机音频：真正的位置由服务端确认，松手再提交。
  if (!roomSeat.value) player.seek(value);
}

function onSeekDone(): void {
  const value = seekDraft.value;
  seekDraft.value = null;
  if (value !== null && roomSeat.value) room.seek(value);
}

function onVolumeInput(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value) / 100);
}

function openLyrics(): void {
  ui.openLyrics();
}

function openDevices(): void {
  void router.push('/devices');
}
</script>

<template>
  <footer class="player-bar">
    <div class="player-inner">
      <!-- 左侧：当前歌曲 -->
      <div class="player-left">
        <template v-if="track">
          <!--
            点封面展开歌词页，和 web 端一致：hover 时封面压一层中性黑遮罩，
            中间浮出上箭头，暗示「往上展开」。
          -->
          <button class="cover-button" type="button" title="展开歌词页" @click="openLyrics">
            <span class="cover">
              <img v-if="cover" :src="cover" alt="" />
              <AppIcon v-else name="music" :size="20" :stroke-width="1.5" />
            </span>
            <span class="cover-button-hint" aria-hidden="true">
              <AppIcon name="chevron-up" :size="16" />
            </span>
          </button>
          <div class="now-meta">
            <div class="now-title">
              <strong :title="title">{{ title }}</strong>
              <span v-if="track.vip" class="tag vip">VIP</span>
            </div>
            <small class="muted" :title="subtitle">{{ subtitle }}</small>
          </div>
        </template>
        <div v-else class="now-meta">
          <strong>还没有播放音乐</strong>
          <small class="muted">从搜索或发现页挑一首吧</small>
        </div>
      </div>

      <!-- 中间：控制与进度 -->
      <div class="player-center">
        <div class="transport">
          <button
            type="button"
            class="btn-icon transport-side"
            :class="{ 'is-active': currentMode !== 'order' }"
            :aria-label="modeLabel"
            :title="modeLabel"
            @click="roomSeat ? room.cycleMode() : player.cycleMode()"
          >
            <AppIcon :name="modeIcon" :size="18" />
          </button>

          <button
            type="button"
            class="btn-icon transport-skip"
            aria-label="上一首"
            :disabled="!track"
            @click="roomSeat ? room.prev() : player.prev()"
          >
            <AppIcon name="prev" :size="21" filled />
          </button>

          <!-- 主播放键：整条控制区里唯一的强调色 -->
          <button
            type="button"
            class="play-btn"
            :aria-label="shownPlaying ? '暂停' : '播放'"
            :disabled="!track"
            @click="roomSeat ? room.toggle() : player.toggle()"
          >
            <AppIcon v-if="player.loading" name="refresh" :size="20" class="spin" />
            <AppIcon v-else-if="shownPlaying" name="pause" :size="20" filled />
            <AppIcon v-else name="play" :size="20" filled />
          </button>

          <button
            type="button"
            class="btn-icon transport-skip"
            aria-label="下一首"
            :disabled="!track"
            @click="roomSeat ? room.next() : player.next()"
          >
            <AppIcon name="next" :size="21" filled />
          </button>

          <!-- 音量：与左侧模式按钮对称，滑杆悬停时从上方浮出 -->
          <div class="volume">
            <button
              type="button"
              class="btn-icon transport-side"
              :class="{ 'is-active': player.muted || player.volume === 0 }"
              :aria-label="player.muted ? '取消静音' : '静音'"
              :title="player.muted ? '取消静音' : '静音'"
              @click="player.toggleMute()"
            >
              <AppIcon :name="player.muted || player.volume === 0 ? 'mute' : 'volume'" :size="19" />
            </button>
            <div class="volume-pop">
              <input
                class="range volume-range"
                type="range"
                min="0"
                max="100"
                step="1"
                :value="volumePercent"
                :style="{ '--fill': `${volumePercent}%` }"
                aria-label="音量"
                @input="onVolumeInput"
              />
              <span class="volume-value">{{ volumePercent }}</span>
            </div>
          </div>
        </div>

        <div class="progress-row">
          <span class="progress-time">{{ formatTime(shownTime) }}</span>
          <input
            class="range progress"
            type="range"
            min="0"
            :max="duration || 0"
            step="0.1"
            :value="shownTime"
            :style="{ '--fill': `${progressPercent}%` }"
            :disabled="duration <= 0"
            aria-label="播放进度"
            @input="onSeekInput"
            @change="onSeekDone"
            @pointerup="onSeekDone"
          />
          <span class="progress-time">{{ formatTime(duration) }}</span>
        </div>
      </div>

      <!-- 右侧：音源、音质（可切换）、一起听、设备、队列 -->
      <div class="player-right">
        <span
          v-if="player.usingShared"
          class="tag shared"
          title="正在使用一起听里对方的会员权益播放"
        >
          共享
        </span>
        <span v-if="sourceText" class="tag">{{ sourceText }}</span>

        <QualityPicker />

        <!-- 原来的全屏歌词按钮换成设备：歌词仍可点左侧封面或按 L 打开 -->
        <button
          type="button"
          class="btn-icon"
          :class="{ 'is-active': route.name === 'devices' }"
          aria-label="设备"
          title="设备与遥控"
          @click="openDevices"
        >
          <AppIcon name="monitor" :size="17" />
        </button>

        <button
          type="button"
          class="btn-icon"
          :class="{ 'is-active': desktopLyric.enabled.value }"
          aria-label="桌面歌词"
          title="桌面歌词"
          @click="desktopLyric.toggle"
        >
          <AppIcon name="note" :size="17" />
        </button>

        <!-- 队列放在最右：向上弹出的浮层（右侧常驻面板已经取消） -->
        <QueueButton placement="up" />
      </div>
    </div>
  </footer>
</template>

<style scoped>
/*
 * 播放条：贴着窗口底部的一条，不做卡片、不留边距、不加阴影。
 *
 * 它和内容区是上下两段，不应该看起来「浮在内容上面」——所以只有一条顶部分隔线，
 * 背景与页面同色系，视觉上作为界面的一部分落地。
 */
.player-bar {
  position: relative;
  z-index: 25;
  height: var(--player-h);
  flex: none;
  padding: 0 18px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 84%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.player-inner {
  display: grid;
  height: 100%;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 1.5fr) minmax(0, 1fr);
  align-items: center;
  gap: 16px;
}

/* ---------------- 左：当前歌曲 ---------------- */

.player-left {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.cover-button {
  position: relative;
  display: block;
  flex: none;
  overflow: hidden;
  border-radius: 12px;
  line-height: 0;
  transition: transform var(--dur) var(--ease);
}

.cover-button:hover {
  transform: translateY(-2px);
}

/* 同 web 端：只盖封面这一小块，中性黑不带主题色相，换配色也不会发脏。 */
.cover-button-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}

.cover-button:hover .cover-button-hint {
  opacity: 1;
}

.cover {
  display: grid;
  width: 52px;
  height: 52px;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text-faint);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.now-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.now-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.now-title strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-meta small {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 650;
  white-space: nowrap;
}

.tag.vip {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}

/* 一起听里用的是对方的会员：标一下，否则用户不知道这首为什么能播。 */
.tag.shared {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 中：控制与进度 ---------------- */

.player-center {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

/* 两侧辅助控制（模式 / 音量）：描边弱化，不抢中间实心键的重量。 */
.transport-side {
  color: var(--text-muted);
}

.transport-side:hover {
  color: var(--text);
}

.transport-side.is-active {
  color: var(--accent);
}

.transport-skip {
  width: 38px;
  height: 38px;
  color: var(--text);
}

.transport-skip:hover:not(:disabled) {
  color: var(--accent);
}

/* 主播放键：亮色胶囊（横向比纵向宽） */
.play-btn {
  display: grid;
  width: 62px;
  height: 44px;
  place-items: center;
  border-radius: 999px;
  color: var(--accent-contrast);
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow: 0 12px 26px -14px color-mix(in srgb, var(--accent) 90%, transparent);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    filter 0.18s ease;
}

.play-btn:hover:not(:disabled) {
  transform: scale(1.045);
  filter: saturate(1.08);
  box-shadow: 0 16px 30px -14px color-mix(in srgb, var(--accent) 100%, transparent);
}

.play-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.play-btn:disabled {
  opacity: 0.45;
  box-shadow: none;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.progress-time {
  min-width: 46px;
  color: var(--text-faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

/* ---------------- 通用滑杆（进度 / 音量同款） ---------------- */

.range {
  flex: 1;
  height: 6px;
  appearance: none;
  border-radius: 999px;
  background-image:
    linear-gradient(90deg, var(--accent), var(--accent-2)),
    linear-gradient(var(--border-strong), var(--border-strong));
  background-repeat: no-repeat;
  background-size:
    var(--fill) 100%,
    100% 100%;
  cursor: pointer;
  outline: none;
  transition: height 0.18s ease;
}

.range:disabled {
  cursor: default;
  opacity: 0.5;
}

.range::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 999px;
  background: #fff;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.28),
    0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.range:hover::-webkit-slider-thumb,
.range:active::-webkit-slider-thumb {
  opacity: 1;
  transform: none;
}

/* ---------------- 音量：悬停浮出 ---------------- */

.volume {
  position: relative;
  display: flex;
  align-items: center;
}

.volume-pop {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-strong);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  transform: translate(-50%, 8px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    visibility 0.2s;
}

/* 透明桥接：图标与面板之间有 14px 间隙，没有它鼠标移过去就收起了。 */
.volume-pop::after {
  position: absolute;
  right: 0;
  bottom: -14px;
  left: 0;
  height: 14px;
  content: '';
}

.volume:hover .volume-pop,
.volume-pop:hover {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}

.volume-range {
  width: 104px;
  flex: none;
}

.volume-value {
  min-width: 20px;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ---------------- 右：音源与工具 ---------------- */

.player-right {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.player-right .btn-icon {
  width: 32px;
  height: 32px;
}

.player-right .btn-icon.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}



/* 窄窗口：先丢右侧工具，再丢左侧封面，中间的控制永远保留。 */
@media (max-width: 900px) {
  .player-right {
    gap: 6px;
  }

  .player-right .tag {
    display: none;
  }
}

@media (max-width: 720px) {
  .player-inner {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  }

  .player-left .now-meta {
    display: none;
  }
}
</style>
