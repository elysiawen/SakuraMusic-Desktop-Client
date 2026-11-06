<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import { usePopoverDragGuard } from '@/composables/usePopoverDragGuard';
import { useAuthStore } from '@/stores/auth';
import { useHomeStore } from '@/stores/home';
import { PALETTES, useThemeStore, type ThemeMode } from '@/stores/theme';
import { cachedImage } from '@/utils/cacheImage';

const isMac = window.sakura.platform === 'darwin';
const theme = useThemeStore();
const auth = useAuthStore();
const home = useHomeStore();
const route = useRoute();
const router = useRouter();

/**
 * 顶栏（参考网易云桌面端）：
 * 左 logo、中间「前进后退 + 搜索」、右侧「账户 + 工具 + 窗口按钮」。
 *
 * 页名不在顶栏里重复显示——它已经由侧边栏的高亮和页面标题表达。
 */

const keyword = ref('');
const searchInput = ref<HTMLInputElement | null>(null);

/** Ctrl+F / Ctrl+K 以及搜索页里都在找这个输入框，页面内不再单独放一个。 */
function focusSearchInput(): void {
  searchInput.value?.focus();
  searchInput.value?.select();
}

const nickname = computed(() => auth.user?.nickname || auth.user?.username || '未登录');
const avatar = computed(() => cachedImage(auth.user?.avatar));
const initial = computed(() => nickname.value.trim().slice(0, 1) || 'S');

function goBack(): void {
  router.back();
}

/** 主页推荐只拉一次，想换一批就点搜索框右边这个刷新。 */
function refreshHome(): void {
  void home.load(true);
}

/**
 * 顶栏搜索：把关键词交给搜索页，由它自己发请求。
 *
 * 搜索页是懒加载的，先跳过去、等它挂上监听再派发，否则第一下会丢。
 */
async function submitSearch(): Promise<void> {
  const value = keyword.value.trim();
  if (!value) return;

  const send = (): void => {
    window.dispatchEvent(new CustomEvent('sakura:search', { detail: { keyword: value } }));
  };

  if (route.name === 'search') {
    send();
    return;
  }
  await router.push({ name: 'search' });
  window.setTimeout(send, 90);
}

function openAccount(): void {
  void router.push({ name: 'account' });
}

function openSettings(): void {
  void router.push({ name: 'settings' });
}

const maximized = ref(false);
const paletteOpen = ref(false);
const paletteWrap = ref<HTMLElement | null>(null);
let unsubscribeMaximized: (() => void) | null = null;

// 面板开着时标题栏不能当拖动区使，否则点它收不掉面板。
usePopoverDragGuard(() => paletteOpen.value);

