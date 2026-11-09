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
import {
  detectAudioFormat,
  isNonAudioPayload,
  normalizeMime,
  readHead,
} from './format';
import {
  downloadRoot,
  finalSize,
  findItem,
  upsertItem,
  type StoredOfflineItem,
} from './store';

/**
 * 下载一首歌到本地。
 *
 * 走的是和播放同一条路：`/api/play/resolve` 拿地址 → 优先直连 CDN（附带防盗链头）
 * → 失败回退网关流。文件先写 `.part`，完整写完才改名为正式文件并登记索引，
 * 中途断掉不会留下一个能被索引到的半成品。
 *
 * 扩展名由写完的文件头决定（见 format.ts），不再依赖 CDN 的 Content-Type ——
 * 无损流常被标成 `application/octet-stream`，以前会落成 `.bin`。
 */

interface DirectTarget {
  url: string;
  headers?: Record<string, string>;
}

interface ResolvedSource {
  /** 网关路径（`/api/stream?...`）。 */
  url?: string;
  direct?: DirectTarget;
  /** 平台实际给的档位：会员/版权不够时与请求的音质不同。 */
  actualQuality?: string;
}

interface WrittenFile {
  /** 上游原始的 Content-Type（可能不准，只作为兜底线索）。 */
  mime: string;
  bytes: number;
  /** 实际取流的地址，用于后缀兜底。 */
  sourceUrl: string;
}

/** 下载进度：`total` 为 0 表示上游没给长度，界面上按不确定进度处理。 */
export interface DownloadProgress {
  key: string;
  received: number;
  total: number;
}

function clientOptions(): GatewayClientOptions {
  const config = getConfig();
  return { baseUrl: config.baseUrl, allowInvalidCert: config.allowInvalidCert };
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
  sourceUrl: string,
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
      resolve({
        mime: normalizeMime(stream.headers['content-type']),
        bytes,
        sourceUrl,
      });
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
      if (direct) {
        return await writeToFile(direct.stream, path, key, source.direct.url, onProgress);
      }
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

  return writeToFile(upstream.stream, path, key, source.url, onProgress);
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

  if (isNonAudioPayload(readHead(tmp))) {
    rmSync(tmp, { force: true });
    throw new Error('音频源返回了错误页而不是音频，请换个音质再试');
  }

  // 文件头说了算：无损流即使被标成 application/octet-stream 也会落成 .flac。
  const format = detectAudioFormat(tmp, written.mime, written.sourceUrl);
  const fileName = `${base}.${format.ext}`;
  const finalPath = join(root, fileName);

  // 换音质重下时后缀可能变（flac → mp3），旧文件得一起删，别在目录里留孤儿。
  const previous = findItem(input.key);
  if (previous && previous.fileName !== fileName) {
    rmSync(join(root, previous.fileName), { force: true });
  }
  // 重新下载同一首时文件名一样：Windows 上 rename 到已存在的目标会失败，先删。
  rmSync(finalPath, { force: true });
  renameSync(tmp, finalPath);

  const item: StoredOfflineItem = {
    key: input.key,
    platform: input.platform,
    id: input.id,
    quality: input.quality,
    actualQuality: source.actualQuality,
    title: input.title,
    artists: input.artists,
    albumName: input.albumName,
    albumCover: input.albumCover,
    durationMs: input.durationMs,
    bytes: written.bytes || finalSize(finalPath),
    createdAt: new Date().toISOString(),
    fileName,
    mime: format.mime,
  };

  upsertItem(item);
  return item;
}
