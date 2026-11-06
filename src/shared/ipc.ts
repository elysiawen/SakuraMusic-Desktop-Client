/**
 * 主进程与渲染进程之间的契约。
 *
 * 这里只放「跨进程传输」的类型，不放业务实体：业务实体在 renderer/api/types.ts。
 */

import type { CacheKind, CacheStats } from './cache';

export interface DesktopConfig {
  /** 网关根地址，形如 `http://127.0.0.1:8787`；首次启动为空。 */
  baseUrl: string;
  /** 允许不受信任的 TLS 证书（自签名）。按服务器显式开启。 */
  allowInvalidCert: boolean;
  /** 本机设备标识，持久化后不变。 */
  deviceId: string;
  /** 设备展示名，默认「主机名 · 平台」。 */
  deviceName: string;
  /** 关闭主窗口时是否收进托盘；关闭后关窗即退出。 */
  closeToTray: boolean;
  /** 音频流缓存上限（MB）；0 表示不缓存，-1 表示不限。 */
  audioCacheMb: number;
  /** 封面缓存上限（MB）；0 表示不缓存，-1 表示不限。 */
  coverCacheMb: number;
  /** 歌词缓存保留天数；-1 表示永久。 */
  lyricCacheDays: number;
  /** 歌曲/专辑/歌手信息保留天数；-1 表示永久。 */
  metaCacheDays: number;
  /** 离线下载目录。 */
  downloadDir: string;
  /** 桌面歌词总开关。 */
  desktopLyric: boolean;
  /** 锁定后鼠标穿透，不再遮挡操作。 */
  lyricLocked: boolean;
  /** 桌面歌词字号（px）。 */
  lyricFontSize: number;
  /** 桌面歌词主色，形如 #ffffff。 */
  lyricColor: string;
  /** 有翻译时是否显示译文行。 */
  lyricShowTrans: boolean;
  /** 歌词窗口位置；null 表示用默认（底部居中）。 */
  lyricX: number | null;
  lyricY: number | null;
  /** Windows 任务栏预览：自绘封面卡片 + 缩略图控制按钮。其它平台忽略。 */
  taskbarPreview: boolean;
}

export interface HealthPayload {
  ok: boolean;
  time: string;
  upstreams: {
    netease: string;
    qq: string;
  };
}

export interface ServerCertificateInfo {
  subject: string;
  issuer: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
}

export type ProbeErrorCode =
  | 'invalid_url'
  | 'network'
  | 'certificate'
  | 'timeout'
  | 'http'
  | 'not_sakura';

export interface ServerProbeResult {
  ok: boolean;
  baseUrl?: string;
  status?: number;
  health?: HealthPayload;
  error?: string;
  code?: ProbeErrorCode;
  certificate?: ServerCertificateInfo;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
}

export interface SaveServerInput {
  baseUrl: string;
  allowInvalidCert: boolean;
}

/** 桌面偏好的可改字段；服务器地址走 `saveServer`，不在这里。 */
export interface DesktopConfigPatch {
  deviceName?: string;
  closeToTray?: boolean;
  audioCacheMb?: number;
  coverCacheMb?: number;
  lyricCacheDays?: number;
  metaCacheDays?: number;
  downloadDir?: string;
  desktopLyric?: boolean;
  lyricLocked?: boolean;
  lyricFontSize?: number;
  lyricColor?: string;
  lyricShowTrans?: boolean;
  lyricX?: number | null;
  lyricY?: number | null;
  taskbarPreview?: boolean;
}

/** 桌面歌词的一行（与渲染端的 LyricLine 同构，避免跨进程引用业务类型）。 */
export interface DesktopLyricLine {
  time: number;
  text: string;
  trans?: string;
}

/**
 * 主窗口推给桌面歌词窗口的一帧播放快照。
 * 歌词窗口拿到后本地自走：position + (Date.now() - sentAt)。
 */
