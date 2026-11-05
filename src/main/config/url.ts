/**
 * 服务器地址规范化。
 *
 * 允许用户只输入 `192.168.1.10:8787`：没有协议时补 `http://`。
 * 末尾的 `/` 与 `/api` 一并剥掉——网关的接口自己带 `/api` 前缀，用户多写一层不该变成 `/api/api`。
 */
export class InvalidServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServerUrlError';
  }
}

export function normalizeBaseUrl(raw: string): string {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidServerUrlError('服务器地址格式不正确，请填写 http:// 或 https:// 开头的地址');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidServerUrlError('只支持 http:// 或 https:// 的服务器地址');
  }
  if (!url.hostname) {
    throw new InvalidServerUrlError('服务器地址缺少主机名');
  }

  url.hash = '';
  url.search = '';

  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.toLowerCase().endsWith('/api')) {
    pathname = pathname.slice(0, -4).replace(/\/+$/, '');
  }

  return `${url.origin}${pathname}`;
}
