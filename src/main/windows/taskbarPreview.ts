/**
 * Windows 任务栏缩略图预览（QQ 音乐 / 网易云那种「鼠标悬到任务栏图标上」的卡片）。
 *
 * 分两件事，Electron 都没直接给 API，所以用 koffi 补：
 *  1. **自绘预览卡片**：`DwmSetWindowAttribute` 打开 iconic thumbnail，DWM 发
 *     `WM_DWMSENDICONICTHUMBNAIL` 要图时，把渲染端用 canvas 画好的 BGRA 像素写进
 *     32bpp DIB section，再 `DwmSetIconicThumbnail` 交上去。
 *  2. **缩略图工具栏按钮**：`CoCreateInstance(CLSID_TaskbarList, IID_ITaskbarList3)`，
 *     调 vtable 里的 `ThumbBarAddButtons` 挂上一首/播放/下一首；点击会发 `WM_COMMAND`
 *     到主窗口，转成 IPC 命令交给播放器。
 *
 * 窗口消息不替换 WndProc、也不做子类化：Electron 自带 `hookWindowMessage`，由它正确
 * 转发消息，比在 Chromium 窗口上挂 koffi 回调安全得多。COM 调用走 `koffi.call` 直接
 * 调 vtable 里的函数指针（项目里 Win10 圆角已经用了同一套 koffi）。
 *
 * 仅 Windows 生效；任何一步失败都静默退回「系统默认窗口缩略图」，绝不影响播放。
 */

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  DesktopConfig,
  TaskbarPreviewCommand,
  TaskbarPreviewImage,
} from '@shared/ipc';

/* ---------------------------------- 常量 ---------------------------------- */

const LOG_FILE = join(tmpdir(), 'sakura-taskbar-preview.log');

/** 真机链路诊断：逐环节写到 %TEMP%，定位完按钮点击问题后移除。 */
export function logTaskbarPreview(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // 日志失败绝不能影响播放与预览。
  }
}

const WM_COMMAND = 0x0111;
const WM_DWMSENDICONICTHUMBNAIL = 0x0323;

/** DWMWA_FORCE_ICONIC_REPRESENTATION / DWMWA_HAS_ICONIC_BITMAP。 */
const DWMWA_FORCE_ICONIC_REPRESENTATION = 7;
const DWMWA_HAS_ICONIC_BITMAP = 10;

/** 缩略图按钮的自定义命令 ID（WM_COMMAND 的低 16 位）。 */
const ID_PREV = 40001;
const ID_PLAY = 40002;
const ID_NEXT = 40003;

const THB_ICON = 0x2;
const THB_FLAGS = 0x8;
const THBF_ENABLED = 0;
const THBF_HIDDEN = 0x8;

const CLSCTX_ALL = 0x17;
const COINIT_APARTMENTTHREADED = 0x2;

/** 渲染端约定的卡片尺寸；DWM 请求时主进程再按上限缩放。 */
const CARD_WIDTH = 320;
const CARD_HEIGHT = 200;

/**
 * ITaskbarList3 的 vtable 槽位（IUnknown 3 + ITaskbarList 5 + ITaskbarList2 1 = 9）。
 * 顺序按 Windows API Code Pack 里微软自己的 ComImport 声明，改动前务必核对头文件：
 * 调错槽位会直接跳进别的 COM 方法。
 */
const VTBL_RELEASE = 2;
const VTBL_HRINIT = 3;
const VTBL_THUMBBAR_ADD_BUTTONS = 15;
const VTBL_THUMBBAR_UPDATE_BUTTONS = 16;

const CLSID_TASKBAR_LIST = {
  Data1: 0x56fdf344,
  Data2: 0xfd6d,
  Data3: 0x11d0,
  Data4: [0x95, 0x8a, 0x00, 0x60, 0x97, 0xc9, 0xa0, 0x90],
};
const IID_ITASKBAR_LIST3 = {
  Data1: 0xea1afb91,
  Data2: 0x9e28,
  Data3: 0x4b86,
  Data4: [0x90, 0xe9, 0x9e, 0x9f, 0x8a, 0x5e, 0xef, 0xaf],
};

const POINTER_SIZE = process.arch === 'ia32' ? 4 : 8;
const ZERO_TIP = new Array<number>(260).fill(0);

/* ------------------------------- 原生 API 封装 ------------------------------- */

type AnyFn = (...args: any[]) => any;
type KoffiType = import('koffi').TypeObject;

