首个 Windows x64 安装预览版。

- 按当前 Windows 用户安装，提供开始菜单、可选桌面快捷方式和系统卸载入口。
- 自带 Node.js 24.22.0 和 PowerShell 7.6.5；第一次启动需联网下载锁定版本的官方 Codex CLI 和相关依赖，之后无需重复下载。
- 在本地 ChatGPT Work / Codex 会话按 Ctrl+Alt+L，打开同步终端。当前本机已验证双向会话同步，以及 ChatGPT 窗口化、最大化时的一次快捷键前置。

兼容版本：Windows x64，ChatGPT Desktop / OpenAI.Codex **26.1013.3656.0**，CLI **0.163.0-alpha.10.2**。请先正常安装并登录 ChatGPT。其他客户端版本会被拒绝，等待重新验证后再支持。

安装完成不会自动启动或关闭 ChatGPT。首次使用时，先完成任务并正常退出 ChatGPT，再打开 **Codex Session to Terminal**。终端显示在前面时，键盘焦点仍可能留在 Desktop，输入前点一下终端。

卸载会移除程序文件、下载的程序依赖和快捷方式，保留用户配置与连接数据。此工具不会移除 ChatGPT，也不会删除聊天历史。

安装包尚未进行代码签名，Windows 可能显示“未知发布者”。同页提供 SHA256 校验文件。安装和卸载在干净的 Windows CI 环境中验证；其他电脑上的完整会话同步仍需进一步验证。

这是非官方 Preview，依赖客户端内部接口；客户端更新后可能需要重新适配。
