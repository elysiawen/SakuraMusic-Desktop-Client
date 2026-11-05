import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

/**
 * 最小菜单。
 *
 * Windows/Linux 用自绘标题栏，菜单栏隐藏；但 Edit 菜单要保留，
 * 否则输入框里的 Ctrl+C / Ctrl+V 在部分场景会失效。macOS 保留应用菜单。
 */
export function installMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  } else {
    template.push({
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    });
  }

  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  });

  template.push({
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      ...(app.isPackaged
        ? []
        : ([{ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: '帮助',
    submenu: [
      {
        label: 'Sakura Music 项目主页',
        click: () => {
          void shell.openExternal('https://github.com/elysiawen/SakuraMusic');
        },
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
