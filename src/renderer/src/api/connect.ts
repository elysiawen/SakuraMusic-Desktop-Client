import { apiRequest } from './client';

/** 与网关 `services/connect.ts` 的形状保持一致。 */

export type DeviceKind = 'web' | 'android' | 'windows';

export type RemotePlayMode = 'order' | 'all' | 'one' | 'shuffle';

export interface RemoteTrack {
  key: string;
  title: string;
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  sources: Array<{ platform: string; id: string; mid?: string }>;
}

export interface RemoteState {
  track: RemoteTrack | null;
  playing: boolean;
  /** 上报那一刻的进度（秒）。 */
  position: number;
  /** 服务端盖章的上报时刻，用来把进度推算到「现在」。 */
  positionAt: number;
  duration: number;
  volume: number;
  quality: string;
  queueLength: number;
  playMode?: RemotePlayMode;
  following?: string;
}

export interface RemoteDevice {
  deviceId: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
  state: RemoteState | null;
}

export type CommandAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'seek'
  | 'volume'
  | 'mode'
  | 'follow'
  | 'unfollow'
  | 'queue'
  | 'queueState'
  | 'playAt'
  | 'remove'
  | 'add'
  | 'transfer'
  | 'release'
  /** 一起听：请目标设备把房间席位接过去（声音切到它）。 */
  | 'takeSeat';

export interface DeviceCommand {
  from: string;
  action: string;
  payload: unknown;
}

export const connectApi = {
  reportState: (deviceId: string, state: unknown) =>
    apiRequest<{ ok: boolean }>('/api/connect/state', {
      method: 'POST',
      body: { deviceId, state },
    }),

  sendCommand: (input: {
    deviceId: string;
    target: string;
    action: CommandAction;
    payload?: unknown;
  }) =>
    apiRequest<{ ok: boolean }>('/api/connect/command', {
      method: 'POST',
      body: input,
    }),

  /** `/connect/events` 由主进程 BFF 透传网关 SSE。 */
  eventsPath: (params: { deviceId: string; name: string; kind: DeviceKind }) => {
    const query = new URLSearchParams({
      deviceId: params.deviceId,
      name: params.name,
      kind: params.kind,
    });
    return `/connect/events?${query.toString()}`;
  },
};
