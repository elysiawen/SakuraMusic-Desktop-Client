import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { app, ipcMain } from 'electron';

/**
 * 渲染进程状态的跨重启镜像。
 *
 * 正式版 BFF 每次用随机端口，页面 origin 是 `http://127.0.0.1:<port>`；
 * localStorage 按 origin 隔离，重启换端口就等于换了个空存储 —— 播放队列、
 * 进度、音质、主题、UI 偏好会一起「消失」。这里把整份 localStorage 快照
 * 存进 userData 文件，渲染进程启动时取回、运行时定期写回，状态便不再绑在端口上。
 *
 * 走同步 IPC：页面卸载前（pagehide / beforeunload）必须保证这次写入已经落盘。
 */

const MAX_BYTES = 2 * 1024 * 1024;
/** 多个窗口会同步同一份数据，内容没变就不重复写盘。 */
let lastWritten = '';

function statePath(): string {
  return join(app.getPath('userData'), 'renderer-state.json');
}

/** 只接受 string → string，避免异常数据被原样写进磁盘。 */
function sanitize(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

export function readRendererState(): Record<string, string> {
  try {
    const file = statePath();
    if (!existsSync(file)) return {};
    return sanitize(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return {};
  }
}

export function saveRendererState(value: unknown): boolean {
  const text = JSON.stringify(sanitize(value));
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return false;
  if (text === lastWritten) return true;

  let tmp: string | null = null;
  try {
    const file = statePath();
    mkdirSync(dirname(file), { recursive: true });
    // 原子写：IPC 回调在主进程里串行执行，固定临时文件名不会并发踩踏，
    // 也不会像按 pid 命名那样在异常退出后越积越多。
    tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    lastWritten = text;
    return true;
  } catch {
    // 写失败时别把半截临时文件留在 userData 里。
    if (tmp) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 清不掉就算了，下次同步会覆盖同名临时文件。
      }
    }
    return false;
  }
}

export function registerRendererStateIpc(): void {
  ipcMain.on('state:load', (event) => {
    event.returnValue = readRendererState();
  });
  ipcMain.on('state:save', (event, value: unknown) => {
    event.returnValue = saveRendererState(value);
  });
}
