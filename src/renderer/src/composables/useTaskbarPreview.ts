import { onBeforeUnmount, watch } from 'vue';
import type { TaskbarPreviewCommand } from '@shared/ipc';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { cachedImage } from '@/utils/cacheImage';

/**
 * Windows 任务栏缩略图预览的素材来源（仅主窗口挂一次）。
 *
 * 主进程不能画 UI，所以卡片和按钮图标都在这里用 canvas 画好，转成原始像素推过去：
 *  - 卡片 320x200、bottom-up BGRA、**alpha 已预乘**（DWM 的 iconic thumbnail 要 PARGB）；
 *  - 图标 32x32 PNG，主进程用 `CreateIconFromResourceEx` 转成 HICON 挂到缩略图工具栏。
 *
 * 只在切歌 / 播放暂停时重画一次，不跟着播放进度走。
 */

const WIDTH = 320;
const HEIGHT = 200;
const ICON_SIZE = 32;
/** 一次点击可能被重复投递；短窗口内的同一命令只认第一条。 */
const COMMAND_DEBOUNCE_MS = 250;

type IconKind = 'prev' | 'play' | 'pause' | 'next';

function triangle(ctx: CanvasRenderingContext2D, points: Array<[number, number]>): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fill();
}

/** 缩略图按钮图标：白色实心几何图形 + 透明底。 */
function makeIcon(kind: IconKind): string {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  if (kind === 'prev') {
    ctx.fillRect(6, 8, 4, 16);
    triangle(ctx, [
      [25, 8],
      [25, 24],
      [12, 16],
    ]);
  } else if (kind === 'next') {
    triangle(ctx, [
      [7, 8],
      [7, 24],
      [20, 16],
    ]);
    ctx.fillRect(22, 8, 4, 16);
  } else if (kind === 'play') {
    triangle(ctx, [
      [11, 6],
      [11, 26],
      [26, 16],
    ]);
  } else {
    ctx.fillRect(9, 7, 5, 18);
    ctx.fillRect(18, 7, 5, 18);
  }

  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function makeIcons(): { prev: string; play: string; pause: string; next: string } {
  return {
    prev: makeIcon('prev'),
    play: makeIcon('play'),
    pause: makeIcon('pause'),
    next: makeIcon('next'),
  };
}

/** 封面走主进程的同源缓存代理，canvas 不会被跨域图片污染。 */
function loadCover(url: string | null | undefined): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const src = cachedImage(url);
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    let settled = false;
    const done = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), 3000);
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

function paint(
  ctx: CanvasRenderingContext2D,
  track: UnifiedTrack | null,
  cover: HTMLImageElement | null,
): void {
  ctx.fillStyle = '#2b2b31';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 顶栏：品牌标记 + 歌名 / 歌手，和 QQ 音乐那张预览卡片同一套信息层次。
  ctx.fillStyle = '#e0453a';
  ctx.beginPath();
  ctx.roundRect(12, 9, 22, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♪', 23, 20);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 14px sans-serif';
  ctx.fillText(ellipsis(ctx, track?.title ?? 'Sakura Music', 270), 44, 16);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
  ctx.font = '11px sans-serif';
  const artist = track?.artists.map((item) => item.name).join(' / ') || '未在播放';
  ctx.fillText(ellipsis(ctx, artist, 270), 44, 32);

  // 中间方形封面。
  const size = 132;
  const x = (WIDTH - size) / 2;
  const y = 46;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 6);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, x, y, size, size);
  } else {
    const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
    gradient.addColorStop(0, '#4a3f68');
    gradient.addColorStop(1, '#1f2b45');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '600 52px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', WIDTH / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

/** RGBA(top-down) → BGRA(bottom-up, alpha 预乘)。 */
function toPixels(image: ImageData): Uint8Array {
  const out = new Uint8Array(WIDTH * HEIGHT * 4);
  const data = image.data;
  for (let row = 0; row < HEIGHT; row += 1) {
    const sourceRow = HEIGHT - 1 - row;
    for (let x = 0; x < WIDTH; x += 1) {
      const from = (sourceRow * WIDTH + x) * 4;
      const to = (row * WIDTH + x) * 4;
      const alpha = data[from + 3] / 255;
      out[to] = Math.round(data[from + 2] * alpha);
      out[to + 1] = Math.round(data[from + 1] * alpha);
      out[to + 2] = Math.round(data[from] * alpha);
      out[to + 3] = data[from + 3];
    }
  }
  return out;
}

function renderCard(
  track: UnifiedTrack | null,
  cover: HTMLImageElement | null,
): Uint8Array {
  // 万一封面污染了 canvas（代理返回跨域重定向），重画一张不带封面的再读。
  for (const attempt of [0, 1]) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) break;
    paint(ctx, track, attempt === 0 ? cover : null);
    try {
      return toPixels(ctx.getImageData(0, 0, WIDTH, HEIGHT));
    } catch {
      // 换下一次尝试；两张都失败就交一张透明卡片。
    }
  }
  return new Uint8Array(WIDTH * HEIGHT * 4);
}

