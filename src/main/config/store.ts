import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { DesktopConfig } from '@shared/ipc';
import { normalizeBaseUrl } from './url';

/**
 * 桌面端配置：服务器地址、TLS 开关、设备标识、缓存/下载位置。
 * 存 JSON，写入用「临时文件 + 改名」避免半截文件把配置写坏。
 */

let cached: DesktopConfig | null = null;

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

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
    // 缺省为开：老配置文件里没这个字段时也要默认启用。
    taskbarPreview: raw.taskbarPreview !== false,
  };
}

function persist(config: DesktopConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function getConfig(): DesktopConfig {
  if (cached) return cached;

  const file = configPath();
  if (!existsSync(file)) {
    cached = defaultConfig();
    persist(cached);
    return cached;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopConfig>;
    cached = sanitize(parsed);
  } catch {
    // 配置文件损坏时退回默认值，但保留设备 id 让对端还能认出这台设备。
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
