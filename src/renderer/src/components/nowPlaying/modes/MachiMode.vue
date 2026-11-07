<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import QualityPicker from '@/components/layout/QualityPicker.vue';
import { usePlayerStore } from '@/stores/player';
import { useUiStore } from '@/stores/ui';
import { formatTime } from '@/utils/format';
import TopActions from '../TopActions.vue';
import { MachiRuntime, type MachiSongContext } from '../machi/createMachiRuntime';
import { normalizeMachiTuning } from '../machi/machiTuning';
import { DEFAULT_LYRIC_RENDER_QUALITY } from '../folia/foliaRenderQuality';
import type { AudioBands, MotionValue, Theme } from '../folia/foliaTypes';
import type { MachiSceneId, MachiTuning } from '../machi/types';
import { useMachiTuningStore } from './machiTuningStore';
import MachiCameraBar from './MachiCameraBar.vue';
import { useTrack } from '../shared/useTrack';
import { useTransport } from '../shared/useTransport';
import { useHotkeys } from '../shared/useHotkeys';
import { useThemeAccent } from '../shared/useThemeAccent';
import { useCoverPalette } from '../shared/useCoverPalette';
import { useFallbackLyric } from '../shared/useFallbackLyric';
import { buildFoliaTheme, toFoliaLines } from '../shared/foliaLyricLines';

/**
 * 町景模式（移植自 Folia 的 Machi）：深夜街角的三维小景——便利店的招牌、
 * 城寨的霓虹、加油站的灯牌；歌词写在场景里的屏上，霓虹随节拍呼吸。
 *
 * 渲染是 WebGL2（three.js，见 machi/ 目录），运行时只有这一个接入点；
 * 上下文丢失时整块重建，不可用时退回只显示当前这句文字。
 * 因为歌词画在场景里，这个样式不支持「点击歌词跳转」，跳转走底部进度条。
 */
const player = usePlayerStore();
const ui = useUiStore();
const machi = useMachiTuningStore();

/** 运行时吃调参快照：别让它拎着 Vue 的响应式代理进 GL 层。 */
function tuningSnapshot(value: MachiTuning = machi.tuning): MachiTuning {
  return JSON.parse(JSON.stringify(value)) as MachiTuning;
}

const {
  shownPlaying,
  currentMode,
  modeIcon,
  track,
  cover,
  title,
  artists,
  albumName,
  sourceText,
  lines,
  hasLyric,
  toggleMaximize,
} = useTrack();

/* ------------------------------ 封面取色 ------------------------------ */

const palette = useCoverPalette(cover);
const { accentCss, accent2Css } = useThemeAccent();

/** 町景是夜色场景：底色固定深色，主题色只进霓虹与招牌。 */
function currentTheme(): Theme {
  return buildFoliaTheme(accentCss.value, accent2Css.value, palette.value);
}

/* ------------------------------ 音频分频 ------------------------------ */

let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
let sampleAt = -1;
const sampled = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };

function attachAnalyser(): void {
  analyserNode = player.attachAnalyser();
  if (analyserNode) freqData = new Uint8Array(analyserNode.frequencyBinCount);
}

/** 一帧内多处读同一份频谱：按秒表缓存 8ms。 */
function sampleAudio(): typeof sampled {
  const now = performance.now();
  if (now - sampleAt < 8) return sampled;
  sampleAt = now;
  if (!analyserNode || !freqData) {
    sampled.power = 0;
    sampled.bass = sampled.lowMid = sampled.mid = sampled.vocal = sampled.treble = 0;
    return sampled;
  }
  analyserNode.getByteFrequencyData(freqData);
  const binHz = analyserNode.context.sampleRate / 2 / analyserNode.frequencyBinCount;
  const read = (fromHz: number, toHz: number): number => {
    const from = Math.max(0, Math.floor(fromHz / binHz));
    const to = Math.min(freqData!.length - 1, Math.ceil(toHz / binHz));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += freqData![i] ?? 0;
    return Math.min(1, sum / ((to - from + 1) * 255));
  };
  sampled.bass = read(20, 160);
  sampled.lowMid = read(160, 400);
  sampled.mid = read(400, 1200);
  sampled.vocal = read(300, 3400);
  sampled.treble = read(3400, 8000);
  sampled.power = Math.min(1, (sampled.bass + sampled.lowMid + sampled.mid + sampled.vocal + sampled.treble) / 5);
  return sampled;
}

