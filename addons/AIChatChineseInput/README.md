# AIChat 中文输入补丁

为 Wallpaper Engine 中《Chill With You》的 AIChat 卡片和 F9/F10 控制台提供 Windows 系统输入法编辑器。它独立于 ChatGPT Bridge 工作，不需要启动桥接服务，也不依赖 Rime。

## 使用

1. 点击壁纸卡片中的 AIChat 输入框。
2. 点击桌面左下角出现的 **中文输入（当前输入框）**。
3. 在弹出的 **AIChat 中文输入** 窗口使用平时的中文输入法打字。
4. 点击 **填回对话框**，确认卡片里显示文字，再点击卡片原有的 **发送**。

F9/F10 控制台的输入框上方也有 **中文输入（系统输入法）** 按钮。编辑窗口中回车用于输入法确认或换行，只有点击按钮才回填。取消或关闭窗口会保留原草稿。

左下角按钮也可用于其他已聚焦、可编辑的 OneJS TextField；密码框不显示该入口。按钮仅在输入框获焦时出现。编辑期间若卡片重载或草稿被其他操作修改，补丁不会覆盖新值；原控件仍存在时再次打开编辑器可恢复暂存结果。退出游戏会丢弃未回填的临时文字。

## 安装与回退

从本仓库 Release 下载中文输入补丁，解压后将 `BepInEx` 文件夹合并到**实际运行的游戏副本**目录，再重启游戏或壁纸。Wallpaper Engine 使用自己的项目副本时，应安装到那个副本中。

仅添加两个文件：

```text
BepInEx/plugins/AIChatChineseInput/AIChatChineseInput.dll
BepInEx/plugins/AIChatChineseInput/ChillChineseComposer.exe
```

回退：关闭对应游戏/壁纸后删除 `AIChatChineseInput` 文件夹，再启动。补丁不替换 AIChat.dll、ChillPatcher.dll、游戏 DLL、存档或账号配置。

## 从源码构建

Windows 10/11、系统 .NET Framework 4.x、BepInEx 5 和 AIChat Mod 1.10.0。构建只引用用户本机游戏/BepInEx 程序集；仓库及发行包不分发这些依赖。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1 -GameDirectory '实际游戏目录'
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test.ps1 -GameDirectory '实际游戏目录'
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -GameDirectory '实际游戏目录'
```

脚本参数只影响本次进程，不修改系统执行策略。安装到受保护目录可能需要管理员权限；安装脚本不停止游戏，应先退出对应游戏/壁纸再更新补丁。

## 实现与限制

- ChillPatcher 的桌面键盘队列对接 UIToolkit/TMP；AIChat 控制台使用 IMGUI，不能直接复用该队列。当前安装包还可能缺少 Rime 原生库。
- 独立 WinForms 顶层窗口获得 Windows 原生输入焦点，由系统 IME 处理中文候选。通过重定向管道在本机传递 UTF-8 草稿，不使用剪贴板、HTTP、账号、网络接口或正文日志。
- Unity 主线程通过 `TextField.value` 的正常变更事件更新 OneJS 卡片；控制台只更新草稿字段。两种路径都不调用对话、录音或发送接口。
- Harmony 仅在内存中替换 AIChat 1.10.0 的一个主输入框调用和一个回车检查。原生窗口打开时暂停控制台快捷键；其他时候只允许主输入框有焦点、没有候选合成且不处于候选结束的下一帧时按回车发送。未知方法布局会拒绝启用，不改原 DLL。
- 使用 ChillPatcher 的私有焦点字段，未来版本可能需要更新适配。编辑窗口启动失败时原草稿保持不变。

测试包括中文/混合文字/换行/边界/非法 UTF-8、原生窗口属性、目标 IL 布局和回车保护策略。测试不使用真实账号、不发送模型请求。

2026-10-17：Windows 实机通过用户手动拼音输入及回填确认；Wallpaper Engine 内通过临时合成 TextField 验证原生编辑器到 UIToolkit 回填，收到一次 ChangeEvent，正文包含中文。该运行测试使用临时输入框，没有读取或覆盖用户卡片草稿；测试组件随后移除。41 组回车策略离线测试通过。尚未自动验证所有显示缩放和输入法组合。

本补丁自有代码采用仓库根目录 MIT 许可证。适配对象：[AIChat](https://github.com/qzrs777/AIChat)（MIT，Copyright 2025 Elysia777）及 [ChillPatcher](https://github.com/BeyondtheApex/ChillPatcher)。本目录不包含它们的二进制或源码副本。