interface Native {
  koffi: typeof import('koffi');
  registerWindowMessage: (name: string) => number;
  getDC: () => unknown;
  releaseDC: (hdc: unknown) => void;
  createDIBSection: (hdc: unknown, bmi: unknown) => unknown;
  setDIBits: (
    hdc: unknown,
    hbmp: unknown,
    height: number,
    pixels: Buffer,
    bmi: unknown,
  ) => number;
  deleteObject: (obj: unknown) => void;
  createIcon: (base64: string) => unknown;
  destroyIcon: (icon: unknown) => void;
  dwmAttribute: (hwnd: unknown, attr: number, value: boolean) => void;
  dwmThumbnail: (hwnd: unknown, hbmp: unknown) => void;
  createTaskbar: () => unknown;
  comCall: (ptr: unknown, slot: number, proto: KoffiType, ...args: unknown[]) => number;
  protos: {
    hrInit: KoffiType;
    addButtons: KoffiType;
    updateButtons: KoffiType;
    release: KoffiType;
  };
  bitmapInfo: (width: number, height: number) => unknown;
}

let nativeCache: Native | null = null;
let loadFailed = false;

function loadNative(): Native | null {
  if (nativeCache) return nativeCache;
  if (loadFailed || process.platform !== 'win32') return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');

    koffi.struct('GUID', {
      Data1: 'uint32',
      Data2: 'uint16',
      Data3: 'uint16',
      Data4: koffi.array('uint8', 8),
    });
    const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    });
    koffi.struct('BITMAPINFO', {
      bmiHeader: BITMAPINFOHEADER,
      bmiColors: koffi.array('uint32', 1),
    });
    // x64 下 hIcon 是 8 字节、szTip 是 WCHAR[260]；koffi.struct 会按平台自动对齐。
    koffi.struct('THUMBBUTTON', {
      dwMask: 'uint32',
      iId: 'uint32',
      iBitmap: 'uint32',
      hIcon: 'void*',
      szTip: koffi.array('char16', 260),
      dwFlags: 'uint32',
    });

    const protos = {
      hrInit: koffi.proto('int32 __stdcall HrInit(void *self)'),
      addButtons: koffi.proto(
        'int32 __stdcall ThumbBarAddButtons(void *self, void *hwnd, uint32 count, THUMBBUTTON *buttons)',
      ),
      updateButtons: koffi.proto(
        'int32 __stdcall ThumbBarUpdateButtons(void *self, void *hwnd, uint32 count, THUMBBUTTON *buttons)',
      ),
      release: koffi.proto('uint32 __stdcall Release(void *self)'),
    };

    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const ole32 = koffi.load('ole32.dll');

    const registerWindowMessage: AnyFn = user32.func(
      'uint32 __stdcall RegisterWindowMessageW(str16 name)',
    );
    // GetDC / ReleaseDC 在 user32，不在 gdi32；CreateDIBSection / SetDIBits 才在 gdi32。
    const getDC: AnyFn = user32.func('void *__stdcall GetDC(void *hwnd)');
    const releaseDC: AnyFn = user32.func('int32 __stdcall ReleaseDC(void *hwnd, void *hdc)');
    const createDIBSection: AnyFn = gdi32.func(
      'void *__stdcall CreateDIBSection(void *hdc, BITMAPINFO *pbmi, uint32 usage, _Out_ void **ppvBits, void *section, uint32 offset)',
    );
    const setDIBits: AnyFn = gdi32.func(
      'int32 __stdcall SetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, const void *bits, BITMAPINFO *pbmi, uint32 colorUse)',
    );
    const deleteObject: AnyFn = gdi32.func('int32 __stdcall DeleteObject(void *obj)');
    const createIconFromResource: AnyFn = user32.func(
      'void *__stdcall CreateIconFromResourceEx(const void *bits, uint32 size, int32 icon, uint32 version, int32 cx, int32 cy, uint32 flags)',
    );
    const destroyIcon: AnyFn = user32.func('int32 __stdcall DestroyIcon(void *icon)');
    const dwmSetWindowAttribute: AnyFn = dwmapi.func(
      'int32 __stdcall DwmSetWindowAttribute(void *hwnd, uint32 attr, const void *value, uint32 size)',
    );
    const dwmSetIconicThumbnail: AnyFn = dwmapi.func(
      'int32 __stdcall DwmSetIconicThumbnail(void *hwnd, void *hbmp, uint32 flags)',
    );
    const coInitializeEx: AnyFn = ole32.func(
      'int32 __stdcall CoInitializeEx(void *reserved, uint32 coInit)',
    );
    const coCreateInstance: AnyFn = ole32.func(
      'int32 __stdcall CoCreateInstance(GUID *clsid, void *outer, uint32 context, GUID *iid, _Out_ void **out)',
    );

    const boolBuffer = (value: boolean): Buffer => {
      const buf = Buffer.alloc(4);
      buf.writeInt32LE(value ? 1 : 0, 0);
      return buf;
    };

    const bitmapInfo = (width: number, height: number): unknown =>
      koffi.as(
        {
          bmiHeader: {
            biSize: 40,
            biWidth: width,
            // 正高度 = bottom-up，和渲染端输出的像素行序一致。
            biHeight: height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
          },
          bmiColors: [0],
        },
        'BITMAPINFO *',
      );

    const api: Native = {
      koffi,
      registerWindowMessage: (name) => Number(registerWindowMessage(name)),
      getDC: () => getDC(null),
      releaseDC: (hdc) => {
        releaseDC(null, hdc);
      },
      createDIBSection: (hdc, bmi) => createDIBSection(hdc, bmi, 0, [null], null, 0),
      setDIBits: (hdc, hbmp, height, pixels, bmi) =>
        Number(setDIBits(hdc, hbmp, 0, height, pixels, bmi, 0)),
      deleteObject: (obj) => {
        if (obj) deleteObject(obj);
      },
      createIcon: (base64) => {
        const bytes = Buffer.from(base64, 'base64');
        // 0x00030000 = WINVER 3.0；PNG 资源从 Vista 起受支持，尺寸取 PNG 的 32x32。
        return createIconFromResource(bytes, bytes.length, 1, 0x00030000, 32, 32, 0);
      },
      destroyIcon: (icon) => {
        if (icon) destroyIcon(icon);
      },
      dwmAttribute: (hwnd, attr, value) => {
        dwmSetWindowAttribute(hwnd, attr, boolBuffer(value), 4);
      },
      dwmThumbnail: (hwnd, hbmp) => {
        dwmSetIconicThumbnail(hwnd, hbmp, 0);
      },
      createTaskbar: () => {
        // Chromium 一般已经初始化过 COM；这里只兜底，返回 S_FALSE / CHANGED_MODE 都无所谓。
        coInitializeEx(null, COINIT_APARTMENTTHREADED);
        const out: unknown[] = [null];
        const hr = Number(
          coCreateInstance(
            koffi.as(CLSID_TASKBAR_LIST, 'GUID *'),
            null,
            CLSCTX_ALL,
            koffi.as(IID_ITASKBAR_LIST3, 'GUID *'),
            out,
          ),
        );
        if (hr < 0 || !out[0]) return null;
        return out[0];
      },
      comCall: (ptr, slot, proto, ...args) => {
        // COM 接口指针的头一个指针大小是 vtable，再按槽位取出方法地址。
        const vtable = koffi.decode(ptr, 'void*');
        const method = koffi.decode(vtable, slot * POINTER_SIZE, 'void*');
        if (!method) return -1;
        return Number(koffi.call(method, proto, ptr, ...args));
      },
      protos,
      bitmapInfo,
    };

    nativeCache = api;
    return api;
  } catch {
    // koffi / DLL / 声明有问题时，退回到系统默认缩略图，不要拖累播放器。
    loadFailed = true;
    return null;
  }
}