const audioPower: MotionValue<number> = { get: () => sampleAudio().power, on: () => () => {} };
const audioBands: AudioBands = {
  bass: { get: () => sampleAudio().bass, on: () => () => {} },
  lowMid: { get: () => sampleAudio().lowMid, on: () => () => {} },
  mid: { get: () => sampleAudio().mid, on: () => () => {} },
  vocal: { get: () => sampleAudio().vocal, on: () => () => {} },
  treble: { get: () => sampleAudio().treble, on: () => () => {} },
};

/* ------------------------------ 歌词与歌曲 ------------------------------ */

const song = computed<MachiSongContext>(() => ({
  seed: track.value?.key ?? 'machi',
  lines: toFoliaLines(lines.value),
  isInstrumental: !hasLyric.value,
  title: track.value?.title ?? '',
  artist: artists.value.map((artist) => artist.name).join('/'),
  album: albumName.value,
}));

/* ------------------------------ 町景运行时 ------------------------------ */

const hostRef = ref<HTMLDivElement | null>(null);
const failed = ref(false);
/** 首个 WebGL 帧渲染出来之前为 true——这期间画布是黑的，用加载动画盖住。 */
const booting = ref(false);
/** 首帧已渲染：画布淡入，避免「突然亮灯」。 */
const live = ref(false);
const shownScene = ref<MachiSceneId>('konbini');
const cameraOpen = ref(false);

let runtime: MachiRuntime | null = null;
let bootToken = 0;
let bootAbort: AbortController | null = null;

function destroyRuntime(): void {
  bootToken += 1;
  bootAbort?.abort();
  bootAbort = null;
  runtime?.destroy();
  runtime = null;
  booting.value = false;
  live.value = false;
}

async function createRuntime(): Promise<void> {
  const host = hostRef.value;
  if (!host) return;
  destroyRuntime();
  if (!ui.lyricsOpen || !track.value) return;

  const token = bootToken;
  const abort = new AbortController();
  bootAbort = abort;
  booting.value = true;
  failed.value = false;
  live.value = false;
  try {
    const created = await MachiRuntime.create({
      host,
      song: song.value,
      theme: currentTheme(),
      tuning: tuningSnapshot(),
      renderQuality: DEFAULT_LYRIC_RENDER_QUALITY,
      currentTime: { get: () => player.preciseTime(), on: () => () => {} },
      audioPower,
      audioBands,
      paused: !shownPlaying.value,
      staticMode: false,
      showText: !cameraOpen.value,
      previewMode: false,
      transparent: false,
      fallbackIcons: ['music'],
      onViewChange: (view, scene) => {
        // 只有「自定义视角」才存；默认构图下拖动后自己回正。
        if (machi.tuning.camera !== 'custom') return;
        machi.patch({ views: { ...machi.tuning.views, [scene]: view } });
      },
      onSceneShown: (scene) => {
        shownScene.value = scene;
      },
      onContextLost: () => {
        // 上下文丢了又回来：整个运行时重建（纹理、着色器都要重来）
        void createRuntime();
      },
      signal: abort.signal,
    });
    if (token !== bootToken) {
      created.destroy();
      return;
    }
    runtime = created;
    runtime.setShowText(!cameraOpen.value);
    booting.value = false;
    live.value = true;
  } catch (error) {
    if (token !== bootToken) return;
    if ((error as DOMException)?.name === 'AbortError') return;
    console.warn('[Machi] 町景启动失败，退回纯文字', error);
    runtime = null;
    booting.value = false;
    failed.value = true;
  }
}

watch(song, (value) => runtime?.swapSong(value));
watch(shownPlaying, (playing) => runtime?.setPaused(!playing));

// 调参改了：运行时按内容比，场景换了就淡出淡入重建，其余热更。
watch(
  () => machi.tuning,
  (value) => {
    previewTuning.value = null;
    runtime?.setTuning(tuningSnapshot(value));
  },
  { deep: true },
);