const modes: Array<{ value: ThemeMode; label: string; icon: string }> = [
  { value: 'system', label: '跟随系统', icon: 'monitor' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];

function onDocumentPointerDown(event: PointerEvent): void {
  if (!paletteOpen.value) return;
  const target = event.target as Node | null;
  if (target && paletteWrap.value?.contains(target)) return;
  paletteOpen.value = false;
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

onMounted(async () => {
  if (!isMac) {
    maximized.value = await window.sakura.windowControls.isMaximized();
    unsubscribeMaximized = window.sakura.windowControls.onMaximizedChange((value) => {
      maximized.value = value;
    });
  }
  document.addEventListener('pointerdown', onDocumentPointerDown);
  window.addEventListener('sakura:focus-search', focusSearchInput);
});

onBeforeUnmount(() => {
  unsubscribeMaximized?.();
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  window.removeEventListener('sakura:focus-search', focusSearchInput);
});
</script>

<template>
  <header class="titlebar drag" @dblclick="toggleMaximize">
    <!-- 中间：后退 + 搜索；双击输入框不该触发窗口最大化 -->
    <div class="titlebar-nav no-drag" @dblclick.stop>
      <button class="nav-button" type="button" title="后退" aria-label="后退" @click="goBack">
        <AppIcon name="chevron-left" :size="17" />
      </button>

      <form class="search-box" @submit.prevent="submitSearch">
        <AppIcon name="search" :size="15" />
        <input
          ref="searchInput"
          v-model="keyword"
          type="text"
          placeholder="搜索歌曲、歌手、专辑或歌单"
          spellcheck="false"
          aria-label="搜索"
        />
        <button
          v-if="keyword"
          class="search-clear"
          type="button"
          title="清空"
          aria-label="清空"
          @click="keyword = ''"
        >
          <AppIcon name="close" :size="12" />
        </button>
      </form>

      <!-- 主页推荐刷新：只在主页出现，点一下换一批推荐。 -->
      <button
        v-if="route.name === 'home'"
        class="nav-button"
        type="button"
        title="刷新推荐"
        aria-label="刷新推荐"
        :disabled="home.loading"
        @click="refreshHome"
      >
        <AppIcon name="refresh" :size="15" :class="{ spinning: home.loading }" />
      </button>
    </div>

    <div class="titlebar-actions no-drag">
      <!-- 账户：头像 + 昵称，点进去是设置里的账户信息 -->
      <button class="account" type="button" :title="nickname" @click="openAccount">
        <span class="account-avatar">
          <img v-if="avatar" :src="avatar" alt="" />
          <template v-else>{{ initial }}</template>
        </span>
        <span class="account-name">{{ nickname }}</span>
        <AppIcon name="chevron-down" :size="12" />
      </button>

      <div ref="paletteWrap" class="palette-wrap">
        <button
          class="btn-icon"
          type="button"
          title="主题与配色"
          aria-label="主题与配色"
          @click.stop="paletteOpen = !paletteOpen"
        >
          <AppIcon name="palette" :size="17" />
        </button>

        <Transition name="pop">
          <div v-if="paletteOpen" class="palette-pop popover" @pointerdown.stop>
            <p class="eyebrow">明暗模式</p>
            <div class="mode-row">
              <button
                v-for="mode in modes"
                :key="mode.value"
                type="button"
                class="mode-button"
                :class="{ active: theme.mode === mode.value }"
                @click="theme.setMode(mode.value)"
              >
                <AppIcon :name="mode.icon" :size="14" />
                {{ mode.label }}
              </button>
            </div>

            <p class="eyebrow section-gap">配色</p>
            <div class="palette-grid">
              <button
                v-for="item in PALETTES"
                :key="item.id"
                type="button"
                class="palette-item"
                :class="{ active: theme.palette === item.id }"
                @click="theme.setPalette(item.id)"
              >
                <span
                  class="swatch"
                  :style="{ background: `linear-gradient(135deg, ${item.accent}, ${item.accent2})` }"
                />
                <span>{{ item.name }}</span>
                <AppIcon v-if="theme.palette === item.id" name="check" :size="13" />
              </button>
            </div>

            <button type="button" class="petal-toggle" @click="theme.togglePetals()">
              <AppIcon name="sparkles" :size="14" />
              <span>樱花飘落</span>
              <span class="petal-state">{{ theme.petals ? '开' : '关' }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <button class="btn-icon" type="button" title="设置" aria-label="设置" @click="openSettings">
        <AppIcon name="settings" :size="17" />
      </button>

      <div v-if="!isMac" class="window-controls">
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
    </div>
  </header>
</template>

<style scoped>
/*
 * 顶栏是内容区顶部的一条操作带，不是横贯窗口的标题栏：
 * 没有下边框、没有自己的底色，与内容区是同一块面 —— 分隔只靠侧边栏那道竖线。
 */
.titlebar {
  position: relative;
  z-index: var(--z-chrome);
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: var(--titlebar-h);
  padding: 0 14px 0 16px;
}

/* ---------------- 中间：导航 + 搜索 ---------------- */

.titlebar-nav {
  display: flex;
  /* 收在 380 左右：搜索框是「找东西的入口」，不该横贯半个窗口。 */
  max-width: 380px;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.nav-button {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--text-muted);
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.nav-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.nav-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 网易云那种搜索框：圆角矩形（不是胶囊），默认淡底、聚焦才浮出边线。 */
.search-box {
  display: flex;
  height: 36px;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 0 10px 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--text-faint);
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}

.search-box:hover {
  background: var(--surface-active);
}

.search-box:focus-within {
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  background: var(--surface-strong);
  box-shadow: 0 0 0 2px var(--accent-softer);
}

.search-box input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.search-box input::placeholder {
  color: var(--text-faint);
}

.search-clear {
  display: grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: var(--text-faint);
}

.search-clear:hover {
  background: var(--surface-active);
  color: var(--text);
}

/* ---------------- 右侧：账户 + 工具 + 窗口 ---------------- */

.titlebar-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.account {
  display: flex;
  max-width: 200px;
  height: 34px;
  align-items: center;
  gap: 8px;
  margin-right: 6px;
  padding: 0 10px 0 4px;
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  transition: background var(--dur) var(--ease);
}

.account:hover {
  background: var(--surface-hover);
}

.account-avatar {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  overflow: hidden;
  place-items: center;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: var(--accent-contrast);
  font-size: 12px;
  font-weight: 750;
}

.account-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.account-name {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-wrap {
  position: relative;
}

.palette-pop {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: var(--z-overlay);
  width: 268px;
  padding: 16px;
  animation: fade-up var(--dur) var(--ease);
}

.mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 8px;
}

.mode-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}

.mode-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.mode-button.active {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent);
}

.section-gap {
  margin-top: 18px;
}

.palette-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.palette-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.palette-item.active {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--accent-softer);
  color: var(--text);
}

.palette-item :deep(svg) {
  margin-left: auto;
  color: var(--accent);
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 18%);
}

.petal-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  margin-top: 14px;
  padding: 0 9px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.petal-toggle:hover {
  color: var(--text);
}

.petal-state {
  margin-left: auto;
  color: var(--accent);
  font-weight: 700;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-left: 8px;
  /* 与窗口右边缘只留一点：和系统标题栏的手感一致。 */
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

.pop-enter-active,
.pop-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 窄窗口：先收账户名，再收导航按钮，搜索框始终留着。 */
@media (max-width: 980px) {
  .account-name {
    display: none;
  }

  .account {
    padding: 0 3px;
  }
}

@media (max-width: 860px) {
  .nav-button {
    display: none;
  }
}
</style>