/* --------------------------------- 运行状态 --------------------------------- */

/** 任务栏一次点击偶尔会连发两条 WM_COMMAND，短时间内的重复只认第一条。 */
const COMMAND_DEBOUNCE_MS = 220;

let win: BrowserWindow | null = null;
let hwnd: unknown = null;
let taskbar: unknown = null;
let onCommand: (command: TaskbarPreviewCommand) => void = () => {};
let hooked: number[] = [];
let enabled = false;
let buttonsAdded = false;
let lastCommand = { id: 0, at: 0 };

let card: { width: number; height: number; pixels: Buffer } | null = null;
let playing = false;
let tooltip = '';
let iconSources = { prev: '', play: '', pause: '', next: '' };
let icons: { prev: unknown; play: unknown; pause: unknown; next: unknown } = {
  prev: null,
  play: null,
  pause: null,
  next: null,
};
let lastThumb = { width: 0, height: 0 };

function ready(): boolean {
  return Boolean(win && !win.isDestroyed() && hwnd && loadNative() && !loadFailed);
}

/** 从 Electron 的 hookWindowMessage 回调里取一个 DWORD（x64 是 8 字节 Buffer）。 */
function dword(buffer: Buffer): number {
  if (!buffer) return 0;
  if (buffer.length >= 4) return buffer.readUInt32LE(0);
  if (buffer.length >= 2) return buffer.readUInt16LE(0);
  return 0;
}