// 覆盖层用 v-show 挂着：关上时只停循环、不销毁运行时，再次打开直接复用。
watch(
  () => ui.lyricsOpen && !!track.value,
  async (open) => {
    if (!open) {
      cameraOpen.value = false;
      runtime?.setPaused(true);
      return;
    }
    await nextTick();
    if (runtime) {
      runtime.setPaused(!shownPlaying.value);
      if (!shownPlaying.value) runtime.renderOnce();
      return;
    }
    // 建场景、编着色器都是重活，挪到入场这一帧之后再干，点击反馈不打折
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!ui.lyricsOpen || !track.value) return;
    void createRuntime();
  },
  { immediate: true },
);

// 暂停时循环停着，拖动进度要手动补一帧
watch(
  () => player.currentTime,
  () => {
    if (!shownPlaying.value) runtime?.renderOnce();
  },
);

// 封面取色或主题色变了：霓虹与招牌跟着换
watch([palette, accentCss, accent2Css], () => {
  runtime?.setTheme(currentTheme());
});

// 取景条打开时收起歌词，让出画面
watch(cameraOpen, (open) => {
  runtime?.setShowText(!open);
});

const { fallbackText } = useFallbackLyric({
  lines,
  hasLyric,
  hasTrack: computed(() => !!track.value),
  failed,
});

/* ------------------------------ 取景控制条 ------------------------------ */

/** 拖动中的预览值：只推给画面，松手才落盘。 */
const previewTuning = ref<MachiTuning | null>(null);
const effectiveTuning = computed(() => previewTuning.value ?? machi.tuning);

function previewPatch(partial: Partial<MachiTuning>): void {
  previewTuning.value = normalizeMachiTuning({ ...effectiveTuning.value, ...partial });
  runtime?.setTuning(tuningSnapshot(previewTuning.value));
}

function commitPreview(): void {
  const pending = previewTuning.value;
  if (!pending) return;
  previewTuning.value = null;
  machi.tuning = pending;
}

function changeTuning(partial: Partial<MachiTuning>): void {
  previewTuning.value = null;
  machi.patch(partial);
}

function toggleCameraBar(): void {
  cameraOpen.value = !cameraOpen.value;
}

/* ------------------------------ 传输控制 ------------------------------ */

const {
  shownTime,
  duration,
  progressPercent,
  volumePercent,
  toggle,
  prev,
  next,
  cycleMode,
  seekTo,
  onSeekInput,
  onSeekDone,
  onVolumeInput,
} = useTransport();

useHotkeys({ toggle, seekTo });

onMounted(() => {
  attachAnalyser();
});

onBeforeUnmount(() => {
  destroyRuntime();
});
</script>

