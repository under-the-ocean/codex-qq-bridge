#!/usr/bin/env python3
"""CDP-to-AstrBot relay for the injected Codex QQ bridge.

This process does not expose a local HTTP server. It only opens outgoing
WebSocket connections to the Codex DevTools endpoint and AstrBot.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.request import urlopen

import websockets
from websockets.exceptions import ConnectionClosed


SCRIPT_ID = "codex-qq-bridge-cdp-relay-py"
SCRIPT_VERSION = "0.1.0"
CDP_EVENT_BINDING = "__codexQqBridgeCdpEvent"
ROOT = Path(__file__).resolve().parent
PACKAGED_ROOT = Path(getattr(sys, "_MEIPASS", ROOT))
DEFAULT_BRIDGE_SCRIPT = PACKAGED_ROOT / "codex-qq-bridge.js"
BRIDGE_SCRIPT = Path(os.environ.get("CODEX_BRIDGE_SCRIPT", DEFAULT_BRIDGE_SCRIPT))
CDP_HTTP = os.environ.get("CODEX_CDP_HTTP", "http://127.0.0.1:9229").rstrip("/")
ASTRBOT_WS = os.environ.get("CODEX_ASTRBOT_WS", "ws://192.168.10.11:32124/ws/codex")
POLL_SECONDS = float(os.environ.get("CODEX_RELAY_POLL_SECONDS", "0.5"))
HEARTBEAT_SECONDS = float(os.environ.get("CODEX_RELAY_HEARTBEAT_SECONDS", "5"))
RECONNECT_SECONDS = float(os.environ.get("CODEX_RELAY_RECONNECT_SECONDS", "2"))
LOG_FILE = Path(os.environ.get("CODEX_RELAY_LOG", ROOT / "codex-qq-bridge-cdp-relay.log"))
DEDUP_SECONDS = float(os.environ.get("CODEX_RELAY_DEDUP_SECONDS", "120"))


class CdpRelay:
    def __init__(self) -> None:
        self.cdp_ws: websockets.WebSocketClientProtocol | None = None
        self.astrbot_ws: websockets.WebSocketClientProtocol | None = None
        self.cdp_reader_task: asyncio.Task[None] | None = None
        self.cdp_msg_id = 0
        self.cdp_pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self.astrbot_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self.astrbot_disconnect_event = asyncio.Event()
        self.sent_signatures: dict[str, float] = {}
        self.logged_signatures: dict[str, float] = {}
        self.state: dict[str, Any] = {
            "id": SCRIPT_ID,
            "version": SCRIPT_VERSION,
            "started_at": self.now_text(),
            "cdp_http": CDP_HTTP,
            "astrbot_ws": ASTRBOT_WS,
            "cdp_online": False,
            "astrbot_online": False,
            "sent_count": 0,
            "received_count": 0,
            "last_error": "",
            "last_binding_at": "",
            "last_cdp_at": "",
            "last_astrbot_at": "",
            "target": None,
        }

    @staticmethod
    def now_text() -> str:
        return datetime.now().isoformat(timespec="seconds")

    def log(self, *parts: Any) -> None:
        line = f"[{self.now_text()}] " + " ".join(str(part) for part in parts)
        try:
            if sys.stdout is not None:
                print(line, flush=True)
        except OSError:
            pass
        try:
            with LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass

    def fetch_json(self, url: str) -> Any:
        with urlopen(url, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def message_signature(self, message: dict[str, Any]) -> str:
        event = message.get("event") or {}
        detail = event.get("detail") or {}
        debug = message.get("debug") or {}
        stable = {
            "type": message.get("type"),
            "event": event.get("event"),
            "conversationId": event.get("conversationId"),
            "text": detail.get("text"),
            "status": detail.get("status"),
            "previousStatus": detail.get("previousStatus"),
            "commandId": message.get("commandId"),
            "reason": message.get("reason"),
            "debugType": debug.get("type"),
            "debugDetail": debug.get("detail"),
        }
        raw = json.dumps(stable, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def should_send_message(self, message: dict[str, Any]) -> bool:
        # State heartbeats are intentionally periodic; dedupe user-visible events/results.
        if message.get("type") in {"hello", "state"}:
            return True
        now = asyncio.get_running_loop().time()
        cutoff = now - DEDUP_SECONDS
        self.sent_signatures = {key: ts for key, ts in self.sent_signatures.items() if ts >= cutoff}
        signature = self.message_signature(message)
        if signature in self.sent_signatures:
            return False
        self.sent_signatures[signature] = now
        return True

    def should_log_message(self, message: dict[str, Any]) -> bool:
        now = asyncio.get_running_loop().time()
        cutoff = now - DEDUP_SECONDS
        self.logged_signatures = {key: ts for key, ts in self.logged_signatures.items() if ts >= cutoff}
        signature = self.message_signature(message)
        if signature in self.logged_signatures:
            return False
        self.logged_signatures[signature] = now
        return True

    def log_page_debug(self, message: dict[str, Any]) -> None:
        if not self.should_log_message(message):
            return
        debug = message.get("debug") or {}
        debug_type = str(debug.get("type") or "-")
        detail = debug.get("detail")
        try:
            detail_text = json.dumps(detail, ensure_ascii=False, sort_keys=True)
        except TypeError:
            detail_text = str(detail)
        if len(detail_text) > 1200:
            detail_text = detail_text[:1200] + "...(truncated)"
        self.log("page-debug", debug_type, detail_text)

    def log_bridge_message(self, message: dict[str, Any], source: str) -> None:
        message_type = str(message.get("type") or "-")
        if message_type == "debug":
            self.log_page_debug(message)
            return
        if not self.should_log_message(message):
            return
        event = message.get("event") or {}
        event_name = str(event.get("event") or "-")
        detail = event.get("detail") or {}
        conversation_id = str(event.get("conversationId") or detail.get("conversationId") or "")
        preview = str(detail.get("text") or detail.get("status") or detail.get("reason") or "")
        if len(preview) > 200:
            preview = preview[:200] + "...(truncated)"
        self.log("page-message", source, f"type={message_type}", f"event={event_name}", f"conversation={conversation_id}", f"preview={preview}")

    def find_codex_target(self) -> dict[str, Any]:
        targets = self.fetch_json(f"{CDP_HTTP}/json/list")
        page = next((item for item in targets if item.get("type") == "page" and item.get("url") == "app://-/index.html"), None)
        if page is None:
            page = next((item for item in targets if item.get("type") == "page" and "Codex" in str(item.get("title", ""))), None)
        if page is None:
            page = next((item for item in targets if item.get("type") == "page"), None)
        if not page or not page.get("webSocketDebuggerUrl"):
            raise RuntimeError("Codex CDP page target not found")
        return page

    async def cdp_send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.cdp_ws is None:
            raise RuntimeError("CDP is not connected")
        self.cdp_msg_id += 1
        msg_id = self.cdp_msg_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.cdp_pending[msg_id] = future
        await self.cdp_ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}, ensure_ascii=False))
        try:
            message = await asyncio.wait_for(future, timeout=5)
        finally:
            self.cdp_pending.pop(msg_id, None)
        if "error" in message:
            raise RuntimeError(message["error"].get("message") or json.dumps(message["error"], ensure_ascii=False))
        return message.get("result") or {}

    async def cdp_eval(self, expression: str) -> Any:
        result = await self.cdp_send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"].get("text") or "CDP evaluation failed")
        return (result.get("result") or {}).get("value")

    async def cdp_reader(self) -> None:
        assert self.cdp_ws is not None
        async for raw in self.cdp_ws:
            message = json.loads(raw)
            if message.get("method") == "Runtime.bindingCalled":
                await self.handle_cdp_binding(message.get("params") or {})
                continue
            msg_id = message.get("id")
            future = self.cdp_pending.get(msg_id)
            if future and not future.done():
                future.set_result(message)

    async def handle_cdp_binding(self, params: dict[str, Any]) -> None:
        if params.get("name") != CDP_EVENT_BINDING:
            return
        raw_payload = str(params.get("payload") or "")
        if not raw_payload:
            return
        try:
            message = json.loads(raw_payload)
            self.state["last_binding_at"] = self.now_text()
            if message.get("type") == "debug":
                self.log_page_debug(message)
                return
            await self.send_astrbot(message)
        except ConnectionClosed as exc:
            self.mark_astrbot_disconnected(f"AstrBot websocket closed: {exc}")
        except Exception as exc:
            if "received 1000" in str(exc) or "sent 1000" in str(exc):
                self.mark_astrbot_disconnected(f"AstrBot websocket closed: {exc}")
                return
            self.state["last_error"] = str(exc)
            self.log("binding error", str(exc))

    async def connect_cdp(self) -> None:
        target = self.find_codex_target()
        self.state["target"] = {
            "id": target.get("id"),
            "title": target.get("title"),
            "url": target.get("url"),
        }
        self.cdp_ws = await websockets.connect(target["webSocketDebuggerUrl"], ping_interval=20, open_timeout=5)
        self.state["cdp_online"] = True
        self.state["last_cdp_at"] = self.now_text()
        self.cdp_reader_task = asyncio.create_task(self.cdp_reader(), name="cdp-reader")
        await self.cdp_send("Runtime.enable")
        await self.inject_bridge()
        self.log("CDP connected", json.dumps(self.state["target"], ensure_ascii=False))

    async def inject_bridge(self) -> None:
        previous = await self.cdp_eval("window.__codexQqBridgeVersion || ''")
        try:
            await self.cdp_send("Runtime.addBinding", {"name": CDP_EVENT_BINDING})
        except Exception as exc:
            self.log("binding setup warning", str(exc))
        binding_type_before = await self.cdp_eval(f"typeof window[{json.dumps(CDP_EVENT_BINDING)}]")
        source = BRIDGE_SCRIPT.read_text(encoding="utf-8")
        expression = f"(0, eval)({json.dumps(source, ensure_ascii=False)})"
        await self.cdp_eval(expression)
        current = await self.cdp_eval("window.__codexQqBridgeVersion || ''")
        binding_type_after = await self.cdp_eval(f"typeof window[{json.dumps(CDP_EVENT_BINDING)}]")
        self.log(
            f"bridge injected {previous or '-'} -> {current or '-'}",
            json.dumps(
                {
                    "binding_before": binding_type_before,
                    "binding_after": binding_type_after,
                    "script": str(BRIDGE_SCRIPT),
                },
                ensure_ascii=False,
            ),
        )

    async def connect_astrbot(self) -> None:
        self.astrbot_ws = await websockets.connect(ASTRBOT_WS, ping_interval=20, open_timeout=5)
        self.astrbot_disconnect_event.clear()
        self.state["astrbot_online"] = True
        self.state["last_astrbot_at"] = self.now_text()
        self.state["last_error"] = ""
        self.log("AstrBot connected")
        await self.send_astrbot(
            {
                "type": "hello",
                "client": {
                    "sessionId": "cdp-relay-py",
                    "scriptId": SCRIPT_ID,
                    "version": SCRIPT_VERSION,
                    "relay": True,
                },
            }
        )

    def mark_astrbot_disconnected(self, reason: str) -> None:
        self.state["astrbot_online"] = False
        self.state["last_error"] = reason
        self.astrbot_ws = None
        self.astrbot_disconnect_event.set()

    async def send_astrbot(self, message: dict[str, Any]) -> bool:
        if self.astrbot_ws is None:
            await self.queue_astrbot(message)
            return False
        if not self.should_send_message(message):
            return False
        try:
            await self.astrbot_ws.send(json.dumps(message, ensure_ascii=False))
            self.state["sent_count"] += 1
            self.state["last_astrbot_at"] = self.now_text()
            return True
        except ConnectionClosed as exc:
            self.sent_signatures.pop(self.message_signature(message), None)
            await self.queue_astrbot(message)
            self.mark_astrbot_disconnected(f"AstrBot websocket closed: {exc}")
            raise
        except Exception:
            self.sent_signatures.pop(self.message_signature(message), None)
            await self.queue_astrbot(message)
            raise

    async def queue_astrbot(self, message: dict[str, Any]) -> None:
        if self.astrbot_queue.full():
            _ = self.astrbot_queue.get_nowait()
        await self.astrbot_queue.put(message)

    async def flush_astrbot_queue(self) -> None:
        while True:
            message = await self.astrbot_queue.get()
            if self.astrbot_ws is None:
                await self.queue_astrbot(message)
                raise RuntimeError("AstrBot websocket is not connected")
            await self.send_astrbot(message)

    async def astrbot_reader(self) -> None:
        assert self.astrbot_ws is not None
        try:
            async for raw in self.astrbot_ws:
                self.state["received_count"] += 1
                self.state["last_astrbot_at"] = self.now_text()
                message = json.loads(raw)
                await self.push_page_message(message)
        except ConnectionClosed as exc:
            self.mark_astrbot_disconnected(f"AstrBot websocket closed: {exc}")
            raise RuntimeError("AstrBot websocket closed") from exc
        self.mark_astrbot_disconnected("AstrBot websocket closed")
        raise RuntimeError("AstrBot websocket closed")

    async def pull_page_messages(self) -> None:
        items = await self.cdp_eval(
            """(() => {
              const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
              if (!bridge?.pullBridgeMessages) return [];
              return bridge.pullBridgeMessages(100);
            })()"""
        )
        for item in items or []:
            message = item.get("message") or item
            self.log_bridge_message(message, "poll")
            if message.get("type") == "debug":
                continue
            await self.send_astrbot(message)

    async def push_page_message(self, message: dict[str, Any]) -> None:
        await self.cdp_eval(
            f"""(() => {{
              const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
              if (!bridge?.pushBridgeMessage) return {{ ok: false, error: "bridge api not found" }};
              return bridge.pushBridgeMessage({json.dumps(message, ensure_ascii=False)});
            }})()"""
        )

    async def send_heartbeat(self) -> None:
        snapshot = await self.cdp_eval(
            """(() => {
              const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
              if (!bridge?.getState) return null;
              return {
                type: "state",
                reason: "cdp-relay-py-heartbeat",
                client: { sessionId: "cdp-relay-py" },
                state: bridge.getState(),
                lastAssistant: bridge.getLastAssistantMessage?.() || null
              };
            })()"""
        )
        if snapshot:
            await self.send_astrbot(snapshot)

    async def poll_loop(self) -> None:
        while True:
            try:
                await self.pull_page_messages()
            except Exception as exc:
                if isinstance(exc, ConnectionClosed):
                    raise
                self.state["last_error"] = str(exc)
            await asyncio.sleep(POLL_SECONDS)

    async def heartbeat_loop(self) -> None:
        while True:
            try:
                await self.send_heartbeat()
                self.log(
                    "alive",
                    json.dumps(
                        {
                            "cdp_online": self.state["cdp_online"],
                            "astrbot_online": self.state["astrbot_online"],
                            "sent_count": self.state["sent_count"],
                            "received_count": self.state["received_count"],
                            "last_error": self.state["last_error"],
                        },
                        ensure_ascii=False,
                    ),
                )
            except Exception as exc:
                if isinstance(exc, ConnectionClosed):
                    raise
                self.state["last_error"] = str(exc)
            await asyncio.sleep(HEARTBEAT_SECONDS)

    async def astrbot_disconnect_watch(self) -> None:
        await self.astrbot_disconnect_event.wait()
        raise RuntimeError(self.state.get("last_error") or "AstrBot websocket disconnected")

    async def run_once(self) -> None:
        await self.connect_cdp()
        await self.connect_astrbot()
        tasks = [
            self.cdp_reader_task,
            asyncio.create_task(self.astrbot_reader(), name="astrbot-reader"),
            asyncio.create_task(self.flush_astrbot_queue(), name="astrbot-flush"),
            asyncio.create_task(self.astrbot_disconnect_watch(), name="astrbot-disconnect-watch"),
            asyncio.create_task(self.poll_loop(), name="page-poll"),
            asyncio.create_task(self.heartbeat_loop(), name="heartbeat"),
        ]
        tasks = [task for task in tasks if task is not None]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                exc = task.exception()
                if exc is not None:
                    raise exc
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run_forever(self) -> None:
        self.log(
            "starting",
            json.dumps(
                {
                    "cdp_http": CDP_HTTP,
                    "astrbot_ws": ASTRBOT_WS,
                    "bridge_script": str(BRIDGE_SCRIPT),
                },
                ensure_ascii=False,
            ),
        )
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.state["cdp_online"] = False
                self.state["astrbot_online"] = False
                self.state["last_error"] = str(exc)
                self.log("relay error", str(exc))
                await self.close()
                await asyncio.sleep(RECONNECT_SECONDS)

    async def close(self) -> None:
        if self.cdp_reader_task is not None and not self.cdp_reader_task.done():
            self.cdp_reader_task.cancel()
            await asyncio.gather(self.cdp_reader_task, return_exceptions=True)
        self.cdp_reader_task = None
        for ws in (self.cdp_ws, self.astrbot_ws):
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass
        self.cdp_ws = None
        self.astrbot_ws = None


async def main() -> None:
    relay = CdpRelay()
    try:
        await relay.run_forever()
    finally:
        await relay.close()


if __name__ == "__main__":
    if not BRIDGE_SCRIPT.exists():
        print(f"Bridge script not found: {BRIDGE_SCRIPT}", file=sys.stderr)
        raise SystemExit(1)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
