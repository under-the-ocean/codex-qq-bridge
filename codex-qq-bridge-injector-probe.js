(() => {
  "use strict";

  const SCRIPT_ID = "codex-qq-bridge-injector-probe";
  const SCRIPT_VERSION = "0.1.0";
  const WS_URL = String(globalThis.__codexQqBridgeProbeWsUrl || "ws://192.168.10.11:32124/ws/codex");

  const state = {
    id: SCRIPT_ID,
    version: SCRIPT_VERSION,
    wsUrl: WS_URL,
    startedAt: new Date().toISOString(),
    webSocketAvailable: typeof WebSocket === "function",
    locationHref: globalThis.location?.href || "",
    locationProtocol: globalThis.location?.protocol || "",
    csp: "",
    opened: false,
    received: [],
    lastError: "",
    lastCloseCode: 0,
    lastCloseReason: "",
  };

  function readCsp() {
    try {
      return String(globalThis.document?.querySelector?.("meta[http-equiv='Content-Security-Policy' i]")?.content || "");
    } catch (_) {
      return "";
    }
  }

  function cspLikelyBlocksWs() {
    const csp = state.csp || readCsp();
    if (!csp) return false;
    const connect = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^connect-src\b/i.test(part));
    if (!connect) return false;
    if (/\s(\*|ws:|wss:)\b/i.test(connect)) return false;
    try {
      const target = new URL(state.wsUrl);
      return !connect.includes(target.origin) && !connect.includes(target.host);
    } catch (_) {
      return true;
    }
  }

  function finish(extra = {}) {
    state.csp = readCsp();
    Object.assign(state, extra, {
      cspLikelyBlocksWs: cspLikelyBlocksWs(),
      finishedAt: new Date().toISOString(),
    });
    globalThis.__codexQqBridgeInjectorProbe = state;
    try {
      console.info("[CodexBridgeProbe]", JSON.stringify(state, null, 2));
    } catch (_) {
      // Ignore console serialization errors.
    }
    return state;
  }

  globalThis.__codexQqBridgeInjectorProbe = state;

  if (!state.webSocketAvailable) {
    finish({ lastError: "WebSocket is not available in this context" });
    return;
  }

  try {
    state.csp = readCsp();
    const ws = new WebSocket(state.wsUrl);
    const timer = globalThis.setTimeout(() => {
      state.lastError = "timeout waiting for websocket open/message";
      try {
        ws.close();
      } catch (_) {
        // Ignore close errors.
      }
      finish();
    }, 5000);

    ws.addEventListener("open", () => {
      state.opened = true;
      ws.send(
        JSON.stringify({
          type: "hello",
          client: {
            sessionId: "injector-probe",
            scriptId: SCRIPT_ID,
            version: SCRIPT_VERSION,
            href: globalThis.location?.href || "",
          },
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      state.received.push(String(event.data || ""));
      globalThis.clearTimeout(timer);
      finish();
      ws.close();
    });

    ws.addEventListener("close", (event) => {
      state.lastCloseCode = event?.code || 0;
      state.lastCloseReason = event?.reason || "";
      if (!state.received.length) finish();
    });

    ws.addEventListener("error", () => {
      state.lastError = cspLikelyBlocksWs() ? "websocket error; CSP likely blocks this wsUrl" : "websocket error";
      globalThis.clearTimeout(timer);
      finish();
    });
  } catch (error) {
    finish({ lastError: error?.message || String(error) });
  }
})();
