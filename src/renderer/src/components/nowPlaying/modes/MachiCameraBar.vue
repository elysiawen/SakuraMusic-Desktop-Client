<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import {
  apertureReadout,
  MACHI_APERTURE_TRACK_MAX,
  MACHI_VIEW_SLIDERS,
  machiApertureFromTrack,
  machiApertureToTrack,
  signedReadout,
} from '../machi/cameraControls';
import { percent, times } from '../machi/panelRows';
import {
  DEFAULT_MACHI_TUNING,
  DEFAULT_MACHI_VIEW,
  MACHI_CAMERA_MODES,
  MACHI_DOF_LIMITS,
  MACHI_FOCUS_MODES,
  MACHI_MOTION_SPEED_LIMITS,
  MACHI_VIEW_LIMITS,
  type MachiCameraMode,
  type MachiCameraView,
  type MachiFocusMode,
  type MachiSceneId,
  type MachiTuning,
} from '../machi/types';

/**
 * 町景的取景控制条（移植自 folia 的 MachiCameraBar）：画面上叠取景框，
 * 底部一条深色玻璃横条分三页——视角、对焦与光圈、运镜。
 *
 * 滑块拖动中只经 `onPreview` 推给画面，松手（`onCommit`）才存；
 * 选项、开关、复位一点就存（`onTuningChange`）。
 */
const props = defineProps<{
  tuning: MachiTuning;
  scene: MachiSceneId;
  onPreview: (patch: Partial<MachiTuning>) => void;
  onCommit: () => void;
  onTuningChange: (patch: Partial<MachiTuning>) => void;
  onClose: () => void;
}>();

type BarTab = 'view' | 'lens' | 'motion';

/** 上次停在哪一页：收起再打开还在那一页。 */
let lastTab: BarTab = 'view';
const tab = ref<BarTab>(lastTab);

const TABS: { id: BarTab; label: string }[] = [
  { id: 'view', label: '视角' },
  { id: 'lens', label: '对焦与光圈' },
  { id: 'motion', label: '运镜' },
];

const CAMERA_LABELS: Record<MachiCameraMode, string> = {
  default: '默认构图',
  custom: '自定义视角',
};
const FOCUS_LABELS: Record<MachiFocusMode, string> = {
  center: '画面中心',
  lyrics: '歌词屏',
  manual: '手动',
};
const VIEW_LABELS: Record<keyof MachiCameraView, string> = {
  azimuth: '水平转角',
  elevation: '俯仰',
  zoom: '远近',
  panX: '左右平移',
  panZ: '前后平移',
};

/** 默认构图下画面就是默认构图：滑块从它读，拖哪一项就从它改起。 */
const view = computed<MachiCameraView>(() =>
  props.tuning.camera === 'custom' ? props.tuning.views[props.scene] : DEFAULT_MACHI_VIEW,
);

const dofOff = computed(() => props.tuning.dof === 0);

function setView(next: MachiCameraView): void {
  props.onPreview({ camera: 'custom', views: { ...props.tuning.views, [props.scene]: next } });
}

function selectTab(id: BarTab): void {
  lastTab = id;
  tab.value = id;
}

function reset(): void {
  if (tab.value === 'view') {
    props.onTuningChange({
      camera: 'default',
      views: { ...props.tuning.views, [props.scene]: DEFAULT_MACHI_VIEW },
    });
    return;
  }
  if (tab.value === 'lens') {
    const { aperture, dof, dofRange, tiltShift, focus, focusOffset } = DEFAULT_MACHI_TUNING;
    props.onTuningChange({ aperture, dof, dofRange, tiltShift, focus, focusOffset });
    return;
  }
  props.onTuningChange({ motion: DEFAULT_MACHI_TUNING.motion, motionSpeed: DEFAULT_MACHI_TUNING.motionSpeed });
}

function onKeydown(event: KeyboardEvent): void {
  // 空格、回车是横条里按钮和开关的，不让播放页的全局快捷键拿去暂停。
  if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  props.onClose();
}

