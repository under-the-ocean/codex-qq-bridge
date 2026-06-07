# Codex QQ Bridge

Codex QQ Bridge is the main bridge runtime for forwarding Codex desktop events to an AstrBot/QQ bot and sending quick replies back into the active Codex conversation.

> This program depends on Codex++ or an equivalent Codex desktop launch method that exposes the Chromium DevTools Protocol endpoint. By default the relay connects to `http://127.0.0.1:9229`; without an open DevTools endpoint, the bridge cannot inject into the Codex page.

## What Is Included

- `codex-qq-bridge.js`: page-side bridge injected into Codex.
- `codex_qq_bridge_cdp_relay.py`: CDP relay that injects the bridge and relays events/commands to AstrBot.
- `main.ico`: Windows executable icon used by release builds.
- `.github/workflows/build.yml`: GitHub Actions workflow that builds multi-platform single-file release artifacts.

The AstrBot plugin is intentionally kept in a separate repository:

`https://github.com/under-the-ocean/astrbot-plugin-codex-bridge`

## Requirements

- Codex++ configured to expose DevTools, usually on `127.0.0.1:9229`.
- Python 3.11+ for source execution.
- AstrBot plugin running and listening on `ws://192.168.10.11:32124/ws/codex` by default.

You can override endpoints with environment variables:

```powershell
$env:CODEX_CDP_HTTP = "http://127.0.0.1:9229"
$env:CODEX_ASTRBOT_WS = "ws://192.168.10.11:32124/ws/codex"
```

## Run From Source

```powershell
pip install -r requirements.txt
python .\codex_qq_bridge_cdp_relay.py
```

## Build Single File

GitHub Actions builds multi-platform onefile artifacts with PyInstaller and embeds `codex-qq-bridge.js` into each bundle. Windows builds also use `main.ico` as the executable icon.

To build locally:

```powershell
pip install pyinstaller -r requirements.txt
pyinstaller --onefile --name codex-qq-bridge-cdp-relay --icon main.ico --add-data "codex-qq-bridge.js;." codex_qq_bridge_cdp_relay.py
```

The executable will be generated under `dist/`.
