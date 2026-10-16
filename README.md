# Chill ChatGPT Bridge

使用现有 ChatGPT 订阅，为《Chill With You》AIChat Mod 连接文字对话。

这是个人本机适配项目，不是 OpenAI 或游戏官方产品。它将 AIChat 的本机 Chat Completions 请求转换为官方支持的 Responses 请求，授权、身份验证、订阅权限和令牌刷新复用 OpenAI Sign-in with ChatGPT DevKit。

## 使用条件

- Windows 10/11，Node.js 22.12 或更高版本。
- 已安装 BepInEx、AIChat Mod；ChillPatcher 可提供整合后的游戏窗口。
- 符合官方接入条件的 ChatGPT 订阅及手动授权。能否使用以实际账号授权和完整推理测试为准。

本项目不需要 OpenAI API Key，不使用网页 Cookie 或 ChatGPT 私有 backend-api。订阅额度与其他使用该订阅的应用共享；达到限制会显示错误，不会自动切换到付费 API。

## 安装与登录

1. 在本项目目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1`。脚本安装到当前用户的 LocalAppData，并添加开始菜单入口。此参数只影响本次 PowerShell 进程，不修改系统执行策略。
2. 从开始菜单打开 **Chill ChatGPT Bridge**，或运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Start.ps1`。启动器通过 Windows 桌面启动后台服务，终端关闭后仍可运行。
3. 本机页面点击 **Continue with ChatGPT**，在 OpenAI 官方页面手动完成登录和订阅授权。
4. 选择账号实际提供的模型，点击“测试文字对话”。只有收到完整回复才算推理成功。
5. 运行游戏配置脚本。如果从 Wallpaper Engine 运行，请指定其项目内的游戏副本目录；如果提示权限不足，再使用管理员 PowerShell：

   ```powershell
   .\Configure-Game.ps1 -GameDirectory '你的游戏目录'
   ```

6. 重启游戏，在 AIChat 窗口发送文字。使用期间适配服务需要保持运行。

也可以直接用 `node server.mjs` 启动，无需安装脚本。管理页面为 `http://127.0.0.1:17941`。

默认数据目录为 `%LOCALAPPDATA%\ChillChatGPTBridge`。需要自定义目录时，在安装、手动启动及游戏配置时传入同一个 `-DataDirectory`：

```powershell
$bridgeData = Join-Path $env:LOCALAPPDATA 'ChillChatGPTBridge\my-state'
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -DataDirectory $bridgeData
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start.ps1 -DataDirectory $bridgeData
powershell -NoProfile -ExecutionPolicy Bypass -File .\Configure-Game.ps1 -GameDirectory '你的游戏目录' -DataDirectory $bridgeData
```

安装生成的开始菜单快捷方式会记住该目录。显式 `-DataDirectory` 优先于进程环境变量 `CHILL_BRIDGE_DATA_DIR`；后者可供未显式指定目录的启动和游戏配置脚本使用。账号文件位于所选目录的 `chatgpt` 子目录。运行中的其他桥接占用端口时，启动器会报错，不会结束其他进程。

## 游戏配置

配置脚本修改 `BepInEx/config/com.username.chillaimod.cfg` 的 LLM 部分，并先保存备份：

- `API_URL`：`http://127.0.0.1:17941/v1/chat/completions`
- `API_Key`：自动生成的本机连接凭据，**不是 OpenAI API Key 或 OAuth 令牌**。
- `ModelName`：`chatgpt-subscription`，具体模型在本机管理页选择。
- `ThinkMode=Default`、`Use_Ollama_API=false`、`FixApiPathForThinkMode=false`。

AIChat 原有的角色提示词、字幕、语音功能仍由 AIChat 负责。本适配器只处理文字；没有安装或启动语音合成、语音识别或持续录音服务。

若只需手动文字对话，可在 AIChat 配置中关闭 `ExperimentalMemory` 和 `Enable_VoiceCall`，并将 `LaunchTTSService` 设为 `false`。分层记忆会额外请求模型总结，连续通话也可能持续产生请求。手动对话仍会使用所授权的 ChatGPT 共享额度。

## 数据与安全

- 服务仅监听 IPv4 回环地址 `127.0.0.1`。
- OAuth 凭据由 Windows DPAPI CurrentUser 加密，默认保存在 `%LOCALAPPDATA%\ChillChatGPTBridge\chatgpt`，自定义目录时保存在 `<DataDirectory>\chatgpt`；不会发送给游戏或网页界面。
- 账号状态和模型选择只在本机管理页显示。聊天内容只发送至官方 `https://api.openai.com/v1/responses`。
- 游戏连接和管理页面使用不同的本机凭据，并校验 Host、Origin 和跨站请求。
- 不记录聊天正文、授权 URL 或访问令牌。Git 仓库不包含任何运行时账号文件、游戏配置或本机凭据。
- “退出当前连接”通过官方组件尝试撤销可刷新的会话；也可从 ChatGPT 设置中撤销应用授权。

卸载时可删除 LocalAppData 下的程序目录和开始菜单快捷方式。账号数据保存在独立数据目录；先在管理页退出连接，再按需删除该目录。恢复游戏配置时使用配置脚本创建的备份。

## 测试

```powershell
node --test test/*.test.mjs
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\test\configure-game.ps1
```

从项目根目录执行以上命令。测试覆盖请求转换、回环 HTTP 权限、跨站请求拒绝、上游错误、异步登录状态以及真实 Windows DPAPI 的模拟凭据加解密。游戏配置脚本测试使用系统临时目录中的合成游戏、配置和凭据，检查其他设置与编码/换行保留、字段替换、原文件备份以及 `DataDirectory` / 环境变量 / 默认目录的优先级；完成后清理临时文件。离线测试不会使用真实账号、修改真实游戏配置或调用模型。

2026-10-16 已在 Windows 通过官方登录、订阅授权、账号模型获取和完整文字回复验证。游戏接口转换和解析的离线测试已通过，尚未自动验证游戏内字幕 UI。

## 协议与依赖

本项目自有桥接代码采用 [MIT](LICENSE)。`vendor/` 中的官方 DevKit 使用 **Sign-in with ChatGPT DevKit Noncommercial License v1.0**，其他依赖采用各自协议。因此，包含 DevKit 的整套发行包具有非商用限制，不能将整个仓库一概宣称为 MIT。见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [固定上游来源](vendor/UPSTREAM.md)。

官方组件的原始来源和许可证保留在仓库内。本项目当前仅用于个人本机非商用场景。

## 参考

- [官方订阅接入概览](https://developers.openai.com/siwc/token-sharing-open-source)
- [官方登录与注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [官方模型与推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [AIChat Mod](https://github.com/qzrs777/AIChat)
