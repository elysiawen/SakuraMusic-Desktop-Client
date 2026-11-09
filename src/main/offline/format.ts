import { closeSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * 离线文件的真实格式判定。
 *
 * 之前只看音频响应的 `Content-Type`：CDN 对无损/母带这类流常常回
 * `application/octet-stream`，映射表查不到就兜底成 `.bin` —— 文件其实是完整的
 * FLAC。而且索引里存的也是这个错误 MIME，`/offline/stream` 带 `nosniff` 回放时
 * 同样会出问题。
 *
 * 所以按可靠程度依次判定：
 *   1. 文件头（magic bytes）：已经落盘的字节说了算，与响应头、URL 都无关；
 *   2. `Content-Type`：只认明确的音频类型，`application/octet-stream` 之类不算；
 *   3. 直链 URL 的路径后缀：网易云的 URL 后缀未必与实际格式一致，只作兜底；
 *   4. 实在认不出才按 `mp3` 处理 —— 不再产生 `.bin`。
 *
 * 同时给出规范的 MIME，写进索引供本地回放使用。
 */

export interface AudioFormat {
  /** 不带点的扩展名。 */
  ext: string;
  /** 写进索引、本地回放时作为 Content-Type 的规范 MIME。 */
  mime: string;
}

export const AUDIO_FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  aac: { ext: 'aac', mime: 'audio/aac' },
  flac: { ext: 'flac', mime: 'audio/flac' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  opus: { ext: 'opus', mime: 'audio/ogg' },
  wav: { ext: 'wav', mime: 'audio/wav' },
  webm: { ext: 'webm', mime: 'audio/webm' },
  wma: { ext: 'wma', mime: 'audio/x-ms-wma' },
  ape: { ext: 'ape', mime: 'audio/x-ape' },
  aiff: { ext: 'aiff', mime: 'audio/aiff' },
  wv: { ext: 'wv', mime: 'audio/x-wavpack' },
  amr: { ext: 'amr', mime: 'audio/amr' },
  dsf: { ext: 'dsf', mime: 'audio/dsf' },
  dff: { ext: 'dff', mime: 'audio/dff' },
  mpc: { ext: 'mpc', mime: 'audio/x-musepack' },
  tta: { ext: 'tta', mime: 'audio/x-tta' },
} satisfies Record<string, AudioFormat>;

type FormatKey = keyof typeof AUDIO_FORMATS;

const MIME_TO_FORMAT: Record<string, FormatKey> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4a-latm': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'application/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/x-ogg': 'ogg',
  'application/ogg': 'ogg',
  'application/x-ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'audio/x-ms-wma': 'wma',
  'audio/wma': 'wma',
  'audio/x-ape': 'ape',
  'audio/ape': 'ape',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/x-wavpack': 'wv',
  'audio/amr': 'amr',
  'audio/dsf': 'dsf',
  'audio/dff': 'dff',
  'audio/x-musepack': 'mpc',
  'audio/x-tta': 'tta',
};

const EXT_TO_FORMAT: Record<string, FormatKey> = {
  mp3: 'mp3',
  mpga: 'mp3',
  m4a: 'm4a',
  mp4: 'm4a',
  m4b: 'm4a',
  aac: 'aac',
  flac: 'flac',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'opus',
  wav: 'wav',
  wave: 'wav',
  webm: 'webm',
  wma: 'wma',
  ape: 'ape',
  aif: 'aiff',
  aiff: 'aiff',
  aifc: 'aiff',
  wv: 'wv',
  amr: 'amr',
  dsf: 'dsf',
  dff: 'dff',
  mpc: 'mpc',
  tta: 'tta',
};

/** 去掉 `;charset=...` 之类参数，统一小写。缺头就返回空串（不要猜成 mp3）。 */
export function normalizeMime(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() || '';
}

export function formatFromMime(value: string): AudioFormat | null {
  const mime = normalizeMime(value);
  const key = MIME_TO_FORMAT[mime];
  return key ? AUDIO_FORMATS[key] : null;
}

/** 传入带点或不带点的扩展名、完整文件名都可以。 */
export function formatFromExtension(value: string): AudioFormat | null {
  const ext = extname(value).replace(/^\./, '').toLowerCase() || value.replace(/^\./, '').toLowerCase();
  const key = EXT_TO_FORMAT[ext];
  return key ? AUDIO_FORMATS[key] : null;
}

