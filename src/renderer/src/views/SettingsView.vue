<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  CACHE_KIND_HINT,
  CACHE_KIND_LABEL,
  CACHE_KINDS,
  type CacheKind,
  type CacheStats,
} from '@shared/cache';
import type { AppInfo, DesktopConfig, DesktopConfigPatch } from '@shared/ipc';
import AppIcon from '@/components/common/AppIcon.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import {
  CAPABILITIES,
  CAPABILITY_HINT,
  CAPABILITY_LABEL,
  PLATFORMS,
  QUALITY_LABEL,
  type Capability,
  type Platform,
  type Quality,
} from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { PLAY_QUALITIES, usePlayerStore, type RouteMode } from '@/stores/player';
import { usePreferencesStore } from '@/stores/preferences';
import { useUiStore } from '@/stores/ui';
import { formatBytes, platformName } from '@/utils/format';

const auth = useAuthStore();
const player = usePlayerStore();
const preferences = usePreferencesStore();
const ui = useUiStore();
const toast = useToast();

const ROUTE_OPTIONS: Array<{ id: RouteMode; label: string }> = [
  { id: 'auto', label: '智能' },
  { id: 'direct', label: '直连' },
  { id: 'proxy', label: '中转' },
];

/** 缓存额度与安卓端同一套档位：0 = 不缓存，-1 = 不限。 */
const AUDIO_CACHE_OPTIONS = [
  { value: 0, label: '不缓存' },
  { value: 256, label: '256 MB' },
  { value: 512, label: '512 MB' },
  { value: 1024, label: '1 GB' },
  { value: 2048, label: '2 GB' },
  { value: 4096, label: '4 GB' },
  { value: 10240, label: '10 GB' },
  { value: -1, label: '不限' },
];

const COVER_CACHE_OPTIONS = [
  { value: 0, label: '不缓存' },
  { value: 64, label: '64 MB' },
  { value: 128, label: '128 MB' },
  { value: 256, label: '256 MB' },
  { value: 512, label: '512 MB' },
  { value: 1024, label: '1 GB' },
  { value: -1, label: '不限' },
];

const LYRIC_TTL_OPTIONS = [
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: -1, label: '永久' },
];

const META_TTL_OPTIONS = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: -1, label: '永久' },
];

const LYRIC_FONT_OPTIONS = [
  { value: 24, label: '小' },
  { value: 32, label: '标准' },
  { value: 42, label: '大' },
];

const LYRIC_COLOR_OPTIONS = [
  { value: '#ffffff', label: '白' },
  { value: '#ff8fab', label: '樱粉' },
  { value: '#8be9fd', label: '青' },
  { value: '#ffd166', label: '暖黄' },
];

const config = ref<DesktopConfig | null>(null);
const appInfo = ref<AppInfo | null>(null);
const deviceDraft = ref('');
const saving = ref(false);
const cacheStats = ref<CacheStats | null>(null);
const cacheBusy = ref(false);
/** 缓存清理确认弹窗：打开时记住要清哪一类（undefined = 全部）。 */
const clearConfirmOpen = ref(false);
const clearConfirmKind = ref<CacheKind | undefined>(undefined);
// 托盘菜单、歌词窗口按钮也会改配置：订阅广播，三处状态保持一致。
const offPrefs = window.sakura.lyric.onPrefs((value) => {
  config.value = value;
});

onBeforeUnmount(() => offPrefs());

onMounted(async () => {
  try {
    config.value = await window.sakura.getConfig();
    deviceDraft.value = config.value.deviceName;
  } catch {
    config.value = null;
  }
  try {
    appInfo.value = await window.sakura.getAppInfo();
  } catch {
    appInfo.value = null;
  }
  await loadCacheStats();
});

async function loadCacheStats(): Promise<void> {
  try {
    cacheStats.value = await window.sakura.cache.stats();
  } catch {
    cacheStats.value = null;
  }
}

function usageOf(kind: CacheKind): number {
  return cacheStats.value?.kinds.find((item) => item.kind === kind)?.bytes ?? 0;
}

