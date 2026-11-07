<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePopoverDragGuard } from '@/composables/usePopoverDragGuard';
import { PREMIUM_QUALITIES, qualityLabel, qualityMenuLabel, type Quality } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import { QUALITY_ORDER } from '@/utils/track';

/**
 * 音质选择器（对齐 web 端）。播放条与全屏歌词页共用。
 *
 * 紧凑处只显示当前档位的短名，点开才列出可选档位：
 * 一点宽度塞不下七档，平铺一排反而认不出来。
 *
 * 面板用 Teleport + fixed 定位：它弹出的位置经常跨在别的区块上（播放条的进度行、
 * 歌词页底部的传输控制），而这些区块各自带 z-index。留在原地的话，面板会被后者的
 * 层叠上下文压住 —— 表现就是「进度条的滑块画在菜单上面」。
 */
const props = withDefaults(
  defineProps<{
    /** 面板从芯片哪一侧展开。 */
    placement?: 'up' | 'down';
    /** 面板与芯片左对齐还是右对齐。 */
    align?: 'left' | 'right';
    /** 深色场景（沉浸/雾笺/绘光/町景）的浮层要跟着场景走深色。 */
    stageTone?: string;
  }>(),
  { placement: 'up', align: 'right', stageTone: undefined },
);

const player = usePlayerStore();

const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

// 面板开着时标题栏不能当拖动区使，否则点它收不掉面板。
usePopoverDragGuard(() => open.value);

/** 面板宽度与贴边留白，与样式里的 `width: 232px` 保持一致（摆位要用）。 */
const MENU_WIDTH = 232;
const MENU_GAP = 8;
/** 比这还窄就不硬塞了，宁可翻到另一侧。 */
const MIN_SPACE = 140;

const menuUp = ref(props.placement === 'up');
const menuStyle = ref<Record<string, string>>({});

/** 当前这首歌来自哪个平台：QQ 客户端把 high 叫「极高 (HQ)」，档位名要跟着换。 */
const platform = computed(() => player.activeSource?.platform);

/**
 * 芯片显示**正在播的**那一档，不是偏好档位。
 * 偏好拿不到时会降级，照偏好显示就成了谎报；还没开播时才退回偏好。
 */
const playing = computed<Quality>(() => player.actualQuality ?? player.quality);

/** 各档规格，口径与客户端音质面板那一栏一致。 */
const SPEC: Record<Quality, string> = {
  standard: '128kbps',
  high: '最高 320kbps',
  lossless: '无损 FLAC',
  hires: 'Hi-Res',
  spatial: '96kHz/24bit',
  master: '母带级 192kHz/24bit',
  surround: '最高 5.1 声道',
};

/**
 * 只列**这首歌真有**的档位；平台没给 `qualities`（本地曲目、历史条目）时照旧列全 ——
 * 「不知道」不该被显示成「没有」。
 */
const options = computed(() => {
  const available = player.current?.qualities;
  const list =
    available && available.length > 0
      ? QUALITY_ORDER.filter((item) => available.includes(item))
      : QUALITY_ORDER;
  return list.map((value) => ({
    value,
    label: qualityMenuLabel(value, platform.value),
    hint: hintOf(value),
  }));
});

/** 体积 · 规格；体积来自曲目自身，缺省就只写规格。 */
function hintOf(quality: Quality): string {
  const bytes = player.current?.qualitySizes?.[quality];
  if (!bytes) return SPEC[quality];
  return `${(bytes / 1024 / 1024).toFixed(1)}M · ${SPEC[quality]}`;
}

const footerNote = computed(() => {
  const premium = options.value.filter((item) => PREMIUM_QUALITIES.includes(item.value));
  if (premium.length === 0) return '不可用的档位会自动降级到能播的那一档';
  const names = premium.map((item) => qualityLabel(item.value, platform.value)).join('、');
  return `${names}需要对应等级的会员，不可用时自动降级`;
});

/**
 * 贴着芯片摆好位置。
 *
 * 只依赖「已知宽度 + 视口空间」，不看渲染后的尺寸，所以不需要先隐藏再测量。
 * 上/下按传入的偏好来，空间不够时翻到另一侧；左右按对齐方式算并夹在视口内。
 */