export function useTaskbarPreview(): void {
  if (window.sakura.platform !== 'win32') return;

  const player = usePlayerStore();
  const room = useRoomStore();
  const transport = useTransport();
  const toast = useToast();
  const icons = makeIcons();
  let generation = 0;
  let lastPixels = renderCard(null, null);
  let lastKey: string | null = null;
  let lastCover: string | null = null;
  let lastCommand: { name: TaskbarPreviewCommand; at: number } | null = null;

  /** 一起听占席位时播放态以房间为准，和 PlayerBar 的 shownPlaying 同一口径。 */
  const shownPlaying = (): boolean => (room.seatActive ? room.playing : player.playing);

  const off = window.sakura.taskbarPreview.onCommand((command) => {
    // 任务栏连发、IPC 重发、订阅重复都会把一次点击变成两次动作。
    const now = Date.now();
    if (lastCommand?.name === command && now - lastCommand.at < COMMAND_DEBOUNCE_MS) {
      window.sakura.taskbarPreview.ack(`DEBOUNCED ${command}`);
      return;
    }
    lastCommand = { name: command, at: now };
    window.sakura.taskbarPreview.ack(
      `RECEIVED ${command} playing=${shownPlaying()} seatActive=${room.seatActive} current=${player.current?.key ?? 'none'} queue=${player.queue.length}`,
    );

    /*
     * 必须走 transport，不能直接动 player：一起听是服务端权威，本机播放器会被
     * 250ms 一次的房间镜像循环拽回当前曲目，听感就是「顿一下又接着放」。
     */
    if (command === 'play') {
      const wasPlaying = shownPlaying();
      transport.toggle();
      toast.info(wasPlaying ? '已暂停' : '继续播放', 1400);
    } else if (command === 'prev') {
      transport.prev();
      toast.info('上一首', 1400);
    } else {
      transport.next();
      toast.info('下一首', 1400);
    }
    window.sakura.taskbarPreview.ack(`ACTION ${command} done playing=${shownPlaying()}`);
  });

  function push(track: UnifiedTrack | null, playing: boolean, pixels: Uint8Array): void {
    const artist = track?.artists.map((item) => item.name).join(' / ') ?? '';
    window.sakura.taskbarPreview.push({
      width: WIDTH,
      height: HEIGHT,
      pixels,
      icons,
      playing,
      tooltip: track ? `${track.title}${artist ? ` - ${artist}` : ''}` : 'Sakura Music',
    });
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    const track = player.current;
    lastKey = track?.key ?? null;
    lastCover = track?.album.cover ?? null;
    const cover = await loadCover(track?.album.cover);
    if (current !== generation) return; // 期间又切歌了，丢掉这次结果。
    const pixels = renderCard(track, cover);
    lastPixels = pixels;
    push(track, shownPlaying(), pixels);
  }

  // 启动先推一帧：即使还没播放，图标和卡片也要先给主进程。
  push(null, shownPlaying(), lastPixels);
  void refresh();

  const stop = watch(
    () => [
      player.current?.key ?? null,
      shownPlaying(),
      player.current?.album.cover ?? null,
      room.seatActive,
    ],
    () => {
      const key = player.current?.key ?? null;
      const cover = player.current?.album.cover ?? null;
      if (key !== lastKey || cover !== lastCover) {
        void refresh();
      } else {
        // 播放/暂停只换按钮图标，卡片复用上一帧像素。
        push(player.current, shownPlaying(), lastPixels);
      }
    },
  );

  onBeforeUnmount(() => {
    stop();
    off();
  });
}
