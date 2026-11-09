/**
 * 把渲染进程的 `localStorage` 镜像到主进程文件。
 *
 * 正式版页面 URL 是 `http://127.0.0.1:<随机端口>`，localStorage 按 origin 隔离，
 * 重启换端口后上一次的数据就留在旧 origin 里。这里：
 *   - 启动时若当前 origin 是全新的，把主进程保存的快照注入回来；
 *   - 运行期间由主窗口定期把整份 localStorage 异步写回主进程；
 *   - 页面隐藏 / 卸载前先让播放器立即落盘，再强制同步一次。
 *
 * 哨兵 key 用来识别「新 origin」：只注入一次，避免副窗口或刷新时用旧快照
 * 覆盖刚写入的新状态，也不会把用户主动删掉的 key 又补回来。
 */

const MARKER = '__sakura.state.hydrated';
const SYNC_INTERVAL_MS = 2000;

type Snapshot = Record<string, string>;

let flushHandler: (() => void) | null = null;
let lastSnapshot = '';

/** 播放器注册：卸载前把节流挂起的那次写入立刻做完。 */
export function setBeforeStateFlush(handler: () => void): void {
  flushHandler = handler;
}

function capture(): Snapshot {
  const data: Snapshot = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) data[key] = localStorage.getItem(key) ?? '';
    }
  } catch {
    // 配额 / 隐私模式异常时，拿到多少算多少。
  }
  return data;
}

function sync(force = false): void {
  try {
    const data = capture();
    const serialized = JSON.stringify(data);
    if (!force && serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    // 退出 / 隐藏时同步等主进程写完；平时单向发送，不阻塞渲染线程。
    if (force) window.sakura.state.save(data);
    else window.sakura.state.saveSoon(data);
  } catch {
    // 同步失败不该影响播放，下一个周期或退出时会再试。
  }
}

function flushAndSync(): void {
  try {
    flushHandler?.();
  } catch {
    // 播放器还没创建时没有钩子，直接同步已有数据即可。
  }
  sync(true);
}

/** 必须在任何 store 读 localStorage 之前调用（渲染进程入口最顶部）。 */
export function initRendererState(): void {
  const api = window.sakura?.state;
  if (!api) return;

  let initial: Snapshot | null = null;
  try {
    if (localStorage.getItem(MARKER) !== '1') {
      const snapshot: Snapshot = api.load() ?? {};
      for (const [key, value] of Object.entries(snapshot)) {
        if (key !== MARKER && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      }
      localStorage.setItem(MARKER, '1');
      initial = capture();
    }
  } catch {
    // 注入失败就当作一次全新会话，不阻塞启动。
  }

  // 注入过的那份直接复用，省掉启动时的第二次全量遍历 + 序列化。
  lastSnapshot = JSON.stringify(initial ?? capture());

  // 副窗口（桌面歌词 / 弹出播放页）与主窗口同源、共享同一份 localStorage：
  // 定期同步交给主窗口一个就够，别每个窗口都重复序列化 + 发 IPC。
  // 退出 / 隐藏时的同步所有窗口都注册（低频），保证最后关掉的那个也能落盘。
  const isPrimary = new URLSearchParams(window.location.search).get('window') === null;
  if (isPrimary) window.setInterval(() => sync(), SYNC_INTERVAL_MS);
  window.addEventListener('pagehide', flushAndSync);
  window.addEventListener('beforeunload', flushAndSync);
  document.addEventListener('visibilitychange', () => {
    // 收进托盘 / 切走窗口时也会触发，顺手存一次。
    if (document.visibilityState === 'hidden') flushAndSync();
  });
}