/** 直链后缀只作兜底：查询串、加密参数都不参与判定。 */
export function formatFromUrl(value: string): AudioFormat | null {
  if (!value) return null;
  let path = value;
  try {
    path = new URL(value).pathname;
  } catch {
    // `/api/stream?t=...` 这类相对路径：截掉查询串即可，反正没有后缀。
    path = value.split('?')[0] ?? '';
  }
  return formatFromExtension(extname(path));
}

/** 只读开头几 KB：一首无损可能有上百 MB，不能整文件读进内存。 */
export function readHead(path: string, length = 4096): Buffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.alloc(length);
    const size = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, Math.max(0, size));
  } catch {
    return Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
}

function ascii(head: Buffer, start: number, length: number): string {
  return head.subarray(start, start + length).toString('latin1');
}

/** 上游偶尔用 200 返回 HTML / JSON 错误页，写进下载目录只会得到一个假音频。 */
export function isNonAudioPayload(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return true;
  const text = head.subarray(0, 96).toString('utf8').trimStart().toLowerCase();
  return (
    text.startsWith('<!doctype') ||
    text.startsWith('<html') ||
    text.startsWith('<?xml') ||
    text.startsWith('<error') ||
    text.startsWith('{') ||
    text.startsWith('[') ||
    text.startsWith('%pdf')
  );
}

/** 常见音频容器的文件头。认不出返回 null，交由 MIME / URL 兜底。 */
export function sniffAudioFormat(head: Buffer): AudioFormat | null {
  if (head.length < 4) return null;

  if (ascii(head, 0, 4) === 'fLaC') return AUDIO_FORMATS.flac;
  // 少数 FLAC 前面挂了 ID3 标签：fLaC 后面必须跟着合法的 metadata block 头，
  // 免得把 MP3 的 ID3 标签里恰好出现的 "fLaC" 文本误认成无损。
  const flacAt = head.indexOf(Buffer.from('fLaC'), 0);
  if (flacAt > 0 && flacAt <= 64 && (head[flacAt + 4] & 0x7f) <= 6) {
    return AUDIO_FORMATS.flac;
  }

  if (ascii(head, 0, 4) === 'OggS') {
    return head.includes(Buffer.from('OpusHead')) ? AUDIO_FORMATS.opus : AUDIO_FORMATS.ogg;
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return AUDIO_FORMATS.wav;
  if (ascii(head, 0, 4) === 'FORM') {
    const kind = ascii(head, 8, 4);
    if (kind === 'AIFF' || kind === 'AIFC') return AUDIO_FORMATS.aiff;
    if (kind === 'DSD ') return AUDIO_FORMATS.dff;
  }
  // MP4 / M4A：第 5~8 字节是 ftyp。
  if (ascii(head, 4, 4) === 'ftyp') return AUDIO_FORMATS.m4a;
  if (ascii(head, 0, 4) === 'EBML') return AUDIO_FORMATS.webm;

  if (ascii(head, 0, 3) === 'ID3') return AUDIO_FORMATS.mp3;
  if (ascii(head, 0, 4) === 'MAC ') return AUDIO_FORMATS.ape;
  if (ascii(head, 0, 4) === 'wvpk') return AUDIO_FORMATS.wv;
  if (ascii(head, 0, 4) === 'DSD ') return AUDIO_FORMATS.dsf;
  if (ascii(head, 0, 4) === 'MPCK' || ascii(head, 0, 3) === 'MP+') return AUDIO_FORMATS.mpc;
  if (ascii(head, 0, 4) === 'TTA1') return AUDIO_FORMATS.tta;
  if (ascii(head, 0, 5) === '#!AMR') return AUDIO_FORMATS.amr;

  // ASF (WMA) 固定 GUID 开头。
  if (
    head[0] === 0x30 &&
    head[1] === 0x26 &&
    head[2] === 0xb2 &&
    head[3] === 0x75
  ) {
    return AUDIO_FORMATS.wma;
  }

  // 无容器头的裸流：ADTS AAC 与 MPEG 音频帧都以 0xFFE 同步字开头。
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return (head[1] & 0xf6) === 0xf0 ? AUDIO_FORMATS.aac : AUDIO_FORMATS.mp3;
  }

  return null;
}

/** 综合判定，永远返回一个可用格式（默认 mp3），不会再有 `.bin`。 */
export function detectAudioFormat(
  path: string,
  mime: string,
  url?: string,
): AudioFormat {
  const head = readHead(path);
  return (
    sniffAudioFormat(head) ??
    formatFromMime(mime) ??
    (url ? formatFromUrl(url) : null) ??
    AUDIO_FORMATS.mp3
  );
}

