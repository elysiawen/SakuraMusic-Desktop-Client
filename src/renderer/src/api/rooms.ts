import { apiRequest } from './client';
import type { Platform } from './types';

/**
 * 「一起听」房间（网关 `/api/rooms/*`）。
 *
 * 协议与语义见 `sakura-music/docs/together-protocol.md`，这里只照抄形状：
 * 服务端是**权威**，队列、播放态、进度都由它持有，客户端提交操作并镜像回来。
 *
 * 桌面端当前只做双人房（`duo`）。类型里保留 `group` 是为了在服务端未来放开时
 * 不至于因为一个没见过的取值整页崩掉。
 */

export type RoomKind = 'duo' | 'group';

/** 房间内角色。双人房恒为 `member`（没有房主）。 */
export type RoomRole = 'owner' | 'member';

/** 播放模式，与 `player` store 的 `PlayMode` 取值一一对应。 */
export type RoomMode = 'order' | 'all' | 'one' | 'shuffle';

/** 房间里的曲目摘要（服务端清洗过的最小快照）。 */
export interface RoomTrack {
  key: string;
  title: string;
  /** 已拼好的歌手串（`周杰伦 / 费玉清`）。 */
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  /** 取流坐标：镜像端靠它自己解析音频。 */
  sources: Array<{ platform: Platform; id: string; mid?: string; numericId?: string }>;
  vip?: boolean;
}

export interface RoomMember {
  userId: string;
  nickname: string;
  avatar: string | null;
  deviceId: string;
  deviceName: string;
  kind: 'web' | 'android' | 'windows';
  /** 这台设备当前是否连着 SSE（与席位是两回事）。 */
  online: boolean;
  /** 收件的**这台设备**占着席位（服务端按接收方逐个填）。 */
  me: boolean;
  /** 这条成员属于**收件人的账号**（席位可能挂在它的另一台设备上）。 */
  mine: boolean;
  role: RoomRole;
}

/**
 * 支持「借用对方会员」的平台。
 *
 * 必须按平台分开：一首歌只属于一个平台，取流时按 `track.platform` 读对应那一项。
 */
export type EntitlementPlatform = 'netease' | 'qq';

/** 一次等待权益提供方确认的共享请求。 */
export interface RoomEntitlementPending {
  platform: EntitlementPlatform;
  /** 权益提供方：他的会员会被房间内所有人使用。 */
  targetUserId: string;
  /** 发起人（可能不是 targetUserId，那正是需要确认的原因）。 */
  requestedBy: string;
  at: number;
}

/**
 * 会员共享状态，按平台分开。
 *
 * `active[platform]` 是提供权益的成员 userId，`null` = 各用各的（默认）。
 * 它只表示授权关系，不包含任何凭据或播放地址。
 */
export interface RoomEntitlement {
  active: Record<EntitlementPlatform, string | null>;
  pending: Record<EntitlementPlatform, RoomEntitlementPending | null>;
}

/**
 * 一条由服务端用权益提供方凭据解析出来的播放地址。
 *
 * `url` / `headers` 在桌面端会被主进程改写成同源 `/media/<id>`（渲染进程的 CSP 只允许
 * 同源媒体），所以真正播放时优先读 `media.direct`。
 */
export interface RoomSource {
  platform: EntitlementPlatform;
  /** 属于哪首歌。与当前曲目对不上就是切歌后的迟到应答。 */
  trackKey: string;
  url?: string;
  /** 直连 CDN 需要的请求头（Referer / Origin / UA），只由主进程使用。 */
  headers?: Record<string, string>;
  quality?: string;
  /** 只拿到试听片段（提供方自己也没权限时）。 */
  trial: boolean;
  ownerUserId: string;
  /** 主进程登记后的同源地址。 */
  media?: { direct?: string };
}

/** 房间全量快照，随 `room` 事件下发。 */
export interface RoomView {
  code: string;
  kind: RoomKind;
  capacity: number;
  ownerUserId: string;
  members: RoomMember[];
  queue: RoomTrack[];
  index: number;
  version: number;
  /** 两人历史累计一起听时长（秒，已含本次）。 */
  togetherSeconds: number;
  /** 本次房间的累计时长（秒）。 */
  togetherSessionSeconds: number;
  /** 此刻是否正在走表（两人都在房间里）。 */
  togetherCounting: boolean;
  /** 会员共享状态。老服务端没有这个字段，客户端按「各用各的」兜底。 */
  entitlement?: RoomEntitlement;
}

/** 房间播放态，随 `room-playback` 事件下发。 */
export interface RoomPlayback {
  index: number;
  playing: boolean;
  /** 秒；配合 `positionAt` 推算到「现在」。 */
  position: number;
  positionAt: number;
  duration: number;
  track: RoomTrack | null;
  /** 房间的播放模式（两端共享）。 */
  mode: RoomMode;
  skipReason?: 'unplayable';
  skippedTitle?: string;
}

/** 入房前预览。 */
export interface RoomPreview {
  code: string;
  kind: RoomKind;
  capacity: number;
  members: Array<{ nickname: string; avatar: string | null }>;
  playing: boolean;
  track: RoomTrack | null;
  /** 本账号的席位挂在哪台设备上；`null` = 本账号不在房间里。 */
  mine: string | null;
}

