# Codex Session to Terminal

<img src="assets/icon.png" width="128" alt="Codex Session to Terminal icon" />

在 Windows 上，为已经运行的 ChatGPT 本地 Work / Codex 聊天打开实时终端。CST 独立驻留系统托盘，退出后 ChatGPT 继续工作。

**0.2 Preview · Windows x64 · 非官方集成。** 新版通过 Desktop 已有的本机通信通道跟随当前会话，不修改官方程序、快捷方式或启动参数，不需要重启 ChatGPT。检查通信能力和协议格式，不锁定 Desktop 的完整版本号。

源码：[MrPhotato/codex-session-to-terminal](https://github.com/MrPhotato/codex-session-to-terminal)。公开安装包：[GitHub Releases](https://github.com/MrPhotato/codex-session-to-terminal/releases)。发布页仍标为 0.1 的安装包使用旧方案；请以版本和发布说明为准。

## 使用独立模式

1. 像平常一样打开 ChatGPT。
2. 双击 `Start-CST.cmd`，或开始菜单的 **CST - Independent**。CST 图标出现在系统托盘，并发出一次启动通知。
3. 在已有键盘焦点的本地 Work / Codex 聊天按 **Ctrl+Alt+L**，打开这条聊天的 CST 终端。输入前点击终端。
4. 单击托盘图标查看终端会话面板。关闭面板会收回托盘。
5. 右键托盘图标选择 **退出 CST / Exit CST**，断开本轮所有 CST 终端；ChatGPT 和已接受的任务继续运行。

会话面板仅显示当前这轮 CST 打开的终端会话，展示实际连接状态和是否有任务运行。同一聊天打开多个终端时合并显示数量。关闭终端后自动移除，失去心跳的连接不会继续显示为已连接。面板的深浅色跟随 Windows 应用主题，中英文跟随 Windows 显示语言（其他语言使用英文），没有额外切换按钮。启动通知遵循 Windows 的通知和勿扰设置。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/session-panel-dark.png">
  <img src="assets/session-panel-light.png" width="760" alt="CST 终端会话面板，展示示例会话的连接与运行状态">
</picture>

CST 使用 ChatGPT 自带的“复制聊天链接”快捷键。它仅在官方 Desktop 位于前台时处理新复制的本地链接；不会监听其他应用的聊天内容，也不会保存剪贴板。

| 终端操作 | 行为 |
| --- | --- |
| Enter | 空闲时发送新一轮；任务运行时补充当前任务 |
| Ctrl+Enter 或 Tab | 加入会话队列，等待当前任务完成后处理 |
| Ctrl+J | 在消息中换行 |
| Ctrl+U | 清空草稿 |
| PgUp / PgDn | 浏览当前保留的最近消息 |
| Ctrl+R | 重新建立只读跟随；不会重发先前消息 |
| Ctrl+C 或 `/quit` | 关闭这个终端连接 |

部分 Windows 终端会把 Ctrl+Enter 编码成普通 Enter，这时请用 **Tab** 排队。CST 不修改你的全局终端快捷键。发送结果不明确时保留草稿并提示检查桌面，绝不自动重试或把排队改成补充。

这是 CST 自己的简洁终端界面，显示聊天文字、工具进度和等待输入提示。审批、附件、模型选择、插件交互仍在 ChatGPT 中处理。当前加载最近 100 条可见消息，缩放窗口只重绘当前屏幕。云端聊天、远程主机及 SSH 任务不在本版范围内。

## 随时回退原版

原有 `Start.cmd`、`Enable-Normal-Desktop.cmd`、共享连接配置及官方 CLI 方案均保留。独立模式和旧方案使用不同的运行目录。

1. 右键托盘退出 CST。
2. 等当前任务结束，再由你正常退出 ChatGPT。
3. 打开 **CST - Legacy Shared Startup** 或原有 `Start.cmd` / `Enable-Normal-Desktop.cmd`。

旧方案需要由 CST 启动共享后台，因此要求先退出普通启动的 ChatGPT；它不会强行关闭应用。完整说明见 [LEGACY.md](LEGACY.md)。托盘的 **查看原版启动入口 / Show legacy startup files** 可以找到回退入口，不会替你重启 ChatGPT。

从旧版升级时，已有同名快捷方式保持原目标；开始菜单另提供明确的 **Independent** 与 **Legacy Shared Startup** 两个入口。

## 安装与运行要求

- Windows x64，正常安装并登录 `OpenAI.Codex` 桌面包。
- 独立模式需要 Node.js 22+ 和 PowerShell 7.4+；安装包附带运行时。源码部署可直接运行 `Start-CST.cmd`，独立模式没有额外 npm 依赖。
- 推荐 Windows Terminal，没有时使用 PowerShell 控制台。
- `Start-CST.ps1 -Check` 仅检查文件、运行时和执行策略，不打开托盘或 ChatGPT。
- 不设置系统执行策略，不绕过管理员/用户明确配置的 Restricted 或 AllSigned。

安装器不启动或关闭任何应用；当前用户安装，无需管理员权限。卸载保留私有状态及 ChatGPT 账号和聊天历史。旧方案首次使用时才需要下载锁定的官方 CLI 依赖。

## 连接与本地数据

CST 在现有 `codex-ipc` 管道注册自己的客户端身份，发现会话原 owner，再订阅快照与增量。连接前在同一管道句柄上验证服务进程属于当前 Windows 用户及已安装的官方 Desktop 路径。它不声明会话所有权、不独立 resume 正在运行的聊天。

发送和补充交给原 owner。排队使用当前桌面包自带后台的 `thread/queue/add` 追加接口：只有按排队时才启动短暂的隐藏辅助进程，只初始化、检查队列和追加消息，不加载会话或成为 writer。队列由原后台处理；跨进程发现可能需要数秒，桌面输入框是否显示排队项取决于该功能是否启用。

独立模式状态位于 `%LOCALAPPDATA%\SessionBridge\independent\runs`，每轮使用独立目录，保存托盘进程身份、心跳和退出信号。面板读取该轮 `sessions` 目录中的会话 ID、标题、终端进程、连接阶段和更新时间；终端正常退出时删除自身记录。不会额外保存账号、凭证或聊天正文。退出托盘或心跳失效会断开终端；已经被会话接受的任务不会因此取消。

内部协议未来可能变化。协议不匹配时停止该连接并显示错误，旧方案仍可选择。仅检查文件版本不会触发限制。

## 开发与验证

```powershell
npm ci
npm test
npm run test:powershell
./installer/Build-Installer.Tests.ps1
./Start-CST.ps1 -Check
```

测试覆盖协议身份、快照和增量、丢失增量后的恢复、发送与排队的区分、结果不明时不重放、终端控制字符过滤、中文换行、窗口缩放、托盘生命周期及旧方案回归。模拟测试不使用真实账号。真实消息测试只在用户明确授权的专用聊天进行。

原有共享启动方案的安装、窗口前置验证与限制保留在 [LEGACY.md](LEGACY.md)。协议参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。官方文档不代表 OpenAI 支持本项目的 Desktop 内部挂接协议。

## 许可

项目源码与图标采用 [MIT License](LICENSE)。第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目未获得 OpenAI 官方背书。