function makeButtons(hidden: boolean): unknown[] {
  const iconFor = (hIcon: unknown): number => (hIcon ? THB_ICON | THB_FLAGS : THB_FLAGS);
  const flags = hidden ? THBF_HIDDEN : THBF_ENABLED;
  const middle = playing ? icons.pause : icons.play;
  return [
    {
      dwMask: iconFor(icons.prev),
      iId: ID_PREV,
      iBitmap: 0,
      hIcon: icons.prev ?? null,
      szTip: ZERO_TIP,
      dwFlags: flags,
    },
    {
      dwMask: iconFor(middle),
      iId: ID_PLAY,
      iBitmap: 0,
      hIcon: middle ?? null,
      szTip: ZERO_TIP,
      dwFlags: flags,
    },
    {
      dwMask: iconFor(icons.next),
      iId: ID_NEXT,
      iBitmap: 0,
      hIcon: icons.next ?? null,
      szTip: ZERO_TIP,
      dwFlags: flags,
    },
  ];
}

function addButtons(): void {
  const api = loadNative();
  if (!api || !enabled || !taskbar || !hwnd) {
    logTaskbarPreview(
      `ADDBUTTONS skip api=${Boolean(api)} enabled=${enabled} taskbar=${Boolean(taskbar)} hwnd=${Boolean(hwnd)}`,
    );
    return;
  }
  try {
    if (buttonsAdded) {
      const hr = api.comCall(
        taskbar,
        VTBL_THUMBBAR_UPDATE_BUTTONS,
        api.protos.updateButtons,
        hwnd,
        3,
        makeButtons(false),
      );
      logTaskbarPreview(`ADDBUTTONS update hr=${hr}`);
      return;
    }
    const hr = api.comCall(
      taskbar,
      VTBL_THUMBBAR_ADD_BUTTONS,
      api.protos.addButtons,
      hwnd,
      3,
      makeButtons(false),
    );
    logTaskbarPreview(`ADDBUTTONS add hr=${hr}`);
    if (hr >= 0) buttonsAdded = true;
  } catch (caught) {
    logTaskbarPreview(`ADDBUTTONS threw ${String(caught)}`);
  }
}

function updateButtons(): void {
  const api = loadNative();
  if (!api || !taskbar || !hwnd || !buttonsAdded) {
    logTaskbarPreview(
      `UPDATEBUTTONS skip api=${Boolean(api)} taskbar=${Boolean(taskbar)} hwnd=${Boolean(hwnd)} added=${buttonsAdded}`,
    );
    return;
  }
  try {
    const hr = api.comCall(
      taskbar,
      VTBL_THUMBBAR_UPDATE_BUTTONS,
      api.protos.updateButtons,
      hwnd,
      3,
      makeButtons(!enabled),
    );
    if (hr < 0) logTaskbarPreview(`UPDATEBUTTONS hr=${hr}`);
  } catch (caught) {
    logTaskbarPreview(`UPDATEBUTTONS threw ${String(caught)}`);
  }
}

/** 把缓存的卡片等比缩放进 DWM 给的最大尺寸，四周填深色，返回 bottom-up BGRA。 */
function fitCard(width: number, height: number): Buffer | null {
  if (!card) return null;
  const { width: sw, height: sh, pixels } = card;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    out[at] = 0x31;
    out[at + 1] = 0x2b;
    out[at + 2] = 0x2b;
    out[at + 3] = 0xff;
  }

  const scale = Math.min(width / sw, height / sh);
  const dw = Math.max(1, Math.min(width, Math.round(sw * scale)));
  const dh = Math.max(1, Math.min(height, Math.round(sh * scale)));
  const ox = Math.floor((width - dw) / 2);
  const oy = Math.floor((height - dh) / 2);

  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const from = (sy * sw + sx) * 4;
      const to = ((y + oy) * width + x + ox) * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3];
    }
  }
  return out;
}

