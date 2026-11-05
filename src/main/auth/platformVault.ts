import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * 平台凭据保险库（「仅本机」模式）。
 *
 * 扫码后在弹窗里选「仅本机」时，凭据不回服务器，而是加密存在本机，并由主进程在每次
 * 网关请求里注入 `X-Sakura-Credential`（base64url(JSON)）。渲染进程从头到尾看不到凭据。
 *
 * 与 `cookieVault` 是两件事：那里是 Sakura 账号的会话令牌，这里是第三方平台的登录态。
 */

export type PlatformKey = 'netease' | 'qq';

type VaultMap = Partial<Record<PlatformKey, string>>;

interface StoredVault {
  v: number;
  encrypted: boolean;
  data: string;
}

const FILE_VERSION = 1;

let cache: VaultMap | null = null;

function vaultFile(): string {
  return join(app.getPath('userData'), 'platform-credentials.bin');
}

function decode(stored: StoredVault): VaultMap | null {
  try {
    let text: string | null = null;
    if (stored.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      text = safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    } else {
      text = Buffer.from(stored.data, 'base64').toString('utf8');
    }
    if (!text) return null;

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const map: VaultMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((key === 'netease' || key === 'qq') && typeof value === 'string' && value) {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return null;
  }
}

function readVault(): VaultMap {
  if (cache) return cache;

  const file = vaultFile();
  if (!existsSync(file)) {
    cache = {};
    return cache;
  }

  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredVault;
    cache = decode(stored) ?? {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(map: VaultMap): void {
  const file = vaultFile();
  mkdirSync(dirname(file), { recursive: true });

  const text = JSON.stringify(map);
  let encrypted = safeStorage.isEncryptionAvailable();
  let data = '';

  if (encrypted) {
    try {
      data = safeStorage.encryptString(text).toString('base64');
    } catch {
      // 与 cookieVault 一致：声明可用但实际缺 keyring 时退化为 0600 明文。
      encrypted = false;
    }
  }
  if (!encrypted) data = Buffer.from(text, 'utf8').toString('base64');

  const stored: StoredVault = { v: FILE_VERSION, encrypted, data };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);

  cache = map;
}

/** 本机存着凭据的平台列表。 */
export function listLocalPlatforms(): PlatformKey[] {
  return Object.keys(readVault()) as PlatformKey[];
}

export function savePlatformCredential(platform: PlatformKey, cookie: string): void {
  const value = cookie.trim();
  if (!value) return;
  persist({ ...readVault(), [platform]: value });
}

export function clearPlatformCredential(platform: PlatformKey): void {
  const map = { ...readVault() };
  delete map[platform];
  persist(map);
}

/** 清空全部本机平台凭据（换服务器或退出登录时用）。 */
export function clearAllPlatformCredentials(): void {
  cache = {};
  try {
    rmSync(vaultFile(), { force: true });
  } catch {
    // 删不掉文件也不影响内存里的清理。
  }
}

/**
 * 给网关请求用的凭据头；没有本机凭据时返回 undefined。
 *
 * 格式与 Web 端一致：`base64url(JSON.stringify({ netease?: cookie, qq?: cookie }))`。
 */
export function platformCredentialHeader(): string | undefined {
  const map = readVault();
  if (Object.keys(map).length === 0) return undefined;
  return Buffer.from(JSON.stringify(map), 'utf8').toString('base64url');
}
