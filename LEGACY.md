# Codex Session to Terminal

<img src="assets/icon.png" width="128" alt="Codex Session to Terminal icon" />

在 Windows 上，把当前 ChatGPT 本地 Work / Codex 会话接到旁边的终端。桌面与 CLI 使用同一个后台、同一条会话，可以继续收发消息和观察任务进度。

**Preview · Windows x64 · 非官方集成。** 本项目依赖 Desktop 的内部启动机制和实验性 App Server 接口。启动时检查实际连接能力，不按 Desktop 的完整版本号拦截更新。它不是独立聊天客户端，不包含官方 Desktop 或 CLI 程序。

源码仓库：[MrPhotato/codex-session-to-terminal](https://github.com/MrPhotato/codex-session-to-terminal)。

提供当前用户安装的 Windows 安装包，也可以从源码手动部署。安装包见 [GitHub Releases](https://github.com/MrPhotato/codex-session-to-terminal/releases)，下载其中以 `windows-x64-setup.exe` 结尾的文件；GitHub 自动生成的 Source code ZIP 是源码包。

## 能做什么

- 从日常 Desktop 的当前本地聊天，按 **Ctrl+Alt+L** 打开对应 CLI。
- 本机已验证：ChatGPT 窗口化和最大化时，一次快捷键都能让新终端显示在 Desktop 前方，前置完成后终端未保持置顶。键盘焦点仍在 Desktop，输入前需要点击终端。其他电脑尚未全面验证；若用户已切到其他应用，则停止主动前置。
- 在桌面与终端继续同一条会话，不复制历史、不另建 Agent。
- 为不同会话打开各自的终端窗口。
- 关闭 CLI 只断开该终端连接，后台任务继续运行。

当前实测覆盖本地 Work 会话的双向消息、会话定位、普通桌面工具调用和终端缩放。入口按本地会话识别，不按 Work / Codex 标签限制；单独的 Codex 本地任务尚未独立验收。云端聊天、远程主机和 SSH 任务不属于本版支持范围。交互审批和全部插件尚未逐项验证。

## 安装前提

| 组件 | 当前要求 |
| --- | --- |
| Windows | x64 |
| ChatGPT Desktop / OpenAI.Codex 包 | 已完成正常安装与登录；启动时自动发现当前包路径 |
| Desktop 内置 CLI | 使用当前包自带的后台程序，检查所需 WebSocket 与鉴权能力 |
| 独立终端 CLI | 安装锁定的 `0.163.0-alpha.10.2`，检查远程连接参数 |
| PowerShell | 安装包自带 7.6.5；源码部署需 7.4 或更新版本 |
| Node.js / npm | 安装包自带 Node.js 24.22.0 和 npm；源码部署需 Node.js 22 或更新版本 |
| C# 编译器 | Windows .NET Framework 4 的 `csc.exe` |
| Windows Terminal | 推荐；没有时使用 PowerShell 窗口 |

Desktop 更新后无需手动修改版本号或安装目录。每次共享启动都会重新发现当前包、检查后台和终端的连接参数、刷新启动配置，并验证新后台的鉴权连接与会话列表接口。启动检查通过不等于所有未来接口都永久兼容；若接口确实变化，会提示具体缺失能力或连接失败，不关闭已经启动的 Desktop。`production.ps1 -Action Check` 可单独检查本机组件，不启动 Desktop 或修改连接配置。

## 开始使用

### 使用安装包

1. 下载并运行 `Codex-Session-to-Terminal-0.1.0-preview.2-windows-x64-setup.exe`。安装在当前用户目录，无需管理员权限。
2. 先正常安装、打开并登录兼容版本的 ChatGPT。完成正在运行的任务后，正常退出 ChatGPT。
3. 从开始菜单打开 **Codex Session to Terminal**。首次启动需要联网下载锁定版本的官方 CLI 和相关依赖，准备成功后才打开 ChatGPT。
4. 在有键盘焦点的本地聊天中按 **Ctrl+Alt+L**，打开同步终端；输入前点击终端。

安装完成不会自动启动或关闭 ChatGPT。如果 ChatGPT 已在运行，启动入口会提示先退出，不中断任务。已有同名桌面快捷方式会保留；安装版可始终从开始菜单进入。

可在 Windows“已安装的应用”中卸载。程序文件、快捷方式和下载的程序依赖会被移除，私有配置、ChatGPT 账号和聊天历史会保留。程序文件仍在使用时，升级或卸载会提示先退出，安装器不会结束相关进程。

首个 Preview 未做代码签名，Windows 可能显示“未知发布者”；发布页同时提供 SHA256 校验文件。

### 从源码部署

1. 将源码放到一个固定目录，打开该目录的终端。
2. 安装锁定版本的依赖：

   ```powershell
   npm ci
   ```

3. 双击 `Prepare.cmd`，发现本机组件并生成私有连接配置和小型原生启动器。
4. 完成当前任务并退出 ChatGPT，然后双击 `Enable-Normal-Desktop.cmd`。
5. 在已有键盘焦点的本地聊天中按 **Ctrl+Alt+L**。当前聊天会在新终端中打开；需要输入时，点击终端。

可为 `Enable-Normal-Desktop.cmd` 创建名为 **Codex Session to Terminal** 的 Windows 快捷方式，并将图标设为 `assets/icon.ico`。`assets/icon.png` 用于项目页面；ICO 包含 16–256 像素的多个尺寸。

本工具保留原账号和历史，不设置系统级环境变量。已在普通模式运行的后台不能直接热迁移；启动器不会自动关闭正在运行的 Desktop。

本版面向默认 `%USERPROFILE%\.codex` 配置目录，自定义 `CODEX_HOME` 尚未适配。启动器不会修改 Windows 的用户或机器执行策略；仅在各作用域都未配置、Windows 使用默认 Restricted 时，为这次启动进程选择 RemoteSigned。管理员或用户明确设置的 Restricted / AllSigned 会保留并阻止启动。源码下载文件还需符合本机的脚本信任策略。

## 日常入口

| 文件 | 用途 |
| --- | --- |
| `Start.cmd` | 普通启动入口；检查运行状态、准备依赖和配置后打开 Desktop |
| `Prepare.cmd` | 首次准备或重新验证版本后的配置更新 |
| `Enable-Normal-Desktop.cmd` | 以共享连接方式打开日常 Desktop |
| `Open-Current-Chat.cmd` | 复制当前本地聊天链接后，手动打开对应 CLI |
| `Status.cmd` | 查看共享启动与快捷入口状态 |
| `Stop-Shortcut.cmd` | 停止快捷入口监听，保留已有聊天和终端 |

CLI 中输入 `/quit` 或关闭该终端即可断开连接。真正退出 Desktop 会结束其共享后台，连接它的 CLI 随之断开。

要恢复原来的使用方式，完成任务、退出 Desktop，再从原来的官方入口打开。不要在任务运行期间删除私有目录或编译产物。

## 本地数据与权限

配置、连接凭证及编译产物存放于 `%LOCALAPPDATA%\SessionBridge`，仅当前用户和 SYSTEM 可访问。源码包不含账号、凭证或聊天记录。独立 CLI 由 npm 安装，保留其上游许可。

后台仅监听回环地址并要求 Bearer 凭证。快捷入口监听器仅在目标 Desktop 窗口处于前台时处理新复制的本地聊天链接，不保存剪贴板内容。它只接受格式校验后的本地会话 ID。

这不是额外的权限沙箱。连接后的 CLI 使用该会话已有的工具和权限。不要分享私有连接目录、访问令牌或含聊天内容的日志。

## 实现组成

- PowerShell：组件发现、配置、启动与快捷入口。
- C#：原生命令转发、单实例保护和后台进程生命周期。
- Node.js：Desktop 标准输入输出与鉴权 WebSocket 的连接。
- Codex CLI：官方终端界面，由用户自行安装的依赖提供。

源码目录不包含官方 EXE / DLL、`node_modules` 或本机测试记录。原生启动器在本机准备时编译。

## 开发与验证

```powershell
npm ci
npm test
npm run test:powershell
```

自动检查覆盖协议模拟、参数转发、链接解析、启动环境保护，以及窗口选择和临时置顶后的清理调用顺序。窗口相关测试使用合成记录和注入回调，不操作真实窗口；自动检查不会启动真实 Desktop、使用账号或发送模型请求。

本机另通过真实 **Ctrl+Alt+L** 和持续运行的监听器，分别验证了 Desktop 窗口化、最大化时的单次快捷键前置。窗口层级、屏幕采样和置顶状态回读均确认新终端显示在 Desktop 前方，且已恢复为非置顶窗口；键盘焦点仍在 Desktop。快捷键需要聊天窗口已有键盘焦点，单纯显示在前方并不代表已经获得键盘焦点。这些实测仅覆盖上述版本组合；其他电脑上的前置行为，以及公开版的自动发现与完整安装流程，仍需验证。

直接启动打包应用可能与官方激活入口具有不同的 Windows 应用身份。任务栏图标、自动更新及其他系统集成仍需独立验证。一次本机运行观察到系统深色模式下窗口使用黑色图标，但尚未确认是否由本工具触发；本项目没有改写官方图标或安装包。终端通过同一后台中断任务会影响桌面中的该任务。

协议参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)、[CLI 参数](https://learn.chatgpt.com/docs/cli/reference)。协议文档不代表官方支持本项目的 Desktop 挂接方式。

## 许可

项目源码与图标采用 [MIT License](LICENSE)。第三方依赖按各自许可使用，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目未获得 OpenAI 官方背书。
