# Sakura Music Desktop

Sakura Music 的桌面客户端：Windows / macOS / Linux。

技术栈：Electron + Vue 3 + TypeScript + Vite + Pinia。与 web 端是**独立仓库**，
只通过 HTTP 协议对接同一个网关；界面按桌面端重新设计，不复用 web 组件。

## 当前状态

**M0 · 基座与登录** 已完成：

- Electron 主进程 + 预加载 + 渲染进程三段式工程
- 本地 BFF（只监听 127.0.0.1）：`/api` 反代、SSE 透传、静态托管
- 会话 Cookie 由主进程加密保存（`safeStorage`），渲染进程拿不到令牌
- 首次启动服务器配置、自签名证书探测与 SHA-256 指纹展示
- 登录 / 注册 / 退出、登录态持久化、401 自动回登录页
- 桌面三栏外壳：自绘标题栏、侧边栏、右侧播放/队列/歌词面板、底部播放条
- 六套配色 × 明暗/跟随系统、樱花飘落背景、全局提示

里程碑：M1 浏览与播放、M2 绑定与音乐库、M3 下载与缓存、M4 多设备（已完成）、
M5 一起听（已完成，双人房）、M6 桌面打磨与发布。

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
npm run typecheck
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

- 音频播放、搜索、音乐库尚未接入（M1/M2）
- 不做自动更新，发布安装包后由用户自行安装
- 暂未签名：Windows SmartScreen 会提示，macOS 需要右键打开
- 不支持「仅本机」凭据模式（产品决策）
- 依赖的网关协议以 `docs/` 中的三份协议文档为准（本仓库暂未复制协议文档）

## 目录

```
src/
  main/        主进程：BFF、配置、会话、窗口、IPC
  preload/     contextBridge 暴露的最小桌面能力
  renderer/    Vue 3 桌面界面
  shared/      主进程与渲染进程共用的类型与常量
scripts/       开发期冒烟脚本
build/         图标等打包资源
```

## 许可

MIT
