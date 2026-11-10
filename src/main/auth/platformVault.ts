import { safeStorage } from 'electron';
import { deleteKv, getKv, setKv } from '../db/kv';

/**
 * 平台凭据保险库（「仅本机」模式）。
 *
 * 扫码后在弹窗里选「仅本机」时，凭据不回服务器，而是加密存在本地 SQLite 的
 * kv 表，并由主进程在每次网关请求里注入 `X-Sakura-Credential`（base64url(JSON)）。
 * 渲染进程从头到尾看不到凭据。
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

const STORED_VERSION = 1;
const VAULT_KEY = 'platform_credentials';

let cache: VaultMap | null = null;

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

  const raw = getKv(VAULT_KEY);
  if (!raw) {
    cache = {};
    return cache;
  }

  try {
    const stored = JSON.parse(raw) as StoredVault;
    cache = decode(stored) ?? {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(map: VaultMap): void {
  const text = JSON.stringify(map);
  let encrypted = safeStorage.isEncryptionAvailable();
  let data = '';

  if (encrypted) {
    try {
      data = safeStorage.encryptString(text).toString('base64');
    } catch {
      // 与 cookieVault 一致：声明可用但实际缺 keyring 时退化为明文记录。
      encrypted = false;
    }
  }
  if (!encrypted) data = Buffer.from(text, 'utf8').toString('base64');

  const stored: StoredVault = { v: STORED_VERSION, encrypted, data };
  setKv(VAULT_KEY, JSON.stringify(stored));
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
    deleteKv(VAULT_KEY);
  } catch {
    // 删不掉记录也不影响内存里的清理。
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