export interface DesktopLyricState {
  trackKey: string | null;
  title: string;
  artist: string;
  playing: boolean;
  /** 播放位置（秒），对应 sentAt 那一刻。 */
  position: number;
  /** 主窗口发出快照的 Date.now()。 */
  sentAt: number;
  lines: DesktopLyricLine[];
}

export interface LyricApi {
  /** 主窗口 → 主进程：推一帧快照（send，不等回执）。 */
  pushState: (state: DesktopLyricState) => void;
  /** 歌词窗口启动时拉最近一次快照。 */
  getState: () => Promise<DesktopLyricState | null>;
  /** 订阅快照；返回取消订阅函数。 */
  onState: (callback: (state: DesktopLyricState) => void) => () => void;
  /** 配置变化广播（两个窗口都会收到）；返回取消订阅函数。 */
  onPrefs: (callback: (config: DesktopConfig) => void) => () => void;
}

/** 缩略图工具栏按钮的三种命令。 */
export type TaskbarPreviewCommand = 'prev' | 'play' | 'next';

/**
 * 渲染端画好的任务栏预览素材。
 *
 * 卡片像素是 bottom-up 的 BGRA、alpha 已预乘，尺寸固定 320x200；主进程按 DWM
 * 当时给的最大尺寸缩放后写进 DIB。按钮图标是 32x32 PNG 的 base64（不含 data: 头）。
 */
export interface TaskbarPreviewImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  icons: {
    prev: string;
    play: string;
    pause: string;
    next: string;
  };
  playing: boolean;
  tooltip: string;
}

export interface TaskbarPreviewApi {
  /** 主窗口 → 主进程：更新卡片、按钮图标与播放状态。 */
  push: (image: TaskbarPreviewImage) => void;
  /** 订阅缩略图工具栏按钮点击；返回取消订阅函数。 */
  onCommand: (callback: (command: TaskbarPreviewCommand) => void) => () => void;
  /** 真机链路诊断：渲染端回报命令接收与执行结果（临时）。 */
  ack: (line: string) => void;
}

/** 「仅本机」平台凭据：由主进程加密保存，并在转发网关请求时注入。 */
export type PlatformKey = 'netease' | 'qq';

export interface PlatformCredentialState {
  /** 本机存着凭据的平台；空数组表示都用服务器上的。 */
  platforms: PlatformKey[];
}

export interface PlatformCredentialApi {
  list: () => Promise<PlatformCredentialState>;
  save: (input: { platform: PlatformKey; cookie: string }) => Promise<PlatformCredentialState>;
  clear: (platform: PlatformKey) => Promise<PlatformCredentialState>;
  clearAll: () => Promise<PlatformCredentialState>;
}

export interface WindowControlsApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** 返回取消订阅函数。 */
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

export type AudioCacheState = 'full' | 'partial' | null;

export interface CacheApi {
  /** 读取四类缓存的占用与条目数。 */
  stats: () => Promise<CacheStats>;
  /** 清理某一类；不传 kind 时清理全部缓存。 */
  clear: (kind?: CacheKind) => Promise<CacheStats>;
  /** 查某首音频的本地缓存状态（磁盘实查，无副作用）。 */
  audioCheck: (key: string) => Promise<AudioCacheState>;
}

export interface DesktopApi {
  /** `darwin` / `win32` / `linux`，用于标题栏与快捷键差异。 */
  platform: string;
  getConfig: () => Promise<DesktopConfig>;
  saveServer: (input: SaveServerInput) => Promise<DesktopConfig>;
  clearServer: () => Promise<DesktopConfig>;
  testServer: (input: SaveServerInput) => Promise<ServerProbeResult>;
  clearSession: () => Promise<{ ok: boolean }>;
  updateConfig: (patch: DesktopConfigPatch) => Promise<DesktopConfig>;
  chooseDirectory: () => Promise<string | null>;
  getAppInfo: () => Promise<AppInfo>;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;
  platformCredentials: PlatformCredentialApi;
  windowControls: WindowControlsApi;
  cache: CacheApi;
  lyric: LyricApi;
  taskbarPreview: TaskbarPreviewApi;
}