function entriesOf(kind: CacheKind): number {
  return cacheStats.value?.kinds.find((item) => item.kind === kind)?.entries ?? 0;
}

function pickAudioCache(mb: number, label: string): void {
  if (config.value?.audioCacheMb === mb) return;
  void patchConfig({ audioCacheMb: mb }, `音频缓存：${label}`);
}

function pickCoverCache(mb: number, label: string): void {
  if (config.value?.coverCacheMb === mb) return;
  void patchConfig({ coverCacheMb: mb }, `封面缓存：${label}`);
}

function pickLyricTtl(days: number, label: string): void {
  if (config.value?.lyricCacheDays === days) return;
  void patchConfig({ lyricCacheDays: days }, `歌词保留：${label}`);
}

function pickMetaTtl(days: number, label: string): void {
  if (config.value?.metaCacheDays === days) return;
  void patchConfig({ metaCacheDays: days }, `歌曲信息保留：${label}`);
}

function requestClearCache(kind?: CacheKind): void {
  clearConfirmKind.value = kind;
  clearConfirmOpen.value = true;
}

async function confirmClearCache(): Promise<void> {
  const kind = clearConfirmKind.value;
  const label = kind ? CACHE_KIND_LABEL[kind] : '全部缓存';

  cacheBusy.value = true;
  try {
    cacheStats.value = await window.sakura.cache.clear(kind);
    toast.success(`${label}已清理`);
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '清理失败');
  } finally {
    cacheBusy.value = false;
    clearConfirmOpen.value = false;
  }
}