<template>
  <div class="machi-overlay">
    <!-- 町景的画布由运行时挂进这个宿主（WebGL2；街景、霓虹、歌词屏全在里面） -->
    <div ref="hostRef" class="machi-host" :class="{ live }" aria-hidden="true" />

    <!-- 冷启动：建场景与编着色器期间画布是黑的，用呼吸光盖住，首帧渲染后淡出 -->
    <Transition name="boot">
      <div v-if="booting && !failed" class="machi-boot" aria-hidden="true">
        <span class="boot-mark">
          <AppIcon name="sparkles" :size="24" />
        </span>
        <span class="boot-text">街灯亮起中</span>
      </div>
    </Transition>

    <!-- WebGL2 不可用时的兜底：只显示当前这句 -->
    <div v-if="failed" class="machi-fallback">{{ fallbackText }}</div>

    <!-- 取景控制条（像游戏里的拍照模式）：打开时画面歌词让开 -->
    <MachiCameraBar
      v-if="cameraOpen && !failed"
      :tuning="effectiveTuning"
      :scene="shownScene"
      :on-preview="previewPatch"
      :on-commit="commitPreview"
      :on-tuning-change="changeTuning"
      :on-close="() => (cameraOpen = false)"
    />

    <!-- 页内标题栏：整页盖住窗口，这条带子同时是拖动区 -->
    <header class="machi-top drag" @dblclick="toggleMaximize">
      <!-- 顶栏内容（收起/徽标/弹出 + 右上角操作区）所有播放页样式共享，见 TopActions -->
      <TopActions>
        <!-- 取景：样式自己的动作排在样式菜单左边 -->
        <template #extra>
          <button
            type="button"
            class="btn-icon machi-camera"
            :class="{ 'is-active': cameraOpen }"
            title="取景（调镜头与景深）"
            @click="toggleCameraBar"
          >
            <AppIcon name="viewfinder" :size="18" />
          </button>
        </template>
      </TopActions>
    </header>

    <!-- 中部留给町景：歌词写在场景的屏上，没有 DOM 歌词 -->

    <footer class="machi-controls">
      <!-- 歌曲信息收进底部：街景的舞台不压字 -->
      <div class="machi-meta">
        <span class="meta-cover">
          <img v-if="cover" :src="cover" :alt="title" />
          <AppIcon v-else name="music" :size="16" :stroke-width="1.4" />
        </span>
        <h1 class="meta-title">{{ title }}</h1>
        <p class="meta-sub">
          <template v-if="artists.length === 0">未知歌手</template>
          <template v-for="(artist, artistIndex) in artists" :key="`${artist.name}-${artistIndex}`">
            <RouterLink
              v-if="artist.id && artist.platform"
              class="meta-link"
              :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
              @click="ui.closeLyrics()"
            >
              {{ artist.name }}
            </RouterLink>
            <span v-else>{{ artist.name }}</span>
            <span v-if="artistIndex < artists.length - 1" class="meta-sep">/</span>
          </template>
          <template v-if="albumName">
            <span class="meta-sep">·</span>
            <RouterLink
              v-if="track?.album.id && track?.album.platform"
              class="meta-link"
              :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
              @click="ui.closeLyrics()"
            >
              {{ albumName }}
            </RouterLink>
            <span v-else>{{ albumName }}</span>
          </template>
        </p>
        <span class="meta-tags">
          <span class="meta-tags-inner">
            <span v-if="sourceText" class="tag">{{ sourceText }}</span>
            <QualityPicker placement="down" align="right" />
            <span v-if="player.audioCache === 'full'" class="tag cache">缓存</span>
            <span v-else-if="player.usingDirect" class="tag direct">直连</span>
            <span v-else-if="!player.loading && player.current" class="tag relay">中转</span>
          </span>
        </span>
      </div>

      <!-- 悬停展开区：进度与按键收在这里，鼠标移上浮块才展开 -->
      <div class="chip-expand">
        <div class="chip-expand-inner">
          <div class="progress-row">
            <span class="time">{{ formatTime(shownTime) }}</span>
            <input
              class="range"
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
            <span class="time">{{ formatTime(duration) }}</span>
          </div>

          <div class="transport">
            <button
              type="button"
              class="btn-icon transport-side"
              :class="{ 'is-active': currentMode !== 'order' }"
              :title="currentMode"
              @click="cycleMode"
            >
              <AppIcon :name="modeIcon" :size="18" />
            </button>

            <button type="button" class="btn-icon transport-skip" title="上一首" @click="prev">
              <AppIcon name="prev" :size="21" filled />
            </button>

            <button type="button" class="play-btn" :title="shownPlaying ? '暂停（空格）' : '播放（空格）'" @click="toggle">
              <AppIcon v-if="player.loading" name="refresh" :size="19" class="spin" />
              <AppIcon v-else-if="shownPlaying" name="pause" :size="19" filled />
              <AppIcon v-else name="play" :size="19" filled />
            </button>

            <button type="button" class="btn-icon transport-skip" title="下一首" @click="next">
              <AppIcon name="next" :size="21" filled />
            </button>

            <div class="volume">
              <button
                type="button"
                class="btn-icon transport-side"
                :class="{ 'is-active': player.muted || player.volume === 0 }"
                :title="player.muted ? '取消静音' : '静音'"
                @click="player.toggleMute()"
              >
                <AppIcon :name="player.muted || player.volume === 0 ? 'mute' : 'volume'" :size="19" />
              </button>
              <div class="volume-pop">
                <div class="volume-pop-inner">
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
          </div>

          <div v-if="ui.lyricHints" class="machi-hints">
            <span class="machi-hints-text">
              空格 播放 / 暂停 · <kbd>←</kbd> <kbd>→</kbd> 快退 / 快进 · <kbd>↑</kbd> <kbd>↓</kbd>
              音量 · Esc 收起
            </span>
            <button
              type="button"
              class="hints-close"
              title="不再显示"
              aria-label="不再显示快捷键提示"
              @click="ui.setLyricHints(false)"
            >
              <AppIcon name="close" :size="11" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.machi-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 町景固定深夜氛围：街景画在深天上 */
  --bg: #05070a;
  --text: #f2f3f7;
  --text-muted: rgba(242, 243, 247, 0.64);
  --text-faint: rgba(242, 243, 247, 0.42);
  --border: rgba(255, 255, 255, 0.14);
  --border-strong: rgba(255, 255, 255, 0.24);
  --surface: rgba(255, 255, 255, 0.08);
  --surface-hover: rgba(255, 255, 255, 0.12);
  --surface-strong: rgba(20, 23, 33, 0.82);
  color: var(--text);
  background: #05070a;
}