export type RoomAction =
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'playAt'
  | 'seek'
  | 'add'
  | 'playNow'
  | 'remove'
  | 'setQueue'
  | 'setMode'
  | 'ended'
  | 'unplayable'
  /** 改某平台的权益归属：目标为空 = 各自；是自己 = 直接分享；是对方 = 发起请求。 */
  | 'setEntitlement'
  /** 权益提供方确认/拒绝一次共享请求。 */
  | 'ackEntitlement';

export interface RoomActionPayload {
  index?: number;
  position?: number;
  /** `ended` / `unplayable` 用：刚播完/播不了的那首的 key。 */
  trackKey?: string;
  /** `add` / `playNow` 用。 */
  track?: unknown;
  /** `setQueue` 用。 */
  queue?: unknown[];
  /** `setMode` 用。 */
  mode?: RoomMode;
  /** `setEntitlement` / `ackEntitlement` 用：哪个平台。 */
  platform?: EntitlementPlatform;
  /** `setEntitlement` 用：用谁的权益；`null` = 各用各的。 */
  targetUserId?: string | null;
  /** `ackEntitlement` 用：接受为 true，拒绝为 false。 */
  accept?: boolean;
}

/** 一起听总览里的一位伙伴。 */
export interface TogetherPartner {
  userId: string;
  nickname: string;
  avatar: string | null;
  /** 和这位伙伴的累计一起听时长（秒）。 */
  seconds: number;
  /** 最近一次一起听的时间（ISO 字符串）。 */
  lastAt: string;
}

/** 我的一起听总览（账户中心用）。 */
export interface TogetherOverview {
  /** 与所有人累计的一起听时长（秒）。 */
  totalSeconds: number;
  partnerCount: number;
  /** 按累计时长倒序。 */
  partners: TogetherPartner[];
  /** 一起听过的次数；服务端明细表不在时为 null（界面少显示一个数字即可）。 */
  sessionCount: number | null;
}

/** 一次「一起听」的明细。 */
export interface TogetherSessionItem {
  /** 这一次一起听的开始时间（ISO 字符串）。 */
  startedAt: string;
  seconds: number;
}

/** 某位伙伴的详细一起听记录。 */
export interface TogetherPartnerDetail {
  partner: { userId: string; nickname: string; avatar: string | null };
  /** 与这位伙伴的累计一起听时长（秒）。 */
  totalSeconds: number;
  sessionCount: number | null;
  /** 最近的在前；明细表不在时为 null，那时只有累计可用。 */
  sessions: TogetherSessionItem[] | null;
}

export const roomApi = {
  create: (input: {
    deviceId: string;
    name?: string;
    deviceKind?: string;
    kind?: RoomKind;
    queue?: unknown[];
    index?: number;
    mode?: RoomMode;
  }) => apiRequest<{ code: string }>('/api/rooms/create', { method: 'POST', body: input }),

  join: (input: { code: string; deviceId: string; name?: string; deviceKind?: string }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/join', { method: 'POST', body: input }),

  leave: (deviceId: string) =>
    apiRequest<{ ok: boolean }>('/api/rooms/leave', { method: 'POST', body: { deviceId } }),

  dissolve: (deviceId: string) =>
    apiRequest<{ ok: boolean }>('/api/rooms/dissolve', { method: 'POST', body: { deviceId } }),

  act: (input: { deviceId: string; action: RoomAction; payload?: RoomActionPayload }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/action', { method: 'POST', body: input }),

  /**
   * 改某平台的权益归属。
   *
   * `targetUserId` 为空 = 回到各用各的（撤销不需要对方同意）；传自己 = 直接分享；
   * 传对方 = 只是**发起请求**，要等对方 `ackEntitlement`。
   */
  setEntitlement: (input: {
    deviceId: string;
    platform: EntitlementPlatform;
    targetUserId: string | null;
  }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/action', {
      method: 'POST',
      body: {
        deviceId: input.deviceId,
        action: 'setEntitlement',
        payload: { platform: input.platform, targetUserId: input.targetUserId },
      },
    }),

  /** 权益提供方确认（`accept: true`）或拒绝一次共享请求。 */
  ackEntitlement: (input: { deviceId: string; platform: EntitlementPlatform; accept: boolean }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/action', {
      method: 'POST',
      body: {
        deviceId: input.deviceId,
        action: 'ackEntitlement',
        payload: { platform: input.platform, accept: input.accept },
      },
    }),

  /**
   * 借对方的会员取一条播放地址。
   *
   * 解析在服务端完成：它用权益提供方存在服务器上的凭据换出 CDN 直链，受方只拿到地址。
   * 桌面端的主进程会再把这条地址登记成同源 `/media/<id>`（渲染进程设不了请求头，
   * CSP 也不允许跨源媒体）。
   */
  fetchSource: (input: {
    deviceId: string;
    platform: EntitlementPlatform;
    trackKey: string;
    quality: string;
  }) => apiRequest<RoomSource>('/api/rooms/source', { method: 'POST', body: input }),

  preview: (code: string) => apiRequest<RoomPreview>(`/api/rooms/${encodeURIComponent(code)}`),

  /** 我的一起听总览（账户中心用）。 */
  overview: () => apiRequest<TogetherOverview>('/api/rooms/overview'),

  /** 某位伙伴的详细一起听记录。 */
  partnerDetail: (partnerId: string) =>
    apiRequest<TogetherPartnerDetail>(`/api/rooms/overview/${encodeURIComponent(partnerId)}`),
};
