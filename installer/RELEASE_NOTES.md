新增独立托盘模式：正常打开 ChatGPT 后，再按需打开 Codex Session to Terminal，无需重启或更改官方启动方式。

- 从 **Codex Session to Terminal - Independent** 或 `Start-CST.cmd` 启动，随后在当前本地聊天按 **Ctrl+Alt+L** 打开实时终端。
- Enter 发送或补充当前任务；Ctrl+Enter 或 Tab 排队。部分终端无法区分 Ctrl+Enter，请使用 Tab。
- 右键托盘选择 **退出 / Exit** 可断开终端，ChatGPT 和已经接受的任务继续运行。
- 界面、通知及快捷方式统一使用完整产品名称。托盘菜单重新整理了标题、状态、小图标和操作间距，深浅色及中英文跟随系统。
- 原版共享启动完整保留，可从 **Codex Session to Terminal - Legacy Shared Startup** 或原快捷方式回退。使用旧方案前需由用户正常退出 ChatGPT。

独立模式使用未修改的官方 Codex CLI；审批、附件、模型和插件交互仍在 ChatGPT 中处理。现有同名快捷方式保持原目标，安装版另提供 Independent 和 Legacy 两个明确入口。

Windows x64，当前用户安装，无需管理员权限。安装包附带 Node.js 和 PowerShell；首次启动下载锁定版本的官方 CLI 和适配层依赖。安装和卸载不会启动或结束 ChatGPT，也不会移除账号及聊天历史。

本机已在专用测试聊天验证发送、补充、排队、实时增量及中文终端输入，原会话 owner 保持不变。自动化测试覆盖旧方案回归、身份验证、断线和未知送达结果、退出清理、窗口缩放与安装文件范围。托盘的整套快捷键/窗口行为还需不同桌面环境验收。

非官方 Preview，依赖 Desktop 内部通信协议；检查协议能力，不按 Desktop 完整版本号锁定。安装包未代码签名，发布资产附 SHA256 校验文件。
