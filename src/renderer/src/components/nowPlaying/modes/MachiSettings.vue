<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useMachiTuningStore } from './machiTuningStore';
import {
  apertureReadout,
  MACHI_APERTURE_TRACK_MAX,
  machiApertureFromTrack,
  machiApertureToTrack,
  signedReadout,
} from '../machi/cameraControls';
import { percent, times } from '../machi/panelRows';
import { resolveMachiQualityPreset } from '../machi/machiTuning';
import {
  MACHI_ANTIALIAS_MODES,
  MACHI_CAMERA_MODES,
  MACHI_DETAIL_LEVELS,
  MACHI_DOF_LIMITS,
  MACHI_FOCUS_MODES,
  MACHI_FOLLOW_GLOBAL,
  MACHI_MOTION_SPEED_LIMITS,
  MACHI_QUALITY_PRESET_IDS,
  MACHI_QUALITY_PRESETS,
  MACHI_QUALITY_REVISION,
  MACHI_RENDER_SCALES,
  MACHI_TIMES_OF_DAY,
  MACHI_WEATHERS,
  type MachiAntialias,
  type MachiCameraMode,
  type MachiDetailLevel,
  type MachiFocusMode,
  type MachiQualityPresetId,
  type MachiRenderScale,
  type MachiSceneId,
  type MachiTimeOfDay,
  type MachiTuning,
  type MachiWeather,
} from '../machi/types';

/**
 * 町景的设置面板（样式菜单里町景旁的设置按钮弹出这个）。
 * 分组、范围与 folia 的 MachiSettingsPanel 一一对应；桌面端没有视频导出，
 * 所以不出现导出相关的开关。
 */
const store = useMachiTuningStore();
const tuning = computed(() => store.tuning);

function patch(partial: Partial<MachiTuning>): void {
  store.patch(partial);
}

/* ------------------------------ 文案 ------------------------------ */

const SCENE_OPTIONS: { value: 'auto' | MachiSceneId; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'konbini', label: '便利店街角' },
  { value: 'station', label: '加油站停车场' },
  { value: 'kowloon', label: '城寨酒吧' },
];

const TIME_LABELS: Record<MachiTimeOfDay, string> = {
  auto: '自动',
  day: '白天',
  dusk: '黄昏',
  night: '夜晚',
};

const WEATHER_LABELS: Record<MachiWeather, string> = {
  auto: '自动',
  clear: '晴',
  rain: '雨',
  snow: '雪',
  fog: '雾',
};

const CAMERA_LABELS: Record<MachiCameraMode, string> = {
  default: '默认构图',
  custom: '自定义视角',
};

const FOCUS_LABELS: Record<MachiFocusMode, string> = {
  center: '画面中心',
  lyrics: '歌词屏',
  manual: '手动',
};

const PRESET_LABELS: Record<MachiQualityPresetId, string> = {
  high: '高',
  balanced: '平衡',
  low: '低',
};

const DETAIL_LABELS: Record<MachiDetailLevel, string> = {
  off: '关',
  low: '低',
  high: '高',
};

const ANTIALIAS_LABELS: Record<MachiAntialias | typeof MACHI_FOLLOW_GLOBAL, string> = {
  [MACHI_FOLLOW_GLOBAL]: '跟随全局',
  off: '关',
  fxaa: 'FXAA',
  smaa: 'SMAA',
  ssaa: '超采样',
};

const SCALE_LABELS: Record<MachiRenderScale | typeof MACHI_FOLLOW_GLOBAL, string> = {
  [MACHI_FOLLOW_GLOBAL]: '跟随全局',
  1: '100%',
  0.75: '75%',
  0.5: '50%',
};

/** 这套画质是哪一档预设（细项和某一档完全一样才算），不是就是自定义。 */
const qualityPreset = computed(() => resolveMachiQualityPreset(tuning.value.quality));

function applyPreset(id: MachiQualityPresetId): void {
  patch({
    quality: {
      ...MACHI_QUALITY_PRESETS[id],
      adaptive: tuning.value.quality.adaptive,
      revision: MACHI_QUALITY_REVISION,
    },
  });
}

/* ------------------------------ 滑块 ------------------------------ */

