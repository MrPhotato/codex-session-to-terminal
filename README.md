# Codex Session to Terminal

<img src="assets/icon.png" width="128" alt="Codex Session to Terminal icon" />

在 Windows 上，为已经运行的 ChatGPT 本地 Work / Codex 聊天打开实时终端。Codex Session to Terminal 独立驻留系统托盘，退出后 ChatGPT 继续工作。

**0.2 Preview · Windows x64 · 非官方集成。** 新版通过 Desktop 已有的本机通信通道跟随当前会话，不修改官方程序、快捷方式或启动参数，不需要重启 ChatGPT。检查通信能力和协议格式，不锁定 Desktop 的完整版本号。

源码：[MrPhotato/codex-session-to-terminal](https://github.com/MrPhotato/codex-session-to-terminal)。公开安装包：[GitHub Releases](https://github.com/MrPhotato/codex-session-to-terminal/releases)。发布页仍标为 0.1 的安装包使用旧方案；请以版本和发布说明为准。

## 使用独立模式

1. 像平常一样打开 ChatGPT。
2. 双击 `Start-CST.cmd`，或开始菜单的 **Codex Session to Terminal - Independent**。Codex Session to Terminal 打开会话面板、驻留系统托盘，并发出一次启动通知；再次打开会显示已有实例的面板。
3. 在已有键盘焦点的本地 Work / Codex 聊天按 **Ctrl+Alt+L**，用官方 Codex CLI 打开同一条聊天。输入前点击终端。
4. 单击托盘图标查看终端会话面板。关闭面板会收回托盘。
5. 右键托盘图标选择 **退出 / Exit**，断开本轮所有终端；ChatGPT 和已接受的任务继续运行。

会话面板仅显示本轮打开的终端会话，展示实际连接状态和是否有任务运行。同一聊天打开多个终端时合并显示数量。关闭终端后自动移除，失去心跳的连接不会继续显示为已连接。面板和托盘菜单的深浅色跟随 Windows 应用主题，中英文跟随 Windows 显示语言（其他语言使用英文），没有额外切换按钮。托盘菜单显示完整产品名称、ChatGPT 是否已打开及快捷键提示，并提供查看会话、查看原版入口和退出三个操作。启动通知遵循 Windows 的通知和勿扰设置。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/session-panel-dark.png">
  <img src="assets/session-panel-light.png" width="760" alt="Codex Session to Terminal 终端会话面板，展示示例会话的连接与运行状态">
</picture>

Codex Session to Terminal 使用 ChatGPT 自带的“复制聊天链接”快捷键。它仅在官方 Desktop 位于前台时处理新复制的本地链接；不会监听其他应用的聊天内容，也不会保存剪贴板。

| 终端操作 | 行为 |
| --- | --- |
| Enter | 空闲时发送新一轮；任务运行时补充当前任务 |
| Ctrl+Enter 或 Tab | 加入会话队列，等待当前任务完成后处理 |
| Esc | 中断当前任务，同步回 Desktop |
| CLI 的历史浏览与输入快捷键 | 沿用官方 CLI 操作 |
| Ctrl+C 或 `/quit` | 退出这个 CLI；任务运行时先留意 CLI 的中断提示 |

部分 Windows 终端会把 Ctrl+Enter 编码成普通 Enter，这时请用 **Tab** 排队。Tab 已实测；Ctrl+Enter 已在本次 CLI 进程配置，实际按键取决于终端。Codex Session to Terminal 不修改你的全局终端快捷键。排队由这个 CLI 管理，关闭该终端会丢弃尚未发送的队列；Desktop 已接受的任务继续运行。发送确认超时后，会按唯一消息编号核对原会话的服务端回执；仍无法确认时请检查桌面，不自动重发消息。

终端使用未修改的官方 Codex CLI。支持历史显示、运行中接入、双向文本消息、补充、排队、工具输出和中断。长聊天需要先由 Desktop 加载完整历史，首次连接可能需要几分钟；连接窗口会显示加载提示，可按 Ctrl+C 取消等待。无法取得完整快照时明确报错，不显示不完整历史冒充成功。审批、附件、模型切换、插件交互和未接入的原生命令仍在 Desktop 处理。云端聊天、远程主机及 SSH 任务不在本版范围内。

## 随时回退原版

原有 `Start.cmd`、`Enable-Normal-Desktop.cmd`、共享连接配置及官方 CLI 方案均保留。独立模式和旧方案使用不同的运行目录。

1. 右键托盘退出 Codex Session to Terminal。
2. 等当前任务结束，再由你正常退出 ChatGPT。
3. 打开 **Codex Session to Terminal - Legacy Shared Startup** 或原有 `Start.cmd` / `Enable-Normal-Desktop.cmd`。

旧方案需要由 Codex Session to Terminal 启动共享后台，因此要求先退出普通启动的 ChatGPT；它不会强行关闭应用。完整说明见 [LEGACY.md](LEGACY.md)。托盘的 **查看原版启动入口 / Show legacy startup files** 可以找到回退入口，不会替你重启 ChatGPT。

从旧版升级时，已有同名快捷方式保持原目标；开始菜单另提供明确的 **Independent** 与 **Legacy Shared Startup** 两个入口。

## 安装与运行要求

- Windows x64，正常安装并登录 `OpenAI.Codex` 桌面包。
- 独立模式需要 Node.js 22+ 和 PowerShell 7.4+；安装包附带运行时。源码部署先运行 `npm ci`，再运行 `Start-CST.cmd`。
- 推荐 Windows Terminal，没有时使用 PowerShell 控制台。
- `Start-CST.ps1 -Check` 仅检查文件、运行时、依赖和执行策略，不下载依赖、不打开托盘或 ChatGPT。
- 不设置系统执行策略，不绕过管理员/用户明确配置的 Restricted 或 AllSigned。

安装器不启动或关闭任何应用；当前用户安装，无需管理员权限。卸载保留私有状态及 ChatGPT 账号和聊天历史。首次启动 Codex Session to Terminal 时下载锁定的官方 CLI 和适配层依赖。

## 连接与本地数据

Codex Session to Terminal 在现有 `codex-ipc` 管道注册自己的客户端身份，发现会话原 owner，再订阅快照与增量。连接前在同一管道句柄上验证服务进程属于当前 Windows 用户及已安装的官方 Desktop 路径。它不声明会话所有权、不独立 resume 正在运行的聊天。

官方 CLI 连接 Codex Session to Terminal 为本次终端创建的本机 WebSocket，Codex Session to Terminal 将快照和增量转换成 CLI 使用的官方事件格式。发送、补充和中断交给原 owner；CLI 不会另起同一聊天的执行后台。WebSocket 只绑定本机回环地址，拒绝浏览器 Origin，凭证仅传入这个 CLI 的环境变量，不写入文件或命令行。

一个隐藏的官方 app-server 辅助进程提供账号、模型、技能和配置等只读元数据。接口白名单禁止它恢复或执行会话，也不通过插件发现接口触发下载。辅助进程可能写入其自身的运行日志或缓存。终端断开后关闭该辅助进程。

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

测试覆盖协议身份、完整历史、快照和增量、丢失快照的有界恢复、原生事件格式、参数与线程约束、结果不明时不重放、终端退出清理、托盘生命周期及旧方案回归。Windows 二进制传输测试使用约 14 MiB 的合成数据和慢读端，逐字节校验大帧传输；双进程测试验证重复启动能唤起已有面板。模拟测试不使用真实账号。真实消息测试只在用户明确授权的专用聊天进行。

原有共享启动方案的安装、窗口前置验证与限制保留在 [LEGACY.md](LEGACY.md)。协议参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。官方文档不代表 OpenAI 支持本项目的 Desktop 内部挂接协议。

## 许可

项目源码与图标采用 [MIT License](LICENSE)。第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目未获得 OpenAI 官方背书。
