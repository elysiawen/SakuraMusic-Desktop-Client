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
    cacheLimitMb: 2048,
    downloadDir: defaultDownloadDir(),
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
  const cacheLimitMb = Number(raw.cacheLimitMb);

  return {
    baseUrl,
    allowInvalidCert: raw.allowInvalidCert === true,
    deviceId: deviceId.length >= 8 && deviceId.length <= 64 ? deviceId : fallback.deviceId,
    deviceName: deviceName || fallback.deviceName,
    closeToTray: raw.closeToTray !== false,
    cacheLimitMb: Number.isFinite(cacheLimitMb)
      ? Math.min(102400, Math.max(128, Math.round(cacheLimitMb)))
      : fallback.cacheLimitMb,
    downloadDir: downloadDir || fallback.downloadDir,
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
  const next = sanitize({ ...getConfig(), ...patch });
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