function onNumber(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="mc-settings">
    <!-- 场景与天气 -->
    <section class="mc-group">
      <h3 class="mc-title">街景</h3>
      <div class="mc-row">
        <span class="mc-label">场景</span>
        <div class="mc-seg">
          <button
            v-for="option in SCENE_OPTIONS"
            :key="option.value"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.scene === option.value }"
            @click="patch({ scene: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">时间</span>
        <div class="mc-seg">
          <button
            v-for="option in MACHI_TIMES_OF_DAY"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.timeOfDay === option }"
            @click="patch({ timeOfDay: option })"
          >
            {{ TIME_LABELS[option] }}
          </button>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">天气</span>
        <div class="mc-seg">
          <button
            v-for="option in MACHI_WEATHERS"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.weather === option }"
            @click="patch({ weather: option })"
          >
            {{ WEATHER_LABELS[option] }}
          </button>
        </div>
      </div>
      <p class="mc-hint">选了「自动」时，场景与天气按歌的种子挑，时间跟本地时钟走。</p>
    </section>

    <!-- 镜头与景深 -->
    <section class="mc-group">
      <h3 class="mc-title">镜头</h3>
      <div class="mc-row">
        <span class="mc-label">镜头</span>
        <div class="mc-seg">
          <button
            v-for="mode in MACHI_CAMERA_MODES"
            :key="mode"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.camera === mode }"
            @click="patch({ camera: mode })"
          >
            {{ CAMERA_LABELS[mode] }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="mc-toggle"
        role="switch"
        :aria-checked="tuning.motion"
        @click="patch({ motion: !tuning.motion })"
      >
        <span class="mc-label">缓慢运镜</span>
        <span class="mc-switch" :class="{ on: tuning.motion }" />
      </button>
      <label class="mc-slider">
        <span class="mc-label" :class="{ off: !tuning.motion }">运镜快慢</span>
        <input
          type="range"
          :min="MACHI_MOTION_SPEED_LIMITS.min"
          :max="MACHI_MOTION_SPEED_LIMITS.max"
          step="0.05"
          :value="tuning.motionSpeed"
          :disabled="!tuning.motion"
          @input="patch({ motionSpeed: onNumber($event) })"
        />
        <span class="mc-value">{{ times(tuning.motionSpeed) }}</span>
      </label>
      <div class="mc-row">
        <span class="mc-label">对焦在哪</span>
        <div class="mc-seg">
          <button
            v-for="mode in MACHI_FOCUS_MODES"
            :key="mode"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.focus === mode }"
            @click="patch({ focus: mode })"
          >
            {{ FOCUS_LABELS[mode] }}
          </button>
        </div>
      </div>
      <label class="mc-slider">
        <span class="mc-label" :class="{ off: tuning.focus !== 'manual' }">对焦前后</span>
        <input
          type="range"
          :min="MACHI_DOF_LIMITS.focusOffset.min"
          :max="MACHI_DOF_LIMITS.focusOffset.max"
          step="0.1"
          :value="tuning.focusOffset"
          :disabled="tuning.focus !== 'manual'"
          @input="patch({ focusOffset: onNumber($event) })"
        />
        <span class="mc-value">{{ signedReadout(' m', 1)(tuning.focusOffset) }}</span>
      </label>
      <label class="mc-slider">
        <span class="mc-label" :class="{ off: tuning.dof === 0 }">光圈</span>
        <input
          type="range"
          min="0"
          :max="MACHI_APERTURE_TRACK_MAX"
          step="1"
          :value="machiApertureToTrack(tuning.aperture)"
          :disabled="tuning.dof === 0"
          @input="patch({ aperture: machiApertureFromTrack(onNumber($event)) })"
        />
        <span class="mc-value">{{ apertureReadout(tuning.aperture) }}</span>
      </label>
      <label class="mc-slider">
        <span class="mc-label" :class="{ off: tuning.dof === 0 }">清晰范围</span>
        <input
          type="range"
          :min="MACHI_DOF_LIMITS.dofRange.min"
          :max="MACHI_DOF_LIMITS.dofRange.max"
          step="0.05"
          :value="tuning.dofRange"
          :disabled="tuning.dof === 0"
          @input="patch({ dofRange: onNumber($event) })"
        />
        <span class="mc-value">{{ times(tuning.dofRange) }}</span>
      </label>
      <label class="mc-slider">
        <span class="mc-label">景深强度</span>
        <input
          type="range"
          :min="MACHI_DOF_LIMITS.dof.min"
          :max="MACHI_DOF_LIMITS.dof.max"
          step="0.05"
          :value="tuning.dof"
          @input="patch({ dof: onNumber($event) })"
        />
        <span class="mc-value">{{ percent(tuning.dof) }}</span>
      </label>
      <label class="mc-slider">
        <span class="mc-label">移轴</span>
        <input
          type="range"
          :min="MACHI_DOF_LIMITS.tiltShift.min"
          :max="MACHI_DOF_LIMITS.tiltShift.max"
          step="0.05"
          :value="tuning.tiltShift"
          @input="patch({ tiltShift: onNumber($event) })"
        />
        <span class="mc-value">{{ percent(tuning.tiltShift) }}</span>
      </label>
    </section>

    <!-- 画质 -->
    <section class="mc-group">
      <h3 class="mc-title">画质</h3>
      <div class="mc-row">
        <span class="mc-label">预设</span>
        <div class="mc-seg">
          <button
            v-for="id in MACHI_QUALITY_PRESET_IDS"
            :key="id"
            type="button"
            class="mc-seg-item"
            :class="{ on: qualityPreset === id }"
            @click="applyPreset(id)"
          >
            {{ PRESET_LABELS[id] }}
          </button>
          <span class="mc-seg-static" :class="{ on: qualityPreset === 'custom' }">自定义</span>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">分辨率</span>
        <div class="mc-seg">
          <button
            v-for="option in [MACHI_FOLLOW_GLOBAL, ...MACHI_RENDER_SCALES]"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.quality.renderScale === option }"
            @click="patch({ quality: { ...tuning.quality, renderScale: option } })"
          >
            {{ SCALE_LABELS[option] }}
          </button>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">抗锯齿</span>
        <div class="mc-seg">
          <button
            v-for="option in [MACHI_FOLLOW_GLOBAL, ...MACHI_ANTIALIAS_MODES]"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.quality.antialias === option }"
            @click="patch({ quality: { ...tuning.quality, antialias: option } })"
          >
            {{ ANTIALIAS_LABELS[option] }}
          </button>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">阴影</span>
        <div class="mc-seg">
          <button
            v-for="option in MACHI_DETAIL_LEVELS"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.quality.shadows === option }"
            @click="patch({ quality: { ...tuning.quality, shadows: option } })"
          >
            {{ DETAIL_LABELS[option] }}
          </button>
        </div>
      </div>
      <div class="mc-row">
        <span class="mc-label">湿路倒影</span>
        <div class="mc-seg">
          <button
            v-for="option in MACHI_DETAIL_LEVELS"
            :key="option"
            type="button"
            class="mc-seg-item"
            :class="{ on: tuning.quality.reflections === option }"
            @click="patch({ quality: { ...tuning.quality, reflections: option } })"
          >
            {{ DETAIL_LABELS[option] }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="mc-toggle"
        role="switch"
        :aria-checked="tuning.quality.glow"
        @click="patch({ quality: { ...tuning.quality, glow: !tuning.quality.glow } })"
      >
        <span class="mc-label">辉光与镜头光条</span>
        <span class="mc-switch" :class="{ on: tuning.quality.glow }" />
      </button>
      <button
        type="button"
        class="mc-toggle"
        role="switch"
        :aria-checked="tuning.quality.adaptive"
        @click="patch({ quality: { ...tuning.quality, adaptive: !tuning.quality.adaptive } })"
      >
        <span class="mc-label">帧率跟不上时自动降级</span>
        <span class="mc-switch" :class="{ on: tuning.quality.adaptive }" />
      </button>
    </section>

    <!-- 节拍 -->
    <section class="mc-group">
      <h3 class="mc-title">节拍</h3>
      <button
        type="button"
        class="mc-toggle"
        role="switch"
        :aria-checked="tuning.simulatedBeat"
        @click="patch({ simulatedBeat: !tuning.simulatedBeat })"
      >
        <span class="mc-label">模拟节拍（霓虹随拍、大屏闪拍）</span>
        <span class="mc-switch" :class="{ on: tuning.simulatedBeat }" />
      </button>
    </section>

    <!-- 恢复默认挂在弹窗头部、关闭按钮的左边（弹窗壳预留了 .mode-settings-actions） -->
    <Teleport defer to=".mode-settings-actions">
      <button type="button" class="mc-reset" @click="store.reset()">
        <AppIcon name="refresh" :size="13" />
        恢复默认
      </button>
    </Teleport>
  </div>
</template>

<style scoped>
.mc-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mc-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mc-title {
  margin: 0 0 4px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.mc-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.mc-label.off {
  opacity: 0.45;
}

.mc-hint {
  margin: 2px 0 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
}

.mc-row {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mc-seg {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.mc-seg-item,
.mc-seg-static {
  padding: 4px 10px;
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.mc-seg-item:hover:not(.on) {
  color: var(--text);
}

.mc-seg-item.on,
.mc-seg-static.on {
  background: var(--accent);
  color: var(--accent-contrast);
}

.mc-seg-static {
  opacity: 0.7;
}

.mc-slider {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 12px;
}

.mc-slider .mc-label {
  width: 64px;
  flex: none;
}

.mc-slider input[type='range'] {
  flex: 1;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: var(--surface-hover);
  cursor: pointer;
  outline: none;
}

.mc-slider input[type='range']:disabled {
  cursor: default;
  opacity: 0.4;
}

.mc-slider input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 50%;
  background: var(--accent);
  transition: transform 0.15s ease;
}

.mc-slider input[type='range']:active::-webkit-slider-thumb {
  transform: scale(1.2);
}

.mc-value {
  width: 44px;
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.mc-toggle {
  display: flex;
  min-height: 28px;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}

.mc-switch {
  position: relative;
  width: 30px;
  height: 17px;
  flex: none;
  border-radius: 999px;
  background: var(--surface-hover);
  transition: background var(--dur-fast) var(--ease);
}

.mc-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-muted);
  content: '';
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}

.mc-switch.on {
  background: var(--accent);
}

.mc-switch.on::after {
  background: var(--accent-contrast);
  transform: translateX(13px);
}

.mc-reset {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.mc-reset:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
</style>
