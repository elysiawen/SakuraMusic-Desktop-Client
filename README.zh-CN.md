[English](README.md) | **简体中文**

# Sakura Music Desktop

Sakura Music 的桌面客户端 —— Windows / macOS / Linux。

使用 Electron + Vue 3 + TypeScript + Vite + Pinia 构建。这是一个**独立仓库**，与 Web 客户端分开维护；两者通过 HTTP 连接同一个后端网关。界面完全为桌面端重新设计，不复用 Web 组件。

## 当前进度

里程碑 **M0–M5 已完成**；M6（打磨与发布）进行中。

**基础设施**
- Electron 三进程架构：主进程 + preload + 渲染进程
- 本地 BFF（只绑定 `127.0.0.1`）：`/api` 反向代理、SSE 透传、支持 HTTP Range 的媒体流；页面本身在 dev / release 下都由 `sakura://app` 自定义协议提供
- 会话 Cookie 与「仅本机」平台凭据由 `safeStorage` 加密后存入本地 SQLite 数据库，渲染进程永远拿不到凭据
- 首次启动的服务器配置、自签名证书检测与 SHA-256 指纹展示
- 登录 / 注册 / 退出、会话持久化、401 自动跳转登录页
- 无边框自定义标题栏（拖动区与窗口按钮）；登录页和服务器配置页复用同一条标题栏
- 桌面三栏外壳：侧边栏、右侧播放器 / 队列 / 歌词面板、底部播放条
- 六套配色 × 浅色 / 深色 / 跟随系统、樱花花瓣背景、全局 Toast 系统

**浏览与播放**
- 首页发现、统一搜索、带各音质文件大小的音质选择器
- 队列、随机播放、循环、上一首 / 下一首、媒体会话 / SMTC 集成
- 全屏歌词支持点击歌手与专辑链接，默认是应用内覆盖层，也可在**独立的全屏播放窗口**中打开；另有紧凑的**桌面歌词条**（无边框、置顶、透明），可锁定（鼠标穿透）且位置在多次启动间记忆
- 一起听 / 跟随曲目在播放时按需补全：歌手与专辑 ID、可用音质及其大小

**播放页样式**
五种全屏布局，可从播放条的样式菜单切换，首次使用时才懒加载：
- **经典** —— 封面与歌词左右分栏，颜色跟随当前主题
- **沉浸** —— 超大居中歌词，背后是实时 WebGL2 流体场与频谱
- **雾笺** —— 雨滴沿车窗滑落；歌词按笔顺一笔一笔写到玻璃上
- **绘光** —— 舞台追光与光束扫过歌词（PixiJS）
- **町景** —— 三维深夜街景（便利店 / 加油站 / 城寨酒吧），歌词写在场景内的招牌屏上（three.js），附带镜头 / 对焦 / 景深控制条

五种样式共用同一套展开 / 收起与交叉淡化外壳。所有内容都在本地渲染，音频与歌词数据不会离开这台机器。

五种全屏布局也能在**独立播放窗口**（`?window=nowplaying`）中打开 —— 同时最多一个，Windows 无边框、macOS 隐藏内嵌标题栏；它与主窗口共享播放状态，并与应用内覆盖层互斥。

**曲库与离线**
- 收藏、播放历史、本地歌单、已下载曲目的离线播放
- 用户主动下载会写入带每曲目索引（key、平台、请求与实际音质、大小）的本地曲库。文件走与播放相同的取流路径 —— 带防盗链头的 CDN 直连，失败回退网关流 —— 先写入 `.part` 文件，仅成功后才改名，因此中断的下载绝不会留下半个被索引的文件。真实音频容器由文件头嗅探得到，所以被误标为 `application/octet-stream` 的无损流会落为 `.flac` 而非 `.bin`。已下载曲目经本地 BFF（`/offline/stream/<key>`）回放给播放器。
- 用户主动下载**不设存储上限**；只有自动缓存的音频与封面受 LRU 限制

**一起听与多设备**
- 房间内以服务端为权威：本地播放器每 250 ms 回镜一次，播放操作上报服务端而不是本地直接执行
- 多设备在线复用同一条 SSE 连接。状态稀疏广播（仅在播放 / 暂停 / 换歌 / 队列 / 模式 / 音量 / 跟随关系变化时，外加一次纠偏重同步），进度由服务端时钟偏移推算，因此没有周期性的对表流量。对另一台设备的远程控制涵盖播放 / 暂停 / 上一首 / 下一首 / seek / 音量 / 模式，队列操作（跳播、移除、追加）与**接管**（目标把队列与进度交回本机）。**跟随**镜像另一台设备的播放；跟随链会解析到源头，避免层层镜像叠加；15 秒宽限期容忍瞬断重连而不打断同步。
- 私人电台只与「本机占着一起听席位」互斥：同账号另一台设备在放时本机是旁观，可照常开电台、续播；本机在听电台时，创建 / 加入 / 转到本机这些占席位的动作仍需先退出电台