/* ------------------------------ 町景宿主与兜底 ------------------------------ */

/*
 * 画布入场：首帧渲染前透明；首帧一到，与加载层的淡出交叠，缓慢淡入——
 * 街景是「亮」出来的，不是跳出来的。
 */
.machi-host {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.45s ease;
}

.machi-host.live {
  opacity: 1;
}

.machi-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10vw;
  font-size: clamp(1.8rem, 4.6vw, 4.4rem);
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.55);
}

/* ------------------------------ 顶栏 ------------------------------ */

.machi-top {
  position: relative;
  z-index: 3;
  display: flex;
  height: var(--titlebar-h);
  flex: none;
  align-items: stretch;
}

/* 顶栏里的取景开关：打开时跟样式菜单里的选中态一样点亮 */
.machi-camera.is-active {
  color: var(--accent);
}

/* ------------------------------ 角落浮块控制区（玻璃拟态） ------------------------------ */

.machi-controls {
  position: relative;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: fit-content;
  max-width: min(420px, calc(100% - 36px));
  interpolate-size: allow-keywords;
  transition: width 0.32s var(--ease);
  margin: auto 18px 18px 0;
  align-self: flex-end;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(226, 233, 243, 0.1), rgba(226, 233, 243, 0.055));
  backdrop-filter: blur(26px) saturate(1.1);
  box-shadow:
    0 24px 48px -24px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.machi-meta {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 9px;
}

.chip-expand {
  display: grid;
  width: 100%;
  margin-top: 0;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 0.32s var(--ease),
    margin-top 0.32s var(--ease),
    opacity 0.14s ease;
}

.machi-controls:not(:hover):not(:focus-within) .chip-expand {
  width: 0;
}

.machi-controls:hover,
.machi-controls:focus-within {
  width: min(420px, calc(100% - 36px));
}

.machi-controls:hover .chip-expand,
.machi-controls:focus-within .chip-expand {
  margin-top: 8px;
  grid-template-rows: 1fr;
  opacity: 1;
  transition:
    grid-template-rows 0.32s var(--ease),
    margin-top 0.32s var(--ease),
    opacity 0.26s ease 0.12s;
}

.chip-expand-inner {
  display: flex;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  overflow: hidden;
  transform: translateY(-6px);
  transition: transform 0.32s var(--ease);
}

.machi-controls:hover .chip-expand-inner,
.machi-controls:focus-within .chip-expand-inner {
  transform: translateY(0);
}

.meta-cover {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text-faint);
}

.meta-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.meta-title {
  overflow: hidden;
  max-width: 11em;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sub {
  overflow: hidden;
  max-width: 11em;
  margin: 0;
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-sep {
  margin: 0 5px;
  color: var(--text-faint);
}

.meta-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}

.meta-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.meta-tags {
  display: grid;
  flex: none;
  margin-left: auto;
  grid-template-columns: 0fr;
  opacity: 0;
  transition:
    grid-template-columns 0.32s var(--ease),
    opacity 0.2s ease;
}

.machi-controls:hover .meta-tags,
.machi-controls:focus-within .meta-tags {
  grid-template-columns: 1fr;
  opacity: 1;
}

.meta-tags-inner {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
}

.tag {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.tag.direct {
  border-color: color-mix(in srgb, var(--success) 38%, transparent);
  color: var(--success);
}

.tag.relay {
  border-color: color-mix(in srgb, var(--text-muted) 30%, transparent);
  color: var(--text-muted);
}

.tag.cache {
  border-color: color-mix(in srgb, #6fa0ff 36%, transparent);
  color: #6fa0ff;
}

.meta-tags :deep(.quality-trigger) {
  height: auto;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
}

.progress-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 12px;
}

.time {
  min-width: 38px;
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
}

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
  width: 32px;
  height: 32px;
  color: var(--text);
}

.transport-skip:hover {
  color: var(--accent);
}

/* 播放键：深底上一颗擦亮的珠子 */
.play-btn {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.94);
  background: radial-gradient(
    circle at 32% 26%,
    rgba(255, 255, 255, 0.32),
    rgba(255, 255, 255, 0.1) 58%,
    rgba(255, 255, 255, 0.05)
  );
  box-shadow:
    0 10px 24px -10px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
  transition:
    transform 0.18s ease,
    background 0.18s ease;
}

