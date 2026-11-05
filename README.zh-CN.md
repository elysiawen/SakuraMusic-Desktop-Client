# Sakura Music Desktop

Sakura Music 的桌面客户端：Windows / macOS / Linux。

技术栈：Electron + Vue 3 + TypeScript + Vite + Pinia。与 web 端是**独立仓库**，
只通过 HTTP 协议对接同一个网关；界面按桌面端重新设计，不复用 web 组件。

## 当前状态

**M0–M5 已实现**，M6 桌面打磨与发布进行中。

**基座**
- Electron 主进程 + 预加载 + 渲染进程三段式工程
- 本地 BFF（只监听 127.0.0.1）：`/api` 反代、SSE 透传、静态托管
- 会话 Cookie 由主进程加密保存（`safeStorage`），渲染进程拿不到令牌
- 首次启动服务器配置、自签名证书探测与 SHA-256 指纹展示
- 登录 / 注册 / 退出、登录态持久化、401 自动回登录页
- 无边框自绘标题栏：拖动区与窗口控制按钮；登录页、服务器配置页同样有这条顶栏
- 桌面三栏外壳：侧边栏、右侧播放/队列/歌词面板、底部播放条
- 六套配色 × 明暗/跟随系统、樱花飘落背景、全局提示

**浏览与播放**
- 发现首页、统一搜索、音质面板（各档位显示音频体积）
- 播放队列、随机、循环、上一首/下一首、Media Session / SMTC 集成
- 全屏歌词（歌手 / 专辑可点跳转）与独立的桌面歌词窗口
- 房间 / 跟随曲目在播放时按需补全元数据：歌手与专辑坐标、可用音质及体积

**音乐库与离线**
- 喜欢、最近播放、本地歌单、已下载曲目的离线播放
- 用户主动下载**不设容量上限**；只有自动缓存的音频与封面按 LRU 淘汰

**一起听与多设备**
- 房间内由服务端权威控制播放：本机状态每 250ms 被镜像拉回，因此播放控制会上报服务端，而不是直接改本机播放器
- 多设备跟随 / 遥控

**统一交互**
- 各浏览列表共用同一套曲目行：行尾三点或右键打开同一个菜单，「添加到歌单」收在二级菜单里
- 侧边栏歌单同样支持右键 / 三点（打开、编辑信息、删除并二次确认）
- 错误提示（含登录 / 注册、服务器配置失败）统一走全局 toast，不再用页内错误框

## Windows 任务栏预览

仅 Windows。鼠标悬到任务栏图标上时，显示自绘的 320×200 卡片（封面、歌名、歌手）
与缩略图工具栏的上一首 / 播放暂停 / 下一首按钮。

- 主进程通过 `koffi` FFI 调 DWM（`DwmSetWindowAttribute`、`DwmSetIconicThumbnail`）
  与 `ITaskbarList3::ThumbBarAddButtons` / `ThumbBarUpdateButtons`；`WM_COMMAND` 用
  `BrowserWindow.hookWindowMessage` 接收，不替换 Chromium 自己的窗口过程。
- 渲染端用 canvas 画卡片，转成 bottom-up 预乘 BGRA 像素后经 IPC 推送；主进程按 DWM
  请求的尺寸缩放写入 32bpp DIB section。
- 按钮命令走与主界面相同的 `useTransport`：包括「一起听」房间这类服务端权威场景，
  因此任务栏点击不会被房间镜像拉回。
- 设置页「任务栏预览」与托盘菜单（仅 Windows）可开关，默认开启。
- 验证需要真实 Windows 会话：只有预览真正显示时 DWM 才会发 `WM_DWMSENDICONICTHUMBNAIL`。
- macOS / Linux 保留系统标题栏，没有缩略图工具栏，此功能整体跳过。

## 开发

```bash
npm install
npm run dev
```

开发模式下：

- 渲染进程：Vite `http://localhost:5173`
- 主进程 BFF：`http://127.0.0.1:3210`
- Vite 把 `/api` 代理到 BFF，渲染进程只使用相对路径

## 构建

```bash
npm run typecheck   # 依次跑 typecheck:node (tsc) 与 typecheck:web (vue-tsc)
npm run build
npm start            # 预览已构建产物
npm run pack         # 生成免安装目录（当前平台）
npm run dist         # 生成安装包（当前平台）
```

打包配置在 `electron-builder.yml`，产物输出到 `release/`。

应用图标沿用安卓端（`client-android`）的图标：`build/icon-source.png` 是安卓自适应图标的
前景层，改动后重新生成 `build/icon.png`：

```bash
python scripts/make-icon.py     # 需要 Pillow 与 NumPy
```

## 安全设计

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- BFF 只绑定回环地址；生产模式首次打开页面必须带一次性 `?k=<secret>`，
  服务端据此下发 HttpOnly 的本地访问 Cookie，防止本机其它进程直接调用 `/api`
- 会话 Cookie 加密保存在主进程；`Set-Cookie` 不会转发给渲染进程
- 生产模式静态响应带 CSP：脚本只允许同源，音频只允许同源与 blob
- 自签名证书按服务器显式开启，绝不全局关闭 TLS 校验
- 不保存第三方平台凭据，只使用服务器端存储的凭据（按产品决策）

## 冒烟测试

`scripts/` 下有开发期辅助脚本：

```bash
# 最小网关（登录/会话/健康检查）
node scripts/mock-gateway.mjs

# 启动 Electron 时开调试端口
node_modules/electron/dist/electron.exe --remote-debugging-port=9222 .

# 读取页面状态并截图
node scripts/cdp-smoke.mjs smoke.png

# 服务器配置 → 登录 → 首页 → 主题 → 退出登录
node scripts/cdp-flow.mjs
```

`cdp-flow.mjs` 假设页面从「服务器配置」开始；需要干净状态时先删除
`%APPDATA%\Sakura Music\config.json` 与 `session.bin`（macOS / Linux 对应 `app.getPath('userData')`）。

## 已知限制

- 任务栏预览仅支持 Windows（Win10 / Win11），且依赖 DWM
- 不做自动更新，发布安装包后由用户自行安装
- 暂未签名：Windows SmartScreen 会提示，macOS 需要右键打开
- 不支持「仅本机」凭据模式（产品决策）
- 网关协议文档由网关仓库维护，本仓库只包含客户端实现
- M6 桌面打磨与发布仍在进行中

## 目录

```
src/
  main/        主进程：BFF、配置、会话、IPC
    windows/   窗口创建、圆角、Windows 任务栏预览
  preload/     contextBridge 暴露的最小桌面能力
  renderer/    Vue 3 桌面界面
  shared/      主进程与渲染进程共用的类型与常量
scripts/       开发期冒烟脚本
build/         图标等打包资源
```

## 许可

MIT
