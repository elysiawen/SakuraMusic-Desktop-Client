import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { app } from 'electron';
import type { HealthPayload, ProbeErrorCode, ServerCertificateInfo, ServerProbeResult } from '@shared/ipc';
import { sessionCookieHeader } from '../auth/cookieVault';
import { normalizeBaseUrl } from '../config/url';

/**
 * 网关 HTTP 客户端。
 *
 * 用 `node:http` / `node:https` 而不是 fetch：自签名证书要能按服务器单独放开
 * （`rejectUnauthorized`），同时 SSE 与音频流需要原样 pipe，不能被中间层缓冲。
 */

const MAX_JSON_BODY = 8 * 1024 * 1024;
const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class GatewayError extends Error {
  constructor(
    readonly code: Exclude<ProbeErrorCode, 'invalid_url' | 'not_sakura'> | 'http',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  allowInvalidCert: boolean;
}

export interface GatewayJsonResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface GatewayStreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
}

type HeaderMap = Record<string, string | number>;

interface RequestInitLike {
  method?: string;
  body?: Buffer;
  headers?: HeaderMap;
  timeoutMs?: number;
}

function buildOptions(
  client: GatewayClientOptions,
  path: string,
  method: string,
  headers: HeaderMap,
): { isHttps: boolean; options: https.RequestOptions } {
  const url = new URL(client.baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const requestPath = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
  const isHttps = url.protocol === 'https:';

  const cookie = sessionCookieHeader();
  const merged: HeaderMap = {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'User-Agent': `SakuraDesktop/${app.getVersion()}`,
    ...headers,
  };
  if (cookie) merged.Cookie = cookie;

  return {
    isHttps,
    options: {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: requestPath,
      method,
      headers: merged,
      // 只有 https 会读这个字段；http 请求传了也无害。
      rejectUnauthorized: !client.allowInvalidCert,
    },
  };
}

function toGatewayError(error: unknown): GatewayError {
  const err = error as NodeJS.ErrnoException & { message?: string };
  const code = String(err?.code ?? '');
  if (CERT_ERROR_CODES.has(code)) {
    return new GatewayError('certificate', '服务器证书不受信任');
  }
  if (code === 'ETIMEDOUT' || err?.message === 'timeout') {
    return new GatewayError('timeout', '连接服务器超时');
  }
  if (code) {
    return new GatewayError('network', `无法连接服务器（${code}）`);
  }
  return new GatewayError('network', err?.message || '无法连接服务器');
}

/** 普通 JSON 请求：收集完整响应体，供 BFF 转发或启动探测使用。 */
export function requestGatewayJson(
  client: GatewayClientOptions,
  path: string,
  init: RequestInitLike = {},
): Promise<GatewayJsonResponse> {
  return new Promise((resolve, reject) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: HeaderMap = { ...(init.headers ?? {}) };
    if (init.body && init.body.length > 0) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      headers['Content-Length'] = init.body.length;
    }

    const { isHttps, options } = buildOptions(client, path, method, headers);
    const transport = (isHttps ? https : http) as typeof https;

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_JSON_BODY) {
          req.destroy(new Error('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (error) => reject(toGatewayError(error)));
    });

    req.setTimeout(init.timeoutMs ?? 15000, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => reject(toGatewayError(error)));
    if (init.body && init.body.length > 0) req.write(init.body);
    req.end();
  });
}

/**
 * 流式请求：SSE 与音频使用。
 *
 * 只对「拿到响应头」这一步设超时；响应开始后清掉 socket 超时，
 * 否则长连接会在 15 秒后被自己掐断。
 */
export function openGatewayStream(
  client: GatewayClientOptions,
  path: string,
  init: RequestInitLike = {},
): Promise<GatewayStreamResponse> {
  return new Promise((resolve, reject) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const { isHttps, options } = buildOptions(client, path, method, init.headers ?? {});
    const transport = (isHttps ? https : http) as typeof https;

    const req = transport.request(options, (res) => {
      req.setTimeout(0);
      res.setTimeout(0);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        stream: res,
      });
    });

    req.setTimeout(init.timeoutMs ?? 15000, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => reject(toGatewayError(error)));
    req.end();
  });
}

/** 读取 HTTPS 证书信息（不受信任也读），用于首次连接时给用户看指纹。 */
export function probeCertificate(baseUrl: string): Promise<ServerCertificateInfo | null> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return Promise.resolve(null);
  }
  if (url.protocol !== 'https:') return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ServerCertificateInfo | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const socket = tls.connect(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: 6000,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.fingerprint256) {
            finish(null);
          } else {
            finish({
              subject: formatName(cert.subject),
              issuer: formatName(cert.issuer),
              fingerprint256: cert.fingerprint256,
              validFrom: cert.valid_from ?? '',
              validTo: cert.valid_to ?? '',
            });
          }
        } catch {
          finish(null);
        } finally {
          socket.end();
        }
      },
    );

    socket.on('error', () => finish(null));
    socket.on('timeout', () => {
      socket.destroy();
      finish(null);
    });
  });
}

function formatName(name: unknown): string {
  if (!name || typeof name !== 'object') return '';
  return Object.entries(name as Record<string, string>)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

/** 首次启动的「测试连接」。只认 Sakura 网关自己的健康检查形状。 */
export async function probeServer(
  rawBaseUrl: string,
  allowInvalidCert: boolean,
): Promise<ServerProbeResult> {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_url',
      error: error instanceof Error ? error.message : '服务器地址格式不正确',
    };
  }

  if (!baseUrl) {
    return { ok: false, code: 'invalid_url', error: '请填写服务器地址' };
  }

  const client: GatewayClientOptions = { baseUrl, allowInvalidCert };

  try {
    const response = await requestGatewayJson(client, '/api/health', { timeoutMs: 8000 });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch {
      parsed = null;
    }

    if (response.status !== 200) {
      return {
        ok: false,
        baseUrl,
        status: response.status,
        code: 'http',
        error: `服务器返回 ${response.status}`,
      };
    }

    const health = parsed as Partial<HealthPayload> | null;
    if (!health || health.ok !== true || !health.upstreams) {
      return {
        ok: false,
        baseUrl,
        status: response.status,
        code: 'not_sakura',
        error: '这个地址不是 Sakura Music 网关（/api/health 返回的形状不对）',
      };
    }

    return {
      ok: true,
      baseUrl,
      status: response.status,
      health: health as HealthPayload,
    };
  } catch (error) {
    if (error instanceof GatewayError) {
      if (error.code === 'certificate') {
        const certificate = await probeCertificate(baseUrl);
        return {
          ok: false,
          baseUrl,
          code: 'certificate',
          error:
            '服务器证书不受信任。确认这是你自己的服务器后，勾选「允许自签名证书」再试。',
          certificate: certificate ?? undefined,
        };
      }
      return {
        ok: false,
        baseUrl,
        code: error.code === 'http' ? 'http' : error.code,
        status: error.status,
        error: error.message,
      };
    }
    return {
      ok: false,
      baseUrl,
      code: 'network',
      error: error instanceof Error ? error.message : '连接失败',
    };
  }
}