/** DWM 要图（或换歌后主动刷新）时：造一张 32bpp DIB 并交给 DWM。 */
function setThumbnail(width: number, height: number): void {
  const api = loadNative();
  if (!api || !enabled || !hwnd || width < 1 || height < 1) return;
  const pixels = fitCard(width, height);
  if (!pixels) return;

  const hdc = api.getDC();
  if (!hdc) return;
  let hbmp: unknown = null;
  try {
    const bmi = api.bitmapInfo(width, height);
    hbmp = api.createDIBSection(hdc, bmi);
    if (!hbmp) return;
    if (api.setDIBits(hdc, hbmp, height, pixels, bmi) <= 0) return;
    api.dwmThumbnail(hwnd, hbmp);
  } catch {
    // DWM 拒绝这次位图就等下一次请求，别影响主窗口。
  } finally {
    api.deleteObject(hbmp);
    api.releaseDC(hdc);
  }
}

function destroyIcons(): void {
  const api = loadNative();
  if (!api) return;
  for (const key of ['prev', 'play', 'pause', 'next'] as const) {
    api.destroyIcon(icons[key]);
    icons[key] = null;
  }
}

function ensureIcons(sources: TaskbarPreviewImage['icons']): boolean {
  const api = loadNative();
  if (!api) return false;
  let changed = false;
  for (const key of ['prev', 'play', 'pause', 'next'] as const) {
    const source = sources[key] || '';
    if (source === iconSources[key]) continue;
    api.destroyIcon(icons[key]);
    icons[key] = source ? api.createIcon(source) : null;
    iconSources[key] = source;
    changed = true;
  }
  return changed;
}

/* --------------------------------- 对外接口 --------------------------------- */

/** 主窗口建好后调用一次：挂消息钩子、建 COM 对象、打开 iconic 缩略图。 */
export function initTaskbarPreview(
  window: BrowserWindow,
  options: { enabled: boolean; onCommand: (command: TaskbarPreviewCommand) => void },
): void {
  logTaskbarPreview(`INIT v3 platform=${process.platform} enabled=${options.enabled}`);
  if (process.platform !== 'win32') return;
  const api = loadNative();
  if (!api) {
    logTaskbarPreview('INIT loadNative failed');
    return;
  }

  disposeTaskbarPreview();
  win = window;
  onCommand = options.onCommand;
  enabled = false;

  try {
    hwnd = api.koffi.decode(window.getNativeWindowHandle(), 'void*');
    logTaskbarPreview(`INIT hwnd=${String(hwnd)}`);
    if (!hwnd) return;

    taskbar = api.createTaskbar();
    logTaskbarPreview(`INIT taskbar=${Boolean(taskbar)}`);
    if (taskbar) {
      const hr = api.comCall(taskbar, VTBL_HRINIT, api.protos.hrInit);
      logTaskbarPreview(`INIT hrInit=${hr}`);
    }

    const taskbarCreated = api.registerWindowMessage('TaskbarButtonCreated');
    const messages = [
      WM_COMMAND,
      WM_DWMSENDICONICTHUMBNAIL,
      ...(taskbarCreated ? [taskbarCreated] : []),
    ];

    for (const message of messages) {
      window.hookWindowMessage(message, (wParam: Buffer, lParam: Buffer) => {
        /*
         * 命令不受 enabled 挡：按钮还挂在窗口上就该能点。开关切换与 DWM 消息
         * 有先后，用 enabled 拦命令会在某些时序下把点击直接吞掉。
         */
        if (message !== WM_COMMAND && !enabled) return;
        try {
          if (message === WM_COMMAND) {
            const raw = dword(wParam);
            const id = raw & 0xffff;
            const hit = id === ID_PREV || id === ID_PLAY || id === ID_NEXT;
            // 所有 WM_COMMAND 都记：不只是我们认得的三个 ID，否则无法区分
            // 「按钮没发消息」和「消息里的 ID 不是我们设的那个」。
            logTaskbarPreview(
              `WM_COMMAND wParam=0x${raw.toString(16)} lParam=0x${dword(lParam).toString(16)} id=${id} hit=${hit} enabled=${enabled}`,
            );
            if (!hit) return;
            const now = Date.now();
            if (lastCommand.id === id && now - lastCommand.at < COMMAND_DEBOUNCE_MS) {
              logTaskbarPreview(`WM_COMMAND debounced id=${id}`);
              return;
            }
            lastCommand = { id, at: now };

            /*
             * 这里是 Chromium 的窗口过程回调，别同步跑 Electron IPC：消息循环
             * 重入时 send 可能被延后甚至丢掉，挪到下一个 tick 再发给渲染端。
             */
            const command: TaskbarPreviewCommand =
              id === ID_PREV ? 'prev' : id === ID_PLAY ? 'play' : 'next';
            logTaskbarPreview(`DISPATCH ${command}`);
            setImmediate(() => {
              logTaskbarPreview(`DISPATCHED ${command}`);
              onCommand(command);
            });
          } else if (message === WM_DWMSENDICONICTHUMBNAIL) {
            const value = dword(lParam);
            const width = (value >>> 16) & 0xffff;
            const height = value & 0xffff;
            if (width > 0 && height > 0) {
              lastThumb = { width, height };
              setThumbnail(width, height);
            }
          } else {
            // 任务栏重启后旧按钮全失效，需要重新 AddButtons。
            buttonsAdded = false;
            addButtons();
          }
        } catch {
          // 原生消息回调里抛异常会冒泡到 Chromium 消息循环，必须吞掉。
        }
      });
      hooked.push(message);
    }

    setEnabled(options.enabled);
  } catch (caught) {
    logTaskbarPreview(`INIT threw ${String(caught)}`);
    disposeTaskbarPreview();
  }
}