**交互约定**
- 所有浏览列表共用同一套曲目行实现：三点按钮或右键打开同一个菜单，「添加到歌单」收在子菜单里
- 侧边栏歌单同样支持右键 / 三点（打开、编辑信息、二次确认后删除）
- 错误提示（包括登录 / 注册与服务器配置失败）统一走全局 Toast，不再用内联提示框

## Windows 任务栏预览

仅 Windows。鼠标悬停任务栏图标时，显示一张自绘的 320×200 卡片（封面、标题、歌手），以及带上一首 / 播放暂停 / 下一首按钮的缩略图工具栏。

- 主进程通过 `koffi` FFI 调用 DWM（`DwmSetWindowAttribute`、`DwmSetIconicThumbnail`）与 `ITaskbarList3::ThumbBarAddButtons` / `ThumbBarUpdateButtons`。`WM_COMMAND` 经 `BrowserWindow.hookWindowMessage` 到达，Chromium 自己的窗口过程保持原样。
- 渲染进程用 canvas 绘制卡片，将像素转换为自下而上的预乘 BGRA，再通过 IPC 推送；主进程按 DWM 请求的尺寸缩放成 32 bpp 的 DIB。
- 按钮命令与界面内控件走同一个 `useTransport` 层 —— 包括以服务端为权威的一起听房间，因此任务栏点击不会被房间镜像回滚。
- 可在 `设置 → 任务栏预览` 与托盘菜单中开关（仅 Windows）；默认开启。
- 验证需要真实的 Windows 会话：只有缩略图真正可见时 DWM 才会发送 `WM_DWMSENDICONICTHUMBNAIL`。
- macOS / Linux 保留系统标题栏，没有缩略图工具栏；该功能完全跳过。

## 本地数据存储

主进程的本地状态集中在一个 SQLite 数据库 `sakura.db` 里，位于 Electron 的 `userData` 目录。使用 Electron 内置的 `node:sqlite`（WAL 模式），不需要 native 模块、rebuild 或 `asarUnpack`；POSIX 下库文件权限为 `0600`。渲染进程的界面偏好仍使用 `localStorage`。

| 表 | 内容 |
| --- | --- |
| `kv` | 桌面配置（服务器地址、缓存额度、设备标识、窗口尺寸 / 位置 / 最大化状态）、会话令牌、以及「仅本机」平台凭据；凭据值仍由 `safeStorage` 加密。 |
| `offline_items` | 下载索引：平台 / 曲目 ID、音质、大小与相对文件名。 |
| `response_cache` | 带 TTL 的歌词与详情 JSON 响应，供断网回退。 |
| `media_cache` | 仅音频 / 封面元数据：完整长度、MIME、字节数、最近访问时间。 |

**媒体文件一律不入库。** 音频前缀、封面图与已下载曲目仍以文件形式留在磁盘（`sakura-cache/audio/*.audio`、`sakura-cache/cover/*.img` 与用户选择的下载目录），仍由本地 BFF 通过 HTTP Range 流式返回。缓存用量统计与 LRU 淘汰改走 SQL，不再扫描目录；下载依旧先写 `.part` 文件，成功后才改名。

项目尚未发布，代码中没有旧版 JSON 的导入或清理逻辑。要重置到干净状态，删除 `sakura.db`（或整个 `userData` 目录）即可。

## 技术栈

- **外壳**：Electron 38（主进程 + preload + 渲染进程）、electron-vite、electron-builder
- **界面**：Vue 3.5（`<script setup>`）、Pinia、Vue Router、TypeScript
- **图形**：手写 WebGL2 着色器（沉浸 / 雾笺）、PixiJS v8（绘光）、three.js（町景）
- **原生**：koffi FFI 调用 Windows DWM / 任务栏缩略图；`safeStorage` 加密会话
- **存储**：Electron 内置 `node:sqlite`（WAL 模式）；媒体文件仍留在磁盘
- **质量**：`vue-tsc` + `tsc` 类型检查、`scripts/` 下的 CDP 冒烟脚本

## 开发

```bash
npm install
npm run dev
```

开发模式下：

- dev / release 的页面都从 `sakura://app` 加载：同一 origin、同一份 CSP、`localStorage` 稳定
- dev 时主进程协议层把静态请求转发给 Vite（`http://localhost:5173`，HMR 照常工作），把 API / 媒体 / SSE 请求转发给进程内 BFF（`http://127.0.0.1:3210`）
- 渲染进程不直接访问 Vite 或 BFF，这两个端口对页面不可见

## 构建

```bash
npm run typecheck   # 同时运行 typecheck:node（tsc）与 typecheck:web（vue-tsc）
npm run build
npm start            # 预览构建产物
npm run pack         # 生成当前平台的未打包目录
npm run dist         # 生成当前平台的安装包
```

打包配置位于 `electron-builder.yml`；产物输出到 `release/`。

应用图标由 Android 客户端（`client-android`）派生：`build/icon-source.png` 是自适应图标的前景层。修改后重新生成 `build/icon.png`：

```bash
python scripts/make-icon.py     # 需要 Pillow 与 NumPy
```

