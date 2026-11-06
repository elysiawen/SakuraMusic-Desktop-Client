import { onBeforeUnmount, watch } from 'vue';

/**
 * 浮层（样式菜单 / 音质面板 / 播放列表）开着时，临时关掉窗口拖动区。
 *
 * Electron 的 `-webkit-app-region: drag` 区域会吞掉点击：点标题栏时
 * 「点击外部关闭」监听收不到任何事件，浮层就关不掉。浮层开着期间给
 * `html` 挂上 `has-popover`，把 `.drag` 降级成普通区域（见 base.css），
 * 标题栏上的点按才能被外部点击监听看见并收起浮层。
 *
 * 代价是浮层开着时标题栏不能拖窗——点一下关掉浮层就恢复了。
 *
 * 计数管理：同屏可能有多个浮层（播放条和播放页各一个音质面板），
 * 全关掉才恢复拖动区。
 */
let openCount = 0;

function sync(): void {
  document.documentElement.classList.toggle('has-popover', openCount > 0);
}

export function usePopoverDragGuard(isOpen: () => boolean): void {
  let counted = false;

  const apply = (open: boolean): void => {
    if (open === counted) return;
    counted = open;
    openCount += open ? 1 : -1;
    sync();
  };

  watch(isOpen, apply, { immediate: true });
  onBeforeUnmount(() => apply(false));
}