/** 渲染端推来的卡片像素、按钮图标、播放状态与悬停提示。 */
export function setTaskbarPreviewImage(image: TaskbarPreviewImage): void {
  const ok = ready() && enabled && Boolean(image) && typeof image === 'object';
  logTaskbarPreview(`PUSH ok=${ok} enabled=${enabled}`);
  if (!ok) return;
  try {
    if (
      image.width === CARD_WIDTH &&
      image.height === CARD_HEIGHT &&
      image.pixels instanceof Uint8Array &&
      image.pixels.length === CARD_WIDTH * CARD_HEIGHT * 4
    ) {
      card = {
        width: image.width,
        height: image.height,
        pixels: Buffer.from(image.pixels),
      };
    }

    const iconsChanged = image.icons ? ensureIcons(image.icons) : false;
    const wasPlaying = playing;
    playing = image.playing === true;
    if (typeof image.tooltip === 'string') {
      tooltip = image.tooltip;
      win?.setThumbnailToolTip(tooltip);
    }

    /*
     * 只在按钮内容真的变了时才动 COM 工具栏：预览显示期间每帧 UpdateButtons
     * 会让任务栏反复重建按钮，点击消息可能因此丢掉或路由到错误的窗口。
     */
    if (!buttonsAdded) addButtons();
    else if (iconsChanged || wasPlaying !== playing || !enabled) updateButtons();
    if (lastThumb.width && lastThumb.height) {
      setThumbnail(lastThumb.width, lastThumb.height);
    }
  } catch {
    // 素材有问题就忽略这一帧。
  }
}

/** 配置开关：关掉时恢复系统默认缩略图并隐藏按钮。 */
export function setEnabled(next: boolean): void {
  const api = loadNative();
  logTaskbarPreview(
    `ENABLED ${next} api=${Boolean(api)} win=${Boolean(win)} hwnd=${Boolean(hwnd)}`,
  );
  if (!api || !win || win.isDestroyed() || !hwnd) return;
  enabled = next;
  try {
    api.dwmAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, next);
    api.dwmAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, next);
    if (next) {
      // 有些情况下 TaskbarButtonCreated 早于 hook 就发过了，主动挂一次更稳。
      addButtons();
      if (lastThumb.width && lastThumb.height) {
        setThumbnail(lastThumb.width, lastThumb.height);
      }
    } else {
      updateButtons();
    }
  } catch {
    // 开关失败不影响主窗口。
  }
}

export function syncTaskbarPreview(config: DesktopConfig): void {
  if (process.platform !== 'win32') return;
  setEnabled(config.taskbarPreview === true);
}

export function disposeTaskbarPreview(): void {
  const api = loadNative();
  if (win && !win.isDestroyed()) {
    for (const message of hooked) {
      try {
        win.unhookWindowMessage(message);
      } catch {
        // 窗口已销毁时 unhook 会抛，忽略。
      }
    }
  }
  hooked = [];
  buttonsAdded = false;
  enabled = false;
  lastCommand = { id: 0, at: 0 };
  destroyIcons();
  if (api && taskbar) {
    try {
      api.comCall(taskbar, VTBL_RELEASE, api.protos.release);
    } catch {
      // 忽略释放失败。
    }
  }
  taskbar = null;
  hwnd = null;
  win = null;
  card = null;
  tooltip = '';
  lastThumb = { width: 0, height: 0 };
  iconSources = { prev: '', play: '', pause: '', next: '' };
}
