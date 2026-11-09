import { nextTick } from 'vue';

/**
 * `index.html` 里的静态加载层由这里撤掉。
 *
 * 窗口 `ready-to-show` 时页面已经能画，但 `router.beforeEach` 还在
 * `await auth.initialize()`（里面是 `/api/auth/me`），`RouterView` 是空的。
 * 所以等首屏路由真正就绪再撤，别让用户对着白底以为卡死。
 */
const SLOW_MS = 3000;
/** 兜底：网关超时是 15s，正常绝不会走到这里，但别让加载层永远盖着。 */
const FALLBACK_MS = 20000;

let slowTimer: number | undefined;
let fallbackTimer: number | undefined;
let finished = false;

export function hideBootSplash(): void {
  if (finished) return;
  finished = true;
  if (slowTimer !== undefined) window.clearTimeout(slowTimer);
  if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);

  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('is-done');
  window.setTimeout(() => splash.remove(), 220);
}

/** `ready` 传 `router.isReady()`：守卫和首屏懒加载组件都结束才 resolve。 */
export function finishBootWhenReady(ready: Promise<unknown>): void {
  slowTimer = window.setTimeout(() => {
    const hint = document.getElementById('boot-hint');
    if (hint && !finished) hint.textContent = '连接音乐服务较慢，请检查网络或稍候…';
  }, SLOW_MS);
  fallbackTimer = window.setTimeout(hideBootSplash, FALLBACK_MS);

  void ready
    .catch(() => undefined)
    .then(async () => {
      // 再等一帧，确保 RouterView 的内容已经画出来，别撤早了露一帧白。
      await nextTick();
      window.requestAnimationFrame(() => hideBootSplash());
      // 窗口刚被收进托盘时 rAF 可能被暂停，定时器兜底（hide 本身是幂等的）。
      window.setTimeout(hideBootSplash, 120);
    });
}