function placeMenu(): void {
  const trigger = wrapRef.value?.querySelector<HTMLElement>('.quality-trigger');
  if (!trigger) return;

  const anchor = trigger.getBoundingClientRect();
  const gutter = 8;
  const width = Math.min(MENU_WIDTH, window.innerWidth - gutter * 2);
  const left =
    props.align === 'left'
      ? Math.max(gutter, Math.min(anchor.left, window.innerWidth - width - gutter))
      : Math.max(gutter, Math.min(anchor.right - width, window.innerWidth - width - gutter));

  const above = anchor.top - MENU_GAP - gutter;
  const below = window.innerHeight - anchor.bottom - MENU_GAP - gutter;

  let up = props.placement === 'up';
  if ((up ? above : below) < MIN_SPACE && (up ? below : above) > (up ? above : below)) up = !up;
  menuUp.value = up;

  const space = Math.max(MIN_SPACE, up ? above : below);
  menuStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(340, space)}px`,
    ...(up
      ? { top: 'auto', bottom: `${window.innerHeight - anchor.top + MENU_GAP}px` }
      : { top: `${anchor.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) placeMenu();
}

function select(value: Quality): void {
  open.value = false;
  if (value === player.quality) return;
  void player.setQuality(value);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;

  // 芯片与（被 Teleport 出去的）面板都算「里面」。
  if (wrapRef.value?.contains(target)) return;
  if (menuRef.value?.contains(target)) return;
  open.value = false;
}

/**
 * Esc 只收面板，不再往上传（捕获阶段拦下）：
 * 全屏歌词页也监听 Esc 关闭整页，一起响应的话会连页面一起关掉。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return;
  // 两个监听都挂在 window 上，只有 immediate 版能拦住同一层级的另一个回调。
  event.stopImmediatePropagation();
  open.value = false;
}

/**
 * 任何滚动都只重新贴位、不收起：歌词换行时列表自己就在滚，一滚就收的话
 * 这个面板根本没法用。触发芯片在播放条/顶栏（fixed），重新贴位跟着挪。
 */
function onViewportScroll(): void {
  if (open.value) placeMenu();
}

function onResize(): void {
  if (open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('scroll', onViewportScroll, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('scroll', onViewportScroll, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div ref="wrapRef" class="quality-picker">
    <button
      type="button"
      class="quality-trigger"
      :class="{ 'has-note': Boolean(player.qualityNotice) }"
      :title="player.qualityNotice || `音质：${qualityLabel(playing, platform)}（点击切换）`"
      @click="toggle"
    >
      <span>{{ qualityLabel(playing, platform) }}</span>
      <AppIcon name="chevron-down" :size="11" class="quality-caret" :class="{ 'is-open': open }" />
    </button>
  </div>

  <!--
    面板挂到 body 上：播放条与歌词页的父级各自带着 z-index / overflow，
    留在原地会被后面的区块盖住（例如歌词页底部的进度滑块）。
  -->
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="quality-menu popover"
      :class="[menuUp ? 'is-up' : 'is-down', `is-${props.align}`, { 'is-dark': stageTone === 'dark' }]"
      :style="menuStyle"
    >
      <button
        v-for="item in options"
        :key="item.value"
        type="button"
        class="quality-option"
        :class="{ 'is-active': playing === item.value }"
        @click="select(item.value)"
      >
        <span class="quality-copy">
          <strong>{{ item.label }}</strong>
          <small>{{ item.hint }}</small>
        </span>
        <AppIcon v-if="playing === item.value" name="check" :size="13" :stroke-width="2.6" />
      </button>

      <p v-if="player.qualityNotice" class="quality-note is-alert">{{ player.qualityNotice }}</p>
      <p v-else class="quality-note">{{ footerNote }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.quality-picker {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
}

.quality-trigger {
  display: inline-flex;
  height: 24px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-faint);
  font-size: 9.5px;
  font-weight: 650;
  white-space: nowrap;
  transition:
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.quality-trigger:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

/* 被降级时（选的档位拿不到）给芯片一个记号，免得用户以为在听选中的那档。 */
.quality-trigger.has-note {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  color: var(--accent);
}

.quality-caret {
  transition: transform var(--dur) var(--ease);
}

.quality-caret.is-open {
  transform: rotate(180deg);
}

/* 固定定位：位置由 placeMenu 按芯片的屏幕坐标算好，贴边留白也在那里夹过。 */
.quality-menu {
  position: fixed;
  z-index: var(--z-overlay);
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.quality-menu.is-up {
  transform-origin: bottom center;
  animation: quality-pop-up var(--dur) var(--ease);
}

.quality-menu.is-down {
  transform-origin: top center;
  animation: quality-pop-down var(--dur) var(--ease);
}

@keyframes quality-pop-up {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes quality-pop-down {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.quality-option {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-align: left;
  transition: background var(--dur-fast) var(--ease);
}

.quality-option:hover {
  background: var(--surface-hover);
}

.quality-option.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.quality-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.quality-copy strong {
  font-size: 12px;
  font-weight: 650;
}

.quality-copy small {
  color: var(--text-faint);
  font-size: 10.5px;
}

.quality-note {
  margin: 6px 4px 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.5;
}

.quality-note.is-alert {
  color: var(--accent);
}
</style>
