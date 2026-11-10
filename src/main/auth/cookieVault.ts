import { safeStorage } from 'electron';
import { deleteKv, getKv, setKv } from '../db/kv';

/**
 * 会话 Cookie 保险库。
 *
 * 网关的登录态是 HttpOnly Cookie `sakura_session`。桌面端不把它交给渲染进程：
 * 主进程截获 `Set-Cookie` 后加密写入本地 SQLite 的 kv 表，后续所有网关请求由 BFF 注入。
 *
 * safeStorage 在 Linux 上可能因为缺少 libsecret 而不可用，此时退化为明文记录；
 * 库文件在 POSIX 上是 0600 权限，这种情况会在日志里明确提示一次。
 */

const SESSION_COOKIE = 'sakura_session';
const SESSION_KEY = 'session';
const STORED_VERSION = 1;

interface StoredSession {
  v: number;
  encrypted: boolean;
  data: string;
}

let memoryCookie: string | null = null;
let loaded = false;
let warnedPlaintext = false;

function readStored(): StoredSession | null {
  const raw = getKv(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

function decodeStored(stored: StoredSession): string | null {
  try {
    if (stored.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const buffer = Buffer.from(stored.data, 'base64');
      return safeStorage.decryptString(buffer);
    }
    return Buffer.from(stored.data, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function persist(value: string): void {
  let encrypted = safeStorage.isEncryptionAvailable();
  let data = '';
  if (encrypted) {
    try {
      data = safeStorage.encryptString(value).toString('base64');
    } catch {
      // 某些 Linux 桌面声明可用、实际缺 keyring；退化为明文记录而不是让登录失败。
      encrypted = false;
    }
  }
  if (!encrypted) {
    data = Buffer.from(value, 'utf8').toString('base64');
    if (!warnedPlaintext) {
      warnedPlaintext = true;
      console.warn(
        '[sakura] 系统安全存储不可用，会话令牌将以明文记录保存在本地数据库（库文件 0600）。' +
          'Linux 上安装 libsecret / gnome-keyring 可恢复加密。',
      );
    }
  }

  const stored: StoredSession = {
    v: STORED_VERSION,
    encrypted,
    data,
  };
  setKv(SESSION_KEY, JSON.stringify(stored));
}

/** 读取会话令牌；没有登录态时返回 null。 */
export function getSessionToken(): string | null {
  if (loaded) return memoryCookie;
  loaded = true;

  const stored = readStored();
  if (!stored) return null;
  memoryCookie = decodeStored(stored);
  if (!memoryCookie) {
    clearSessionCookie();
    return null;
  }
  return memoryCookie;
}

export function hasSessionCookie(): boolean {
  return Boolean(getSessionToken());
}

/** BFF 转发网关请求时使用。 */
export function sessionCookieHeader(): string | undefined {
  const token = getSessionToken();
  return token ? `${SESSION_COOKIE}=${token}` : undefined;
}

function writeCookie(value: string): void {
  const token = value.trim();
  if (!token) {
    clearSessionCookie();
    return;
  }
  memoryCookie = token;
  loaded = true;
  persist(token);
}

/**
 * 从上游响应的 `Set-Cookie` 里捕获会话令牌。
 *
 * 网关登出时会下发一个过期 Cookie（空值或 Max-Age=0），这里同样要处理，
 * 否则内存里会继续留着一个已经失效的令牌。
 */
export function captureSetCookie(setCookie: string[] | undefined): void {
  if (!setCookie || setCookie.length === 0) return;

  for (const cookie of setCookie) {
    const first = cookie.split(';', 1)[0] ?? '';
    const eq = first.indexOf('=');
    if (eq < 0) continue;

    const name = first.slice(0, eq).trim();
    if (name !== SESSION_COOKIE) continue;

    const value = first.slice(eq + 1).trim();
    const lowered = cookie.toLowerCase();
    const expired = lowered.includes('max-age=0') || lowered.includes('expires=thu, 01 jan 1970');

    if (!value || expired) {
      clearSessionCookie();
      return;
    }
    writeCookie(value);
    return;
  }
}

export function clearSessionCookie(): void {
  memoryCookie = null;
  loaded = true;
  try {
    deleteKv(SESSION_KEY);
  } catch {
    // 删除失败不影响内存中的登录态清理。
  }
}
