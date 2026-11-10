import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { DesktopConfig, WindowBounds } from '@shared/ipc';
import { getKv, setKv } from '../db/kv';
import { normalizeBaseUrl } from './url';

/**
 * 桌面端配置：服务器地址、TLS 开关、设备标识、缓存/下载位置。
 * 存在 SQLite 的 kv 表（一行 JSON），读写前后同样逐字段清洗。
 * 必须在 initDatabase() 之后调用。
 */

const CONFIG_KEY = 'config';

let cached: DesktopConfig | null = null;

export function defaultDownloadDir(): string {
  return join(app.getPath('userData'), 'downloads');
}

function platformLabel(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

function defaultConfig(): DesktopConfig {
  return {
    baseUrl: '',
    allowInvalidCert: false,
    deviceId: randomUUID(),
    deviceName: `${hostname()} · ${platformLabel()}`.slice(0, 40),
    closeToTray: true,
    audioCacheMb: 1024,
    coverCacheMb: 128,
    lyricCacheDays: 30,
    metaCacheDays: 7,
    downloadDir: defaultDownloadDir(),
    desktopLyric: false,
    lyricLocked: false,
    lyricFontSize: 32,
    lyricColor: '#ffffff',
    lyricShowTrans: true,
    lyricX: null,
    lyricY: null,
    mainWindowBounds: null,
    mainWindowMaximized: false,
    nowPlayingBounds: null,
    taskbarPreview: true,
  };
}

function sanitize(input: Partial<DesktopConfig> | null | undefined): DesktopConfig {
  const fallback = defaultConfig();
  const raw = input ?? {};

  let baseUrl = '';
  try {
    baseUrl = normalizeBaseUrl(String(raw.baseUrl ?? ''));
  } catch {
    baseUrl = '';
  }

  const deviceId = String(raw.deviceId ?? '').trim();
  const deviceName = String(raw.deviceName ?? '').trim().slice(0, 40);
  const downloadDir = String(raw.downloadDir ?? '').trim();
  const audioCacheMb = Number(raw.audioCacheMb);
  const coverCacheMb = Number(raw.coverCacheMb);
  const lyricCacheDays = Number(raw.lyricCacheDays);
  const metaCacheDays = Number(raw.metaCacheDays);

  // 缓存额度允许 0（不缓存）与 -1（不限），其余按 0–102400 MB 收敛。
  const cacheMb = (value: number, fallback: number): number => {
    if (value === -1) return -1;
    return Number.isFinite(value)
      ? Math.min(102400, Math.max(0, Math.round(value)))
      : fallback;
  };
  // 保留天数允许 -1（永久），其余至少 1 天。
  const retentionDays = (value: number, fallback: number): number => {
    if (value === -1) return -1;
    return Number.isFinite(value) ? Math.min(3650, Math.max(1, Math.round(value))) : fallback;
  };

  const lyricFontSize = Number(raw.lyricFontSize);
  const lyricColor = String(raw.lyricColor ?? '');
  const position = (value: unknown): number | null => {
    // null 表示「还没摆过位置」，不能落成 0——否则歌词窗口会跑到屏幕左上角。
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : null;
  };
  const bounds = (value: unknown): WindowBounds | null => {
    // 配置可能被手改/损坏：只接受能还原出正常窗口的整数几何，
    // 否则退回默认尺寸（屏幕收敛在创建窗口时做）。
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<WindowBounds>;
    const nums = [raw.x, raw.y, raw.width, raw.height];
    if (!nums.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) return null;
    const [x, y, width, height] = nums as number[];
    if (width < 320 || height < 240 || width > 20000 || height > 20000) return null;
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null;
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  };

  return {
    baseUrl,
    allowInvalidCert: raw.allowInvalidCert === true,
    deviceId: deviceId.length >= 8 && deviceId.length <= 64 ? deviceId : fallback.deviceId,
    deviceName: deviceName || fallback.deviceName,
    closeToTray: raw.closeToTray !== false,
    audioCacheMb: cacheMb(audioCacheMb, fallback.audioCacheMb),
    coverCacheMb: cacheMb(coverCacheMb, fallback.coverCacheMb),
    lyricCacheDays: retentionDays(lyricCacheDays, fallback.lyricCacheDays),
    metaCacheDays: retentionDays(metaCacheDays, fallback.metaCacheDays),
    downloadDir: downloadDir || fallback.downloadDir,
    desktopLyric: raw.desktopLyric === true,
    lyricLocked: raw.lyricLocked === true,
    lyricFontSize: Number.isFinite(lyricFontSize)
      ? Math.min(48, Math.max(16, Math.round(lyricFontSize)))
      : fallback.lyricFontSize,
    lyricColor: /^#[0-9a-f]{6}$/i.test(lyricColor) ? lyricColor : fallback.lyricColor,
    lyricShowTrans: raw.lyricShowTrans !== false,
    lyricX: position(raw.lyricX),
    lyricY: position(raw.lyricY),
    mainWindowBounds: bounds(raw.mainWindowBounds),
    mainWindowMaximized: raw.mainWindowMaximized === true,
    nowPlayingBounds: bounds(raw.nowPlayingBounds),
    // 缺省为开：配置记录里没这个字段时也要默认启用。
    taskbarPreview: raw.taskbarPreview !== false,
  };
}

function persist(config: DesktopConfig): void {
  setKv(CONFIG_KEY, JSON.stringify(config));
}

export function getConfig(): DesktopConfig {
  if (cached) return cached;

  const raw = getKv(CONFIG_KEY);
  if (!raw) {
    cached = defaultConfig();
    persist(cached);
    return cached;
  }

  try {
    cached = sanitize(JSON.parse(raw) as Partial<DesktopConfig>);
  } catch {
    // 记录损坏时退回默认值（会生成新的设备 id），再写回一份干净的。
    cached = defaultConfig();
  }
  persist(cached);
  return cached;
}

export function saveConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  // 只把真正给了值的字段合并进来：`config:update` 会把未提供的字段解构成 undefined，
  // 直接展开会把已有配置（比如 desktopLyric）覆盖成默认值。
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<DesktopConfig>;
  const next = sanitize({ ...getConfig(), ...defined });
  cached = next;
  persist(next);
  return next;
}

export function saveServer(input: { baseUrl: string; allowInvalidCert: boolean }): DesktopConfig {
  return saveConfig({
    baseUrl: normalizeBaseUrl(input.baseUrl),
    allowInvalidCert: input.allowInvalidCert === true,
  });
}

export function clearServer(): DesktopConfig {
  return saveConfig({ baseUrl: '', allowInvalidCert: false });
}