function onInputNumber(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

onMounted(() => {
  // 指针在哪抬起都算松手（拖出滑块外抬起时滑块自己不一定收得到）。
  window.addEventListener('pointerup', props.onCommit);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', props.onCommit);
});
</script>

<template>
  <div class="mc-camera" @keydown="onKeydown" @keyup="onCommit">
    <!-- 取景框：四角、三分线、画面中心的准星 -->
    <div class="mc-viewfinder" aria-hidden="true">
      <span class="mc-corner mc-corner--tl" />
      <span class="mc-corner mc-corner--tr" />
      <span class="mc-corner mc-corner--bl" />
      <span class="mc-corner mc-corner--br" />
      <span class="mc-grid mc-grid--v1" />
      <span class="mc-grid mc-grid--v2" />
      <span class="mc-grid mc-grid--h1" />
      <span class="mc-grid mc-grid--h2" />
      <span class="mc-reticle" />
      <span class="mc-reticle-line mc-reticle-line--h" />
      <span class="mc-reticle-line mc-reticle-line--v" />
    </div>

    <div class="mc-bar" role="region" aria-label="取景">
      <div class="mc-tabs">
        <div class="mc-tab-list">
          <button
            v-for="item in TABS"
            :key="item.id"
            type="button"
            class="mc-tab"
            :class="{ on: tab === item.id }"
            @click="selectTab(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="mc-tab-actions">
          <button type="button" class="mc-action" title="复位" @click="reset">
            <AppIcon name="refresh" :size="13" />
            复位
          </button>
          <button type="button" class="mc-action mc-action--icon" title="收起" @click="onClose">
            <AppIcon name="close" :size="13" />
          </button>
        </div>
      </div>

      <div class="mc-fields">
        <template v-if="tab === 'view'">
          <div class="mc-field">
            <span class="mc-field-label">镜头</span>
            <div class="mc-seg">
              <button
                v-for="mode in MACHI_CAMERA_MODES"
                :key="mode"
                type="button"
                class="mc-seg-item"
                :class="{ on: tuning.camera === mode }"
                @click="onTuningChange({ camera: mode })"
              >
                {{ CAMERA_LABELS[mode] }}
              </button>
            </div>
          </div>
          <label v-for="spec in MACHI_VIEW_SLIDERS" :key="spec.key" class="mc-field mc-field--slider">
            <span class="mc-field-label">{{ VIEW_LABELS[spec.key] }}</span>
            <input
              type="range"
              :min="MACHI_VIEW_LIMITS[spec.key].min"
              :max="MACHI_VIEW_LIMITS[spec.key].max"
              :step="spec.step"
              :value="view[spec.key]"
              @input="setView({ ...view, [spec.key]: onInputNumber($event) })"
            />
            <span class="mc-value">{{ spec.format(view[spec.key]) }}</span>
          </label>
        </template>

        <template v-else-if="tab === 'lens'">
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label" :class="{ off: dofOff }">光圈</span>
            <input
              type="range"
              min="0"
              :max="MACHI_APERTURE_TRACK_MAX"
              step="1"
              :value="machiApertureToTrack(tuning.aperture)"
              :disabled="dofOff"
              @input="onPreview({ aperture: machiApertureFromTrack(onInputNumber($event)) })"
            />
            <span class="mc-value">{{ apertureReadout(tuning.aperture) }}</span>
          </label>
          <div class="mc-field">
            <span class="mc-field-label">对焦在哪</span>
            <div class="mc-seg">
              <button
                v-for="mode in MACHI_FOCUS_MODES"
                :key="mode"
                type="button"
                class="mc-seg-item"
                :class="{ on: tuning.focus === mode }"
                @click="onTuningChange({ focus: mode })"
              >
                {{ FOCUS_LABELS[mode] }}
              </button>
            </div>
          </div>
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label" :class="{ off: tuning.focus !== 'manual' }">对焦前后</span>
            <input
              type="range"
              :min="MACHI_DOF_LIMITS.focusOffset.min"
              :max="MACHI_DOF_LIMITS.focusOffset.max"
              step="0.1"
              :value="tuning.focusOffset"
              :disabled="tuning.focus !== 'manual'"
              @input="onPreview({ focusOffset: onInputNumber($event) })"
            />
            <span class="mc-value">{{ signedReadout(' m', 1)(tuning.focusOffset) }}</span>
          </label>
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label" :class="{ off: dofOff }">清晰范围</span>
            <input
              type="range"
              :min="MACHI_DOF_LIMITS.dofRange.min"
              :max="MACHI_DOF_LIMITS.dofRange.max"
              step="0.05"
              :value="tuning.dofRange"
              :disabled="dofOff"
              @input="onPreview({ dofRange: onInputNumber($event) })"
            />
            <span class="mc-value">{{ times(tuning.dofRange) }}</span>
          </label>
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label">景深强度</span>
            <input
              type="range"
              :min="MACHI_DOF_LIMITS.dof.min"
              :max="MACHI_DOF_LIMITS.dof.max"
              step="0.05"
              :value="tuning.dof"
              @input="onPreview({ dof: onInputNumber($event) })"
            />
            <span class="mc-value">{{ percent(tuning.dof) }}</span>
          </label>
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label">移轴</span>
            <input
              type="range"
              :min="MACHI_DOF_LIMITS.tiltShift.min"
              :max="MACHI_DOF_LIMITS.tiltShift.max"
              step="0.05"
              :value="tuning.tiltShift"
              @input="onPreview({ tiltShift: onInputNumber($event) })"
            />
            <span class="mc-value">{{ percent(tuning.tiltShift) }}</span>
          </label>
        </template>

        <template v-else>
          <div class="mc-field">
            <span class="mc-field-label">运镜</span>
            <button
              type="button"
              class="mc-toggle"
              role="switch"
              :aria-checked="tuning.motion"
              @click="onTuningChange({ motion: !tuning.motion })"
            >
              <span class="mc-switch" :class="{ on: tuning.motion }" />
            </button>
          </div>
          <label class="mc-field mc-field--slider">
            <span class="mc-field-label" :class="{ off: !tuning.motion }">快慢</span>
            <input
              type="range"
              :min="MACHI_MOTION_SPEED_LIMITS.min"
              :max="MACHI_MOTION_SPEED_LIMITS.max"
              step="0.05"
              :value="tuning.motionSpeed"
              :disabled="!tuning.motion"
              @input="onPreview({ motionSpeed: onInputNumber($event) })"
            />
            <span class="mc-value">{{ times(tuning.motionSpeed) }}</span>
          </label>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 整层不吃指针；只有横条接事件，画布还能拖镜头 */
.mc-camera {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
}

/* ------------------------------ 取景框 ------------------------------ */

.mc-viewfinder {
  position: absolute;
  inset: 0;
}

.mc-corner {
  position: absolute;
  width: 28px;
  height: 28px;
  border-color: rgba(255, 255, 255, 0.7);
  border-style: solid;
  border-width: 0;
}

.mc-corner--tl {
  top: 24px;
  left: 24px;
  border-top-width: 2px;
  border-left-width: 2px;
}

.mc-corner--tr {
  top: 24px;
  right: 24px;
  border-top-width: 2px;
  border-right-width: 2px;
}

.mc-corner--bl {
  bottom: 24px;
  left: 24px;
  border-bottom-width: 2px;
  border-left-width: 2px;
}

.mc-corner--br {
  right: 24px;
  bottom: 24px;
  border-right-width: 2px;
  border-bottom-width: 2px;
}

.mc-grid {
  position: absolute;
  background: rgba(255, 255, 255, 0.15);
}

.mc-grid--v1 {
  top: 0;
  bottom: 0;
  left: 33.333%;
  width: 1px;
}

.mc-grid--v2 {
  top: 0;
  bottom: 0;
  left: 66.666%;
  width: 1px;
}

.mc-grid--h1 {
  top: 33.333%;
  right: 0;
  left: 0;
  height: 1px;
}

.mc-grid--h2 {
  top: 66.666%;
  right: 0;
  left: 0;
  height: 1px;
}

.mc-reticle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 24px;
  height: 24px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.mc-reticle-line {
  position: absolute;
  top: 50%;
  left: 50%;
  background: rgba(255, 255, 255, 0.8);
  transform: translate(-50%, -50%);
}

.mc-reticle-line--h {
  width: 12px;
  height: 1px;
}

.mc-reticle-line--v {
  width: 1px;
  height: 12px;
}

/* ------------------------------ 横条 ------------------------------ */

.mc-bar {
  position: absolute;
  right: 16px;
  bottom: 96px;
  left: 16px;
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding-bottom: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: rgba(18, 18, 20, 0.74);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  color: #f4f4f5;
  font-size: 13px;
  pointer-events: auto;
  backdrop-filter: blur(24px);
}

.mc-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 0;
}

