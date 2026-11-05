import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { platformMetaApi, preferenceApi } from '@/api/preferences';
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  PLATFORM_LABEL,
  PLATFORMS,
  type Capability,
  type Platform,
  type PlatformManifest,
} from '@/api/types';
import { useAuthStore } from './auth';

/**
 * 平台开关偏好，只存云端。
 *
 * 本地 localStorage 那份只是首屏快照，真正以云端为准，每次启动拉一遍。
 * 两级开关：
 *  - 平台总开关：关掉即该平台不参与任何功能；
 *  - 能力开关：平台启用后，逐项决定它参与搜索 / 推荐 / 账号歌单。
 *    关平台不会清掉能力值，重新打开时按原样恢复。
 */

export type PlatformSwitches = Record<Platform, Record<Capability, boolean>>;
export type PlatformEnabled = Record<Platform, boolean>;

const CACHE_KEY = 'sakura.preferences.platforms';
const CLOUD_KEY = 'platforms';

function defaults(): PlatformSwitches {
  const result = {} as PlatformSwitches;
  for (const platform of PLATFORMS) {
    result[platform] = { search: true, discover: true, library: true };
  }
  return result;
}

/** 认知范围外的值一律退回默认：偏好被改坏不该让设置页打不开。 */
function sanitize(input: unknown): PlatformSwitches {
  const result = defaults();
  const raw = (input ?? {}) as Partial<Record<Platform, Partial<Record<Capability, unknown>>>>;
  for (const platform of PLATFORMS) {
    const stored = raw[platform];
    if (!stored) continue;
    for (const capability of CAPABILITIES) {
      const value = stored[capability];
      if (typeof value === 'boolean') result[platform][capability] = value;
    }
  }
  return result;
}

function defaultsEnabled(): PlatformEnabled {
  const result = {} as PlatformEnabled;
  for (const platform of PLATFORMS) result[platform] = true;
  return result;
}

/** 老版本没有 enabled 字段：一律当作平台启用。 */
function sanitizeEnabled(input: unknown): PlatformEnabled {
  const result = defaultsEnabled();
  const raw = (input ?? {}) as Partial<Record<Platform, unknown>>;
  for (const platform of PLATFORMS) {
    if (typeof raw[platform] === 'boolean') result[platform] = raw[platform];
  }
  return result;
}

function readCache(): { switches: PlatformSwitches; enabled: PlatformEnabled } {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as {
      switches?: unknown;
      enabled?: unknown;
    };
    return { switches: sanitize(raw.switches), enabled: sanitizeEnabled(raw.enabled) };
  } catch {
    return { switches: defaults(), enabled: defaultsEnabled() };
  }
}

/** 服务端没响应时的兜底清单：按「全平台、全能力」处理，至少不挡住开关。 */
function fallbackManifest(): PlatformManifest[] {
  return PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    capabilities: { search: true, discover: true, library: true },
  }));
}