.play-btn:hover {
  transform: scale(1.06);
  background: radial-gradient(
    circle at 32% 26%,
    rgba(255, 255, 255, 0.42),
    rgba(255, 255, 255, 0.16) 58%,
    rgba(255, 255, 255, 0.08)
  );
}

.play-btn:active {
  transform: scale(0.96);
}

.range {
  flex: 1;
  height: 10px;
  appearance: none;
  border-radius: 999px;
  background-color: rgba(255, 255, 255, 0.13);
  background-image: linear-gradient(
    180deg,
    rgba(246, 249, 253, 0.95),
    rgba(230, 237, 246, 0.5)
  );
  background-repeat: no-repeat;
  background-size: var(--fill) 100%;
  cursor: pointer;
  outline: none;
  transition: height 0.18s ease;
}

.range:disabled {
  cursor: default;
  opacity: 0.5;
}

.range::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  appearance: none;
  border-radius: 50%;
  background: radial-gradient(
    circle at 34% 28%,
    #ffffff 0%,
    rgba(238, 243, 250, 0.92) 45%,
    rgba(208, 219, 234, 0.78) 100%
  );
  box-shadow:
    0 1px 6px rgba(0, 0, 0, 0.35),
    0 0 10px rgba(255, 255, 255, 0.35);
  transition: transform 0.15s ease;
}

.range:active::-webkit-slider-thumb {
  transform: scale(1.2);
}

.volume {
  position: relative;
  display: flex;
  align-items: center;
}

.volume-pop {
  display: grid;
  grid-template-columns: 0fr;
  opacity: 0;
  transition:
    grid-template-columns 0.25s var(--ease),
    opacity 0.2s ease;
}

.volume-pop-inner {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.volume:hover .volume-pop,
.volume-pop:hover {
  grid-template-columns: 1fr;
  opacity: 1;
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

.machi-hints {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.machi-hints kbd {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 1px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-strong);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 650;
}

.hints-close {
  display: grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
  opacity: 0.7;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
}

.hints-close:hover {
  background: var(--surface-hover);
  color: var(--text);
  opacity: 1;
}

/* ------------------------------ 冷启动加载动画 ------------------------------ */

.machi-boot {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: rgba(255, 255, 255, 0.72);
  pointer-events: none;
}

.boot-mark {
  position: relative;
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  animation: boot-breathe 1.8s var(--ease) infinite;
}

.boot-mark::before,
.boot-mark::after {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(255, 255, 255, 0.32);
  border-radius: 50%;
  animation: boot-ripple 2.2s ease-out infinite;
  content: '';
}

.boot-mark::after {
  animation-delay: 1.1s;
}

.boot-text {
  font-size: 12px;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  opacity: 0.65;
}

@keyframes boot-ripple {
  0% {
    opacity: 0;
    transform: scale(0.55);
  }
  25% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}

@keyframes boot-breathe {
  0%,
  100% {
    opacity: 0.65;
    transform: scale(0.96);
  }
  50% {
    opacity: 1;
    transform: scale(1.04);
  }
}

.boot-enter-active {
  transition: opacity 0.25s ease;
}

.boot-leave-active {
  transition: opacity 0.45s ease;
}

.boot-enter-from,
.boot-leave-to {
  opacity: 0;
}

/* 展开/收起由 AppShell 的舞台统一负责，这里只剩启动层的淡出 */
</style>