.mc-tab-list {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}

.mc-tab {
  padding: 5px 12px;
  border-radius: 6px;
  color: rgba(244, 244, 245, 0.62);
  font-size: 12px;
  font-weight: 650;
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.mc-tab:hover:not(.on) {
  color: #f4f4f5;
}

.mc-tab.on {
  background: rgba(255, 255, 255, 0.16);
  color: #f4f4f5;
}

.mc-tab-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
}

.mc-action {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 7px;
  color: rgba(244, 244, 245, 0.72);
  font-size: 11.5px;
  font-weight: 650;
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.mc-action:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #f4f4f5;
}

.mc-action--icon {
  width: 28px;
  padding: 0;
  justify-content: center;
}

/* ------------------------------ 控件 ------------------------------ */

.mc-fields {
  display: grid;
  padding: 12px 20px 4px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  align-items: end;
  gap: 8px 24px;
}

.mc-field {
  display: flex;
  min-width: 0;
  min-height: 32px;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.mc-field-label {
  color: rgba(244, 244, 245, 0.68);
  font-size: 12px;
}

.mc-field-label.off {
  opacity: 0.4;
}

.mc-field--slider input[type='range'] {
  min-width: 0;
  height: 4px;
  flex: 1;
  appearance: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  cursor: pointer;
  outline: none;
}

.mc-field--slider input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 50%;
  background: #f4f4f5;
}

.mc-field--slider input[type='range']:disabled {
  cursor: default;
  opacity: 0.35;
}

.mc-value {
  width: 44px;
  flex: none;
  color: rgba(244, 244, 245, 0.5);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.mc-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.06);
}

.mc-seg-item {
  padding: 4px 9px;
  border-radius: 5px;
  color: rgba(244, 244, 245, 0.66);
  font-size: 11.5px;
  font-weight: 650;
}

.mc-seg-item:hover:not(.on) {
  color: #f4f4f5;
}

.mc-seg-item.on {
  background: rgba(255, 255, 255, 0.18);
  color: #f4f4f5;
}

.mc-toggle {
  display: inline-flex;
  align-items: center;
}

.mc-switch {
  position: relative;
  width: 30px;
  height: 17px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  transition: background 0.16s ease;
}

.mc-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: rgba(244, 244, 245, 0.7);
  content: '';
  transition:
    transform 0.16s ease,
    background 0.16s ease;
}

.mc-switch.on {
  background: rgba(255, 255, 255, 0.32);
}

.mc-switch.on::after {
  background: #fff;
  transform: translateX(13px);
}
</style>