## 安全设计

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- BFF 只绑定回环地址，并拒绝所有不带令牌的请求：令牌每次启动随机生成，由主进程的 `sakura://app` 协议层注入内部 `x-sakura-bff` 请求头，页面拿不到 —— 即使其他本地进程扫到了端口也无法调用 `/api`
- 会话 Cookie 由 `safeStorage` 加密后存入主进程的 SQLite 数据库；`Set-Cookie` 响应头永远不会转发给渲染进程
- CSP 以 meta 标签写在 `index.html` 里（dev / release 同一份文件）：脚本限制为同源，音频限制为同源 + blob
- 自签名证书按服务器显式启用；从不全局关闭 TLS 校验
- 「仅本机」第三方平台凭据同样加密存库，由主进程按请求注入；渲染进程拿不到原始 cookie

## 冒烟测试

辅助脚本位于 `scripts/`：

```bash
# 最小网关桩（登录 / 会话 / 健康检查）
node scripts/mock-gateway.mjs

# 以远程调试模式启动 Electron
node_modules/electron/dist/electron.exe --remote-debugging-port=9222 .

# 读取页面状态并截图
node scripts/cdp-smoke.mjs smoke.png

# 服务器配置 → 登录 → 首页 → 主题 → 退出 的完整流程
node scripts/cdp-flow.mjs
```

`cdp-flow.mjs` 假设应用从服务器配置页启动。要重置到干净状态，删除应用 `userData` 目录下的 `sakura.db`（Windows 上是 `%APPDATA%\Sakura Music\`，macOS / Linux 上是对应的 `app.getPath('userData')` 目录）。`sakura-cache/` 中的媒体缓存与已下载曲目不在数据库里，需要的话另行删除。

## 已知限制

- 任务栏缩略图预览仅支持 Windows（Win10 / Win11），且依赖 DWM
- 没有自动更新 —— 用户需手动安装新版本
- 未做代码签名：Windows SmartScreen 会提示警告，macOS 需要右键 → 打开
- 「仅本机」平台凭据只保存在这台设备上，不会在多设备间同步
- 网关协议规范维护在网关仓库中；本仓库只包含客户端实现
- M6 的打磨与发布工作仍在进行中

## 目录结构

```
src/
  main/        主进程：BFF、配置、会话、IPC、离线下载与桌面歌词 / 播放窗口
    db/        本地 SQLite：kv（配置 / 凭据）、离线索引、响应与媒体缓存元数据
    windows/   窗口创建、圆角、Windows 任务栏缩略图预览
  preload/     通过 contextBridge 暴露的最小桌面能力
  renderer/    Vue 3 桌面界面
    components/nowPlaying/
               全屏播放页样式（nowPlaying/modes、machi、nebbia、lumiere、pixi）
  shared/      主进程与渲染进程共享的类型与常量
scripts/       开发期冒烟测试辅助脚本
build/         图标与其他打包资源
```

## 开源项目与致谢

这个客户端建立在大量优秀的开源工作之上。感谢以下项目的维护者与贡献者：

**运行时与工具链**
- [Electron](https://www.electronjs.org/) —— 桌面外壳（MIT）
- [Vue.js](https://vuejs.org/) 与 [Vue Router](https://router.vuejs.org/) —— 渲染层框架（MIT）
- [Pinia](https://pinia.vuejs.org/) —— 状态管理（MIT）
- [Vite](https://vitejs.dev/) 与 [electron-vite](https://electron-vite.org/) —— 开发服务器与构建流水线（MIT）
- [TypeScript](https://www.typescriptlang.org/) —— 类型系统（Apache-2.0）
- [electron-builder](https://www.electron.build/) —— 打包与安装包（MIT）

**图形**
- [PixiJS](https://pixijs.com/) —— 绘光（Lumiere）渲染（MIT）
- [three.js](https://threejs.org/) —— 町景（Machi）街景（MIT）
- [@chenglou/pretext](https://github.com/chenglou/pretext) —— 绘光使用的文字排版（MIT）

**原生**
- [koffi](https://koffi.dev/) —— 调用 Windows DWM 与任务栏缩略图 API 的 FFI（MIT）

**数据**
- [AnimCJK](https://github.com/animCJK) —— 雾笺（Nebbia）笔顺书写所用的笔画轮廓数据。其图形数据源自 Arphic PL KaitiM 字体，以 **Arphic Public License** 分发。许可证原文随笔顺数据一同发布，见 [`nebbia/licenses/nebbia-strokes/`](src/renderer/src/components/nowPlaying/nebbia/licenses/nebbia-strokes)。

**播放页样式**
雾笺（Nebbia）、绘光（Lumiere）与町景（Machi）三种可视化移植自 **[Folia](https://github.com/chthollyphile/folia-major)** 桌面音乐可视化项目（`folia-major`）。非常感谢原作者提供 WebGL2 / PixiJS / three.js 引擎、场景设计与其中大量细致的巧思。移植保留了渲染代码的原貌，只把 React 外壳改写成了 Vue。

## 许可证

MIT