export const usePreferencesStore = defineStore('preferences', () => {
  const auth = useAuthStore();
  const cached = readCache();

  const switches = ref<PlatformSwitches>(cached.switches);
  const enabled = ref<PlatformEnabled>(cached.enabled);
  const manifest = ref<PlatformManifest[]>(fallbackManifest());
  const cloudUpdatedAt = ref<string | null>(null);
  const syncing = ref(false);
  const cloudError = ref('');

  /** 平台是否声明支持这个能力；没声明（旧网关）时按支持处理。 */
  function supports(platform: Platform, capability: Capability): boolean {
    const item = manifest.value.find((entry) => entry.platform === platform);
    return item ? item.capabilities[capability] !== false : true;
  }

  function isPlatformEnabled(platform: Platform): boolean {
    return enabled.value[platform];
  }

  function isEnabled(platform: Platform, capability: Capability): boolean {
    return (
      isPlatformEnabled(platform) &&
      supports(platform, capability) &&
      switches.value[platform][capability]
    );
  }

  /** 某个能力下启用的平台，顺序固定，可直接拼进请求参数。 */
  function enabledPlatforms(capability: Capability): Platform[] {
    return PLATFORMS.filter((platform) => isEnabled(platform, capability));
  }

  /**
   * 请求参数用的平台串。
   *
   * 全部启用时返回 `undefined`：让请求与「没有这个功能」时完全一致，
   * 也避免缓存键因为参数写法不同而分裂。
   */
  function enabledParam(capability: Capability): string | undefined {
    const list = enabledPlatforms(capability);
    return list.length === PLATFORMS.length ? undefined : list.join(',');
  }

  /** 平台总开关开着、且至少有一项能力开着的平台。 */
  const activePlatforms = computed(() =>
    PLATFORMS.filter(
      (platform) =>
        isPlatformEnabled(platform) &&
        CAPABILITIES.some((capability) => isEnabled(platform, capability)),
    ),
  );

  function isActive(platform: Platform): boolean {
    return activePlatforms.value.includes(platform);
  }

  function cache(): void {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ switches: switches.value, enabled: enabled.value }),
      );
    } catch {
      // 写不进去只是少了首屏快照，云端那份仍是最新。
    }
  }

  watch([switches, enabled], cache, { deep: true });

  async function pushCloud(): Promise<void> {
    if (!auth.isAuthenticated) {
      cloudError.value = '登录后才能把设置同步到云端';
      return;
    }

    syncing.value = true;
    try {
      const entry = await preferenceApi.put(CLOUD_KEY, {
        switches: switches.value,
        enabled: enabled.value,
      });
      cloudUpdatedAt.value = entry.updatedAt;
      cloudError.value = '';
    } catch (caught) {
      cloudError.value = caught instanceof Error ? caught.message : '云端保存失败';
    } finally {
      syncing.value = false;
    }
  }

  /** 云端 → 本机。云端还没有这份配置时，把当前这份推上去。 */
  async function pullCloud(): Promise<void> {
    if (!auth.isAuthenticated) return;

    syncing.value = true;
    try {
      const { items } = await preferenceApi.list();
      const entry = items.find((item) => item.key === CLOUD_KEY);
      if (entry) {
        const value = entry.value as { switches?: unknown; enabled?: unknown } | null;
        switches.value = sanitize(value?.switches);
        enabled.value = sanitizeEnabled(value?.enabled);
        cloudUpdatedAt.value = entry.updatedAt;
      } else {
        await pushCloud();
      }
      cloudError.value = '';
    } catch (caught) {
      cloudError.value = caught instanceof Error ? caught.message : '云端读取失败';
    } finally {
      syncing.value = false;
    }
  }

  /**
   * 平台总开关。关掉即停用该平台的一切，但保留各能力开关的值。
   * 返回错误文案（null 表示成功），由调用方 toast。
   */
  function setPlatformEnabled(platform: Platform, next: boolean): string | null {
    if (!next) {
      const rest = PLATFORMS.filter((item) => item !== platform && isEnabled(item, 'search'));
      if (rest.length === 0) return '至少要保留一个可搜索的平台，否则搜索会没有结果';
    }

    enabled.value[platform] = next;
    void pushCloud();
    return null;
  }

  /** 切换单项能力；返回错误文案，store 不自己弹 toast。 */
  function setEnabled(platform: Platform, capability: Capability, next: boolean): string | null {
    if (!next && capability === 'search') {
      const rest = PLATFORMS.filter((item) => item !== platform && isEnabled(item, 'search'));
      if (rest.length === 0) return `至少要保留一个平台的「${CAPABILITY_LABEL.search}」`;
    }

    switches.value[platform][capability] = next;
    void pushCloud();
    return null;
  }

  /** 拉平台清单（静态能力），失败时保留兜底清单。 */
  async function loadManifest(): Promise<void> {
    try {
      const { items } = await platformMetaApi.list();
      const known = items.filter((item) => PLATFORMS.includes(item.platform));
      if (known.length > 0) manifest.value = known;
    } catch {
      // 清单只决定渲染哪些开关，拿不到不影响本机开关生效。
    }
  }

  async function initialize(): Promise<void> {
    await loadManifest();
    await pullCloud();
  }

  /** 幂等初始化：页面各自调用，只会真正拉一次。 */
  let initTask: Promise<void> | null = null;
  function ensureInitialized(): Promise<void> {
    if (!initTask) initTask = initialize();
    return initTask;
  }

  return {
    switches,
    enabled,
    manifest,
    cloudUpdatedAt,
    syncing,
    cloudError,
    activePlatforms,
    supports,
    isPlatformEnabled,
    isEnabled,
    enabledPlatforms,
    enabledParam,
    isActive,
    pushCloud,
    pullCloud,
    setPlatformEnabled,
    setEnabled,
    loadManifest,
    initialize,
    ensureInitialized,
  };
});