async function patchConfig(patch: DesktopConfigPatch, message: string): Promise<void> {
  saving.value = true;
  try {
    config.value = await window.sakura.updateConfig(patch);
    deviceDraft.value = config.value.deviceName;
    toast.success(message);
    // 调小额度会触发 LRU 清理，占用数字要跟着刷新。
    void loadCacheStats();
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function saveDeviceName(): void {
  const name = deviceDraft.value.trim();
  if (!name) {
    toast.info('设备名不能为空');
    return;
  }
  void patchConfig({ deviceName: name }, '设备名已更新');
}

async function chooseDirectory(): Promise<void> {
  const dir = await window.sakura.chooseDirectory().catch(() => null);
  if (!dir) return;
  await patchConfig({ downloadDir: dir }, '下载目录已更新');
}

function openDownloadDir(): void {
  const dir = config.value?.downloadDir;
  if (dir) void window.sakura.showItemInFolder(dir);
}

const isWindows = window.sakura.platform === 'win32';

function toggleTray(next: boolean): void {
  void patchConfig({ closeToTray: next }, next ? '关闭窗口时收进托盘' : '关闭窗口时直接退出');
}

function toggleDesktopLyric(next: boolean): void {
  // 重新开启时解除锁定，避免窗口刚出现就点不到。
  void patchConfig(
    { desktopLyric: next, lyricLocked: false },
    next ? '桌面歌词已开启' : '桌面歌词已关闭',
  );
}

function toggleTaskbarPreview(next: boolean): void {
  void patchConfig({ taskbarPreview: next }, next ? '任务栏预览已开启' : '任务栏预览已关闭');
}

function toggleLyricLocked(next: boolean): void {
  void patchConfig({ lyricLocked: next }, next ? '歌词已锁定，鼠标可穿透' : '歌词已解锁');
}

function toggleLyricTrans(next: boolean): void {
  void patchConfig({ lyricShowTrans: next }, next ? '显示歌词翻译' : '隐藏歌词翻译');
}

function pickLyricFontSize(value: number, label: string): void {
  if (config.value?.lyricFontSize === value) return;
  void patchConfig({ lyricFontSize: value }, `歌词字号：${label}`);
}

function pickLyricColor(value: string, label: string): void {
  if (config.value?.lyricColor === value) return;
  void patchConfig({ lyricColor: value }, `歌词颜色：${label}`);
}

function pickQuality(quality: Quality): void {
  void player.setQuality(quality);
}

function pickRoute(platform: Platform, mode: RouteMode): void {
  player.setRouteMode(platform, mode);
}

function togglePlatform(platform: Platform, next: boolean): void {
  const error = preferences.setPlatformEnabled(platform, next);
  if (error) toast.error(error);
}

function toggleCapability(platform: Platform, capability: Capability, next: boolean): void {
  const error = preferences.setEnabled(platform, capability, next);
  if (error) toast.error(error);
}

function supportedCapabilities(platform: Platform): Capability[] {
  return CAPABILITIES.filter((capability) => preferences.supports(platform, capability));
}
</script>

<template>
  <div class="settings-view">
    <header class="head">
      <div>
        <p class="eyebrow">设置</p>
        <h1>偏好</h1>
        <p class="head-desc">
          平台开关会同步到云端；播放偏好、缓存与下载位置只影响这台设备。账号资料与第三方绑定在「账户中心」。
        </p>
      </div>
      <span class="chip">{{ auth.serverLabel }}</span>
    </header>

    <!-- 账号相关都在账户中心，这里只留一个入口 -->
    <RouterLink class="account-link" :to="{ name: 'account' }">
      <span class="account-link-icon"><AppIcon name="user" :size="14" /></span>
      <span class="account-link-copy">
        <strong>账号资料与第三方音乐账号</strong>
        <small>修改昵称、绑定网易云 / QQ 音乐、改密码，都在账户中心</small>
      </span>
      <AppIcon name="chevron-right" :size="14" class="account-link-arrow" />
    </RouterLink>

    <!-- 平台 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="sparkles" :size="14" /></span>
          <div>
            <h2>平台开关</h2>
            <p>关掉的平台不参与搜索、推荐与歌单聚合，能力开关决定「能拿它做什么」。</p>
          </div>
        </div>
        <span class="sync" :class="{ 'is-error': preferences.cloudError }">
          <template v-if="preferences.syncing">正在同步…</template>
          <template v-else-if="preferences.cloudError">{{ preferences.cloudError }}</template>
          <template v-else>已同步到云端</template>
        </span>
      </header>

      <div class="panel">
        <article
          v-for="item in preferences.manifest"
          :key="item.platform"
          class="platform"
        >
          <div class="row">
            <div class="row-copy">
              <strong>{{ item.label }}</strong>
              <small>
                {{
                  preferences.isPlatformEnabled(item.platform)
                    ? '已启用'
                    : '已停用 · 不参与搜索与推荐'
                }}
              </small>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="preferences.isPlatformEnabled(item.platform)"
                @change="togglePlatform(item.platform, ($event.target as HTMLInputElement).checked)"
              />
              <span class="track" />
            </label>
          </div>

          <div class="caps" :class="{ muted: !preferences.isPlatformEnabled(item.platform) }">
            <label
              v-for="capability in supportedCapabilities(item.platform)"
              :key="capability"
              class="cap"
            >
              <input
                type="checkbox"
                class="cap-input"
                :checked="preferences.switches[item.platform][capability]"
                :disabled="!preferences.isPlatformEnabled(item.platform)"
                @change="
                  toggleCapability(
                    item.platform,
                    capability,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
              <span class="cap-box">
                <AppIcon name="check" :size="10" :stroke-width="3" />
              </span>
              <span class="cap-copy">
                <strong>{{ CAPABILITY_LABEL[capability] }}</strong>
                <small>{{ CAPABILITY_HINT[capability] }}</small>
              </span>
            </label>
          </div>
        </article>
      </div>
    </section>

    <!-- 播放 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="play" :size="14" filled /></span>
          <div>
            <h2>播放</h2>
            <p>音质降级时播放条会说明原因，不会静默改变你听到的档位。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="row stack">
          <div class="row-copy">
            <strong>默认音质</strong>
            <small>平台没有这一档时会自动降级，并记住你的选择</small>
          </div>
          <div class="options">
            <button
              v-for="quality in PLAY_QUALITIES"
              :key="quality"
              type="button"
              class="option"
              :class="{ active: player.quality === quality }"
              @click="pickQuality(quality)"
            >
              {{ QUALITY_LABEL[quality] }}
            </button>
          </div>
        </div>

        <div v-for="platform in PLATFORMS" :key="platform" class="row stack">
          <div class="row-copy">
            <strong>{{ platformName(platform) }}取流方式</strong>
            <small>
              <template v-if="player.proxyOnly.includes(platform)">
                之前直连失败过，已记住改走中转
              </template>
              <template v-else>直连更省中转带宽；失败会自动回退</template>
            </small>
          </div>
          <div class="options">
            <button
              v-for="option in ROUTE_OPTIONS"
              :key="option.id"
              type="button"
              class="option"
              :class="{ active: (player.routeMode[platform] ?? 'auto') === option.id }"
              @click="pickRoute(platform, option.id)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 缓存 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="server" :size="14" /></span>
          <div>
            <h2>缓存</h2>
            <p>
              音频边播边存；歌词与歌曲信息到期回源，断网时回退旧数据。下载文件不受缓存清理影响。
            </p>
          </div>
        </div>
        <span class="sync">占用 {{ formatBytes(cacheStats?.totalBytes ?? 0) }}</span>
      </header>

      <div class="panel">
        <div v-for="kind in CACHE_KINDS" :key="kind" class="row">
          <div class="row-copy">
            <strong>{{ CACHE_KIND_LABEL[kind] }}</strong>
            <small>{{ CACHE_KIND_HINT[kind] }} · {{ entriesOf(kind) }} 项</small>
          </div>
          <div class="inline">
            <span class="cache-size">{{ formatBytes(usageOf(kind)) }}</span>
            <button
              type="button"
              class="mini"
              :disabled="cacheBusy || usageOf(kind) <= 0"
              @click="requestClearCache(kind)"
            >
              清理
            </button>
          </div>
        </div>

        <div class="row stack">
          <div class="row-copy">
            <strong>音频缓存上限</strong>
            <small>超出后淘汰最久未播放的音频；正在播放的文件会留到下次清理</small>
          </div>
          <div class="options">
            <button
              v-for="option in AUDIO_CACHE_OPTIONS"
              :key="option.value"
              type="button"
              class="option"
              :class="{ active: config?.audioCacheMb === option.value }"
              :disabled="saving"
              @click="pickAudioCache(option.value, option.label)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="row stack">
          <div class="row-copy">
            <strong>封面缓存上限</strong>
            <small>封面与头像统一走本机代理，离线时也能显示已缓存过的图片</small>
          </div>
          <div class="options">
            <button
              v-for="option in COVER_CACHE_OPTIONS"
              :key="option.value"
              type="button"
              class="option"
              :class="{ active: config?.coverCacheMb === option.value }"
              :disabled="saving"
              @click="pickCoverCache(option.value, option.label)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="row stack">
          <div class="row-copy">
            <strong>歌词保留时间</strong>
            <small>过期后下次播放重新拉取；拉取失败时仍显示旧歌词</small>
          </div>
          <div class="options">
            <button
              v-for="option in LYRIC_TTL_OPTIONS"
              :key="option.value"
              type="button"
              class="option"
              :class="{ active: config?.lyricCacheDays === option.value }"
              :disabled="saving"
              @click="pickLyricTtl(option.value, option.label)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="row stack">
          <div class="row-copy">
            <strong>歌曲信息保留时间</strong>
            <small>歌曲、专辑、歌手详情共用这一份保留时间</small>
          </div>
          <div class="options">
            <button
              v-for="option in META_TTL_OPTIONS"
              :key="option.value"
              type="button"
              class="option"
              :class="{ active: config?.metaCacheDays === option.value }"
              :disabled="saving"
              @click="pickMetaTtl(option.value, option.label)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="row-copy">
            <strong>清理全部缓存</strong>
            <small>不会删除已下载到本地的歌曲</small>
          </div>
          <button
            type="button"
            class="mini"
            :disabled="cacheBusy || !cacheStats || cacheStats.totalBytes <= 0"
            @click="requestClearCache()"
          >
            清理全部
          </button>
        </div>
      </div>
    </section>

    <!-- 桌面 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="monitor" :size="14" /></span>
          <div>
            <h2>桌面</h2>
            <p>这些设置只影响这台机器，不会同步到其它设备。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="row">
          <div class="row-copy">
            <strong>设备名</strong>
            <small>多设备遥控时用来认出这台机器</small>
          </div>
          <div class="inline">
            <input v-model="deviceDraft" class="text-input" maxlength="40" :disabled="saving" />
            <button type="button" class="mini primary" :disabled="saving" @click="saveDeviceName">
              保存
            </button>
          </div>
        </div>

        <div class="row">
          <div class="row-copy">
            <strong>关闭窗口时收进托盘</strong>
            <small>收进托盘后播放不中断，点托盘图标可恢复窗口</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="config?.closeToTray ?? true"
              :disabled="saving"
              @change="toggleTray(($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>

        <div class="row">
          <div class="row-copy">
            <strong>歌词页快捷键提示</strong>
            <small>全屏歌词底部那行「空格 播放 / 暂停 · Esc 收起」，关掉后不再出现</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="ui.lyricHints"
              @change="ui.setLyricHints(($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>

        <div class="row">
          <div class="row-copy">
            <strong>桌面歌词</strong>
            <small>置顶的透明歌词条，可拖动摆放；收进托盘后歌词也会继续显示</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="config?.desktopLyric ?? false"
              :disabled="saving"
              @change="toggleDesktopLyric(($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>

        <div v-if="isWindows" class="row">
          <div class="row-copy">
            <strong>任务栏预览</strong>
            <small>鼠标悬到任务栏图标上时，显示封面卡片与上一首 / 播放 / 下一首按钮</small>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="config?.taskbarPreview ?? true"
              :disabled="saving"
              @change="toggleTaskbarPreview(($event.target as HTMLInputElement).checked)"
            />
            <span class="track" />
          </label>
        </div>

        <template v-if="config?.desktopLyric">
          <div class="row">
            <div class="row-copy">
              <strong>锁定桌面歌词</strong>
              <small>锁定后鼠标穿透、不再遮挡操作；可从托盘菜单或这里解锁</small>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="config?.lyricLocked ?? false"
                :disabled="saving"
                @change="toggleLyricLocked(($event.target as HTMLInputElement).checked)"
              />
              <span class="track" />
            </label>
          </div>

          <div class="row stack">
            <div class="row-copy">
              <strong>歌词字号</strong>
            </div>
            <div class="options">
              <button
                v-for="option in LYRIC_FONT_OPTIONS"
                :key="option.value"
                type="button"
                class="option"
                :class="{ active: (config?.lyricFontSize ?? 24) === option.value }"
                @click="pickLyricFontSize(option.value, option.label)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="row stack">
            <div class="row-copy">
              <strong>歌词颜色</strong>
            </div>
            <div class="options">
              <button
                v-for="option in LYRIC_COLOR_OPTIONS"
                :key="option.value"
                type="button"
                class="option"
                :class="{ active: (config?.lyricColor ?? '#ffffff') === option.value }"
                @click="pickLyricColor(option.value, option.label)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="row">
            <div class="row-copy">
              <strong>显示歌词翻译</strong>
              <small>歌曲带翻译时在原词下方小字显示</small>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="config?.lyricShowTrans ?? true"
                :disabled="saving"
                @change="toggleLyricTrans(($event.target as HTMLInputElement).checked)"
              />
              <span class="track" />
            </label>
          </div>
        </template>

        <div class="row">
          <div class="row-copy">
            <strong>下载目录</strong>
            <small class="path" :title="config?.downloadDir ?? ''">
              {{ config?.downloadDir ?? '读取中…' }}
            </small>
          </div>
          <div class="inline">
            <button
              type="button"
              class="mini"
              :disabled="!config?.downloadDir"
              @click="openDownloadDir"
            >
              打开
            </button>
            <button type="button" class="mini" @click="chooseDirectory">选择…</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 快捷键 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="list" :size="14" /></span>
          <div>
            <h2>快捷键</h2>
            <p>在输入框里不生效，避免打断输入。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="shortcuts">
          <div class="shortcut"><span class="keys"><kbd>Space</kbd></span><span>播放 / 暂停</span></div>
          <div class="shortcut">
            <span class="keys"><kbd>←</kbd><kbd>→</kbd></span><span>后退 / 前进 5 秒</span>
          </div>
          <div class="shortcut"><span class="keys"><kbd>N</kbd><kbd>P</kbd></span><span>下一首 / 上一首</span></div>
          <div class="shortcut">
            <span class="keys"><kbd>Ctrl</kbd><kbd>↑</kbd><kbd>↓</kbd></span><span>音量 ±5%</span>
          </div>
          <div class="shortcut"><span class="keys"><kbd>M</kbd></span><span>静音</span></div>
          <div class="shortcut"><span class="keys"><kbd>Q</kbd><kbd>L</kbd></span><span>队列 / 歌词</span></div>
          <div class="shortcut">
            <span class="keys"><kbd>Ctrl</kbd><kbd>F</kbd></span><span>聚焦搜索</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 关于 -->
    <section class="section">
      <header class="section-head">
        <div class="section-title">
          <span class="section-icon"><AppIcon name="shield" :size="14" /></span>
          <div>
            <h2>关于</h2>
            <p>版本、运行环境与开源致谢。</p>
          </div>
        </div>
      </header>

      <div class="panel">
        <div class="about-row">
          <span class="about-version">Sakura Music Desktop {{ appInfo?.version ?? '0.1.0' }}</span>
          <span class="about-meta">{{ appInfo?.platform ?? '' }} {{ appInfo?.arch ?? '' }} · Electron {{ appInfo?.electron ?? '' }}</span>
        </div>
        <div class="about-credit">
          <span>
            部分播放页效果（雾笺 / 绘光 / 町景）移植自开源项目
            <a
              class="about-link"
              href="https://github.com/chthollyphile/folia-major"
              target="_blank"
              rel="noopener noreferrer"
            >
              Folia
              <AppIcon name="external" :size="10" />
            </a>
            ，感谢原作者与所有贡献者。
          </span>
        </div>
        <div class="device-id">
          <span class="device-id-label">设备 ID</span>
          <code>{{ config?.deviceId ?? '—' }}</code>
        </div>
      </div>
    </section>
  </div>

  <ConfirmDialog
    :visible="clearConfirmOpen"
    :title="clearConfirmKind ? `清理${CACHE_KIND_LABEL[clearConfirmKind]}` : '清理全部缓存'"
    message="清理后下次播放或浏览时会重新下载，不影响已下载到本地的歌曲。"
    confirm-label="清理"
    danger
    :busy="cacheBusy"
    @confirm="confirmClearCache"
    @close="clearConfirmOpen = false"
  />
</template>

<style scoped>
.settings-view {
  display: flex;
  max-width: 940px;
  margin: 0 auto;
  flex-direction: column;
  gap: 22px;
  animation: fade-up var(--dur-slow) var(--ease);
}

/* ---------------- 顶部 ---------------- */

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background:
    radial-gradient(
      520px 220px at 6% 0%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 72%
    ),
    linear-gradient(135deg, var(--surface-strong), color-mix(in srgb, var(--surface) 40%, transparent));
  box-shadow: var(--shadow-sm);
}

.head h1 {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.head-desc {
  max-width: 560px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

/* ---------------- 账户入口 ---------------- */

.account-link {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--text);
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.account-link:hover {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.account-link-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}

.account-link-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.account-link-copy strong {
  font-size: 12.5px;
  font-weight: 700;
}

.account-link-copy small {
  color: var(--text-faint);
  font-size: 10.5px;
}

.account-link-arrow {
  flex: none;
  color: var(--text-faint);
}

/* ---------------- 分组：标题在卡片外，卡片本身只装行 ---------------- */

.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  padding: 0 4px;
}

.section-title {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.section-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  color: var(--text-muted);
}

.section-head h2 {
  font-size: 15px;
  font-weight: 750;
  letter-spacing: -0.01em;
}

.section-head p {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
}

.sync {
  flex: none;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}

.sync.is-error {
  border-color: color-mix(in srgb, #e0453a 32%, transparent);
  color: #e0453a;
}

/* 一层卡片装所有行：行之间只用细分隔线，不再一行一个边框。 */
.panel {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
  box-shadow: var(--shadow-sm);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 18px;
  transition: background var(--dur) var(--ease);
}

.panel > .row + .row {
  border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
}

.row:hover {
  background: color-mix(in srgb, var(--surface) 34%, transparent);
}

.row.stack {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.row-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.row-copy strong {
  font-size: 12.5px;
  font-weight: 700;
}

.row-copy small {
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.6;
  word-break: break-all;
}

.row-copy .path {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- 平台 ---------------- */

.platform + .platform {
  border-top: 1px solid var(--border);
}

.platform .row {
  padding-bottom: 6px;
}

.platform .row:hover {
  background: transparent;
}

.caps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 2px 20px;
  padding: 0 18px 14px;
  transition: opacity var(--dur) var(--ease);
}

.caps.muted {
  opacity: 0.45;
}

/* 能力项不再各占一个带边框的小盒子，做成朴素的勾选行。 */
.cap {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 9px;
  padding: 6px 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.cap-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.cap-box {
  display: grid;
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 1px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: transparent;
  color: transparent;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.cap:hover .cap-box {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
}

.cap-input:checked + .cap-box {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.cap-input:focus-visible + .cap-box {
  outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 2px;
}

.cap-input:disabled + .cap-box {
  opacity: 0.5;
}

.cap-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.cap-copy strong {
  font-size: 11.5px;
  font-weight: 650;
}

.cap-copy small {
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.5;
}

/* ---------------- 选项 ---------------- */

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.option {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.option:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.option.active {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------------- 输入与按钮 ---------------- */

.inline {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
}

.text-input {
  width: 200px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.text-input:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.cache-size {
  min-width: 64px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.mini {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 4px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.mini:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.mini:disabled {
  opacity: 0.55;
  cursor: default;
}

.mini.primary {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-soft);
  color: var(--accent);
}

.mini.primary:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  color: var(--accent);
}

/* ---------------- 开关 ---------------- */

.switch {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  cursor: pointer;
}

.switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.switch .track {
  position: relative;
  display: block;
  width: 38px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}

.switch .track::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface-strong);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  content: '';
  transition: transform var(--dur) var(--ease);
}

.switch input:checked + .track {
  background: var(--accent);
}

.switch input:checked + .track::after {
  transform: translateX(16px);
}

.switch input:focus-visible + .track {
  outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent);
  outline-offset: 2px;
}

/* ---------------- 快捷键 ---------------- */

/* 快捷键做成一张「对照表」：左键位、右说明，行间用虚线分隔。 */
.shortcuts {
  display: flex;
  flex-direction: column;
  padding: 4px 18px;
}

.shortcut {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 0;
  color: var(--text-muted);
  font-size: 11.5px;
}

.shortcut + .shortcut {
  border-top: 1px dashed color-mix(in srgb, var(--border) 72%, transparent);
}

.shortcut > span:last-child {
  margin-left: auto;
  color: var(--text-faint);
  text-align: right;
}

.shortcut .keys {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  min-width: 96px;
}

.shortcut kbd {
  display: inline-flex;
  min-width: 22px;
  height: 21px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--surface-hover);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 10px;
}

/* ---------------- 关于 ---------------- */

.about-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 18px;
}

.about-version {
  font-size: 12.5px;
  font-weight: 700;
}

.about-meta {
  color: var(--text-faint);
  font-size: 10.5px;
}

.about-credit {
  padding: 12px 18px;
  border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.8;
}

.about-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
}

.about-link:hover {
  text-decoration: underline;
}

.device-id {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px 14px;
  border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
}

.device-id-label {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 650;
}

.device-id code {
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- 窄窗口 ---------------- */

@media (max-width: 720px) {
  .row {
    flex-wrap: wrap;
    gap: 12px;
  }

  .inline {
    width: 100%;
  }

  .text-input {
    flex: 1;
    width: auto;
  }

  .shortcut .keys {
    min-width: 76px;
  }
}
</style>
