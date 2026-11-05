import { createWriteStream, renameSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { OfflineDownloadRequest, OfflineItem } from '@shared/offline';
import { openDirect } from '../bff/media';
import {
  openGatewayStream,
  requestGatewayJson,
  type GatewayClientOptions,
} from '../bff/gateway';
import { getConfig } from '../config/store';
import { downloadRoot, finalSize, upsertItem, type StoredOfflineItem } from './store';

/**
 * 下载一首歌到本地。
 *
 * 走的是和播放同一条路：`/api/play/resolve` 拿地址 → 优先直连 CDN（附带防盗链头）
 * → 失败回退网关流。文件先写 `.part`，完整写完才改名为正式文件并登记索引，
 * 中途断掉不会留下一个能被索引到的半成品。
 */

interface DirectTarget {
  url: string;
  headers?: Record<string, string>;
}

interface ResolvedSource {
  /** 网关路径（`/api/stream?...`）。 */
  url?: string;
  direct?: DirectTarget;
}

interface WrittenFile {
  mime: string;
  bytes: number;
}

/** 下载进度：`total` 为 0 表示上游没给长度，界面上按不确定进度处理。 */
export interface DownloadProgress {
  key: string;
  received: number;
  total: number;
}

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

function clientOptions(): GatewayClientOptions {
  const config = getConfig();
  return { baseUrl: config.baseUrl, allowInvalidCert: config.allowInvalidCert };
}

function normalizeMime(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? 'audio/mpeg').split(';')[0]?.trim().toLowerCase() || 'audio/mpeg';
}

function extensionFor(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

/** 文件名去掉 Windows/macOS 不接受的字符，再截断，避免超长路径。 */
function fileNameBase(input: OfflineDownloadRequest): string {
  const artist = input.artists[0] ?? '';
  const raw = [input.title, artist].filter(Boolean).join(' - ') || 'untitled';
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const suffix = input.id.replace(/[^\w-]/g, '').slice(-8) || 'track';
  return `${cleaned || 'untitled'} [${suffix}]`;
}

async function resolveSource(input: OfflineDownloadRequest): Promise<ResolvedSource> {
  const config = getConfig();
  if (!config.baseUrl) throw new Error('还没有配置 Sakura Music 服务器');

  const response = await requestGatewayJson(clientOptions(), '/api/play/resolve', {
    method: 'POST',
    body: Buffer.from(
      JSON.stringify({ platform: input.platform, id: input.id, quality: input.quality }),
    ),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 20000,
  });

  if (response.status !== 200) {
    throw new Error(`取流失败（${response.status}），请稍后再试`);
  }

  const parsed = JSON.parse(response.body.toString('utf8')) as ResolvedSource;
  if (!parsed.url && !parsed.direct?.url) {
    throw new Error('平台没有返回可下载的地址');
  }
  return parsed;
}

function writeToFile(
  stream: IncomingMessage,
  path: string,
  key: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<WrittenFile> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(path);
    const total = Number(stream.headers['content-length'] ?? 0) || 0;
    let bytes = 0;
    let lastEmit = 0;

    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      const now = Date.now();
      // 4 秒的曲子会来几千个 chunk：节流到 250ms，避免刷爆 SSE。
      if (onProgress && now - lastEmit >= 250) {
        lastEmit = now;
        onProgress({ key, received: bytes, total });
      }
    });
    stream.on('error', (error) => {
      output.destroy();
      reject(error);
    });
    output.on('error', (error) => {
      stream.destroy();
      reject(error);
    });
    output.on('finish', () => {
      onProgress?.({ key, received: bytes, total: total || bytes });
      resolve({ mime: normalizeMime(stream.headers['content-type']), bytes });
    });

    stream.pipe(output);
  });
}

async function fetchToFile(
  source: ResolvedSource,
  path: string,
  key: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<WrittenFile> {
  if (source.direct?.url) {
    try {
      const target = new URL(source.direct.url);
      const direct = await openDirect(target, source.direct.headers ?? {}, 'GET', undefined, 3);
      if (direct) return await writeToFile(direct.stream, path, key, onProgress);
    } catch {
      // 直连失败就落到网关，和播放时的回退策略一致。
    }
  }

  if (!source.url) throw new Error('平台没有返回可下载的地址');

  const upstream = await openGatewayStream(clientOptions(), source.url, {
    method: 'GET',
    headers: { Accept: '*/*' },
    timeoutMs: 20000,
  });

  if (upstream.status >= 400) {
    upstream.stream.resume();
    throw new Error(`音频源返回 ${upstream.status}`);
  }

  return writeToFile(upstream.stream, path, key, onProgress);
}

export async function downloadTrack(
  input: OfflineDownloadRequest,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<OfflineItem> {
  const source = await resolveSource(input);

  const root = downloadRoot();
  const base = fileNameBase(input);
  const tmp = join(root, `${base}.part`);

  let written: WrittenFile;
  try {
    written = await fetchToFile(source, tmp, input.key, onProgress);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  if (written.bytes === 0) {
    rmSync(tmp, { force: true });
    throw new Error('下载到的文件是空的，请换个音质再试');
  }

  const fileName = `${base}.${extensionFor(written.mime)}`;
  const finalPath = join(root, fileName);

  // 重新下载同一首时文件名一样：Windows 上 rename 到已存在的目标会失败，先删。
  rmSync(finalPath, { force: true });
  renameSync(tmp, finalPath);

  const item: StoredOfflineItem = {
    key: input.key,
    platform: input.platform,
    id: input.id,
    quality: input.quality,
    title: input.title,
    artists: input.artists,
    albumName: input.albumName,
    albumCover: input.albumCover,
    durationMs: input.durationMs,
    bytes: written.bytes || finalSize(finalPath),
    createdAt: new Date().toISOString(),
    fileName,
    mime: written.mime,
  };

  upsertItem(item);
  return item;
}
