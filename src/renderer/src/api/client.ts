import type { ApiErrorPayload } from './types';

/**
 * 渲染进程的 API 客户端。
 *
 * 所有请求都是相对 `/api`，页面固定在 `sakura://app`：dev 与 release 都由主进程的
 * 协议层转发到进程内 BFF，会话 Cookie 不在渲染进程里，它由主进程维护。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const target = withQuery(path, options.query);
  const response = await fetch(target, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    signal: options.signal,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as ApiErrorPayload | null)?.error;
    const code = error?.code ?? 'request_failed';
    const message = error?.message ?? `请求失败（${response.status}）`;

    // 只有服务端明确判定为 unauthorized 的 401 才是会话失效。
    // 其他 401（比如登录密码错、平台临时流 token 过期、BFF 代理层返回的 401）
    // 交给各自的调用方去处理，不触发全局登出。
    if (response.status === 401 && code === 'unauthorized') {
      window.dispatchEvent(new CustomEvent('sakura:auth-expired'));
    }

    throw new ApiError(response.status, code, message);
  }

  return payload as T;
}
