# Codex QQ Bridge

把 Codex 桌面端的任务完成、审核请求推送到 QQ，并支持从 QQ 快速回复、同意审核。

这个仓库是主程序，只保留两部分：

- `codex_qq_bridge_cdp_relay.py`：Python 中继，负责连接 Codex DevTools 和 AstrBot 插件。
- `codex-qq-bridge.js`：注入到 Codex 页面里的桥接脚本。

AstrBot 插件在另一个仓库：

[astrbot-plugin-codex-bridge](https://github.com/under-the-ocean/astrbot-plugin-codex-bridge)

Codex++：

[codex-plusplus](https://github.com/b-nnett/codex-plusplus)

## 它能做什么

- Codex 任务完成后，自动推送到 QQ。
- Codex 需要审核命令时，自动推送说明和命令到 QQ。
- 在 QQ 里回复 `y` 或 `a`，可以快速同意当前审核。
- 在 QQ 里直接发送文字，可以继续回复当前 Codex 对话。
- 如果提醒来自其他 Codex 对话，可以先发送 `s` 切换过去。

## 使用前准备

1. 安装并配置 [Codex++](https://github.com/b-nnett/codex-plusplus)。
2. 用 Codex++ 启动 Codex，并确保 DevTools 接口已开放。
3. 默认 DevTools 地址是：

```text
http://127.0.0.1:9229
```

如果这个接口没有开放，中继无法把脚本注入到 Codex 页面。

## 安装 AstrBot 插件

请安装这个仓库里的插件：

[https://github.com/under-the-ocean/astrbot-plugin-codex-bridge](https://github.com/under-the-ocean/astrbot-plugin-codex-bridge)

插件会在 AstrBot 侧启动 WebSocket 服务，默认地址：

```text
ws://0.0.0.0:32124/ws/codex
```

中继默认连接：

```text
ws://192.168.10.11:32124/ws/codex
```

如果你的 AstrBot 不在这个地址，请用环境变量修改。

## 下载主程序

可以在 Releases 页面下载编译好的单文件程序：

[https://github.com/under-the-ocean/codex-qq-bridge/releases](https://github.com/under-the-ocean/codex-qq-bridge/releases)

GitHub Actions 会构建多架构产物：

- Windows x64
- Windows arm64
- Linux x64
- Linux arm64
- macOS x64
- macOS arm64

Windows 版本会使用仓库里的 `main.ico` 作为程序图标。

## 运行方式

直接运行下载到的程序即可。

如果需要改地址，可以先设置环境变量：

```powershell
$env:CODEX_CDP_HTTP = "http://127.0.0.1:9229"
$env:CODEX_ASTRBOT_WS = "ws://192.168.10.11:32124/ws/codex"
.\codex-qq-bridge-cdp-relay-windows-x64.exe
```

也可以从源码运行：

```powershell
pip install -r requirements.txt
python .\codex_qq_bridge_cdp_relay.py
```

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_CDP_HTTP` | `http://127.0.0.1:9229` | Codex DevTools HTTP 地址 |
| `CODEX_ASTRBOT_WS` | `ws://192.168.10.11:32124/ws/codex` | AstrBot 插件 WebSocket 地址 |
| `CODEX_BRIDGE_SCRIPT` | 内置的 `codex-qq-bridge.js` | 自定义注入脚本路径 |
| `CODEX_RELAY_LOG` | `codex-qq-bridge-cdp-relay.log` | 日志文件路径 |

## 简单排错

如果 QQ 没有收到消息：

1. 确认 AstrBot 插件已经安装并启用。
2. 确认插件配置里填写了 QQ 推送目标。
3. 确认 Codex++ 已经开放 DevTools。
4. 打开 `http://127.0.0.1:9229/json/list`，能看到 Codex 页面才算正常。
5. 查看中继日志里是否显示 `cdp_online` 和 `astrbot_online` 都为 `true`。

如果审核消息没有命令或说明：

请先确认使用的是最新 Release，旧版本可能无法识别新版 Codex 审核界面。
