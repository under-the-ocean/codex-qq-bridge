(() => {
  "use strict";

  const SCRIPT_ID = "codex-qq-bridge-injector-relay";
  const SCRIPT_VERSION = "0.1.3";
  const DEFAULT_WS_URL = "ws://192.168.10.11:32124/ws/codex";
  const PAGE_SOURCE = "codex-qq-bridge";
  const RELAY_SOURCE = "codex-qq-bridge-relay";
  const RELAY_MESSAGE_TYPE = "bridge-message";
  const RELAY_INBOUND_EVENT = "codex-qq-bridge-inbound";
  const RELAY_OUTBOUND_EVENT = "codex-qq-bridge-outbound";
  const RECONNECT_MS = 2000;
  const HEARTBEAT_MS = 5000;
  const PAGE_POLL_MS = 500;
  const DEDUPE_MS = 800;

  const config = {
    wsUrl: DEFAULT_WS_URL,
    ...(globalThis.__codexQqBridgeRelayConfig || {}),
  };

  if (globalThis.__codexQqBridgeInjectorRelayInstalled === SCRIPT_VERSION) return;
  globalThis.__codexQqBridgeInjectorRelayInstalled = SCRIPT_VERSION;

  const state = {
    id: SCRIPT_ID,
    version: SCRIPT_VERSION,
    wsUrl: String(config.wsUrl || DEFAULT_WS_URL),
    relayId: `relay-${Math.random().toString(36).slice(2, 10)}`,
    online: false,
    lastError: "",
    lastConnectedAt: "",
    lastMessageAt: "",
    lastOpenAttemptAt: "",
    lastCloseCode: 0,
    lastCloseReason: "",
    socket: null,
    reconnectTimer: 0,
    pagePollTimer: 0,
    pageApiOnline: false,
    lastPagePullAt: "",
    lastPagePushAt: "",
    queue: [],
    seen: new Map(),
  };

  function now() {
    return Date.now();
  }

  function cleanupSeen() {
    const cutoff = now() - DEDUPE_MS;
    for (const [key, timestamp] of state.seen.entries()) {
      if (timestamp < cutoff) state.seen.delete(key);
    }
  }

  function messageKey(message) {
    if (!message || typeof message !== "object") return String(message);
    if (message.type === "event") return `event:${message.event?.id || ""}:${message.event?.event || ""}`;
    if (message.type === "command") return `command:${message.command?.id || ""}:${message.command?.type || ""}`;
    if (message.type === "command-result") return `command-result:${message.commandId || ""}`;
    return `${message.type || ""}:${message.reason || ""}:${message.client?.sessionId || ""}`;
  }

  function remember(message) {
    cleanupSeen();
    const key = messageKey(message);
    if (state.seen.has(key)) return false;
    state.seen.set(key, now());
    return true;
  }

  function postToPage(message) {
    const api = getPageApi();
    if (api?.pushBridgeMessage) {
      try {
        api.pushBridgeMessage(message);
        state.pageApiOnline = true;
        state.lastPagePushAt = new Date().toISOString();
        return true;
      } catch (error) {
        state.lastError = error?.message || String(error);
      }
    }

    const envelope = {
      source: RELAY_SOURCE,
      type: RELAY_MESSAGE_TYPE,
      message,
    };
    globalThis.postMessage?.(envelope, "*");
    globalThis.dispatchEvent?.(new CustomEvent(RELAY_INBOUND_EVENT, { detail: message }));
    return true;
  }

  function getPageApi() {
    const api = globalThis.__codexQqBridge || globalThis.__CODEX_QQ_BRIDGE__;
    if (!api || typeof api !== "object") return null;
    return api;
  }

  function readCspText() {
    try {
      return String(
        globalThis.document?.querySelector?.("meta[http-equiv='Content-Security-Policy' i]")?.content || "",
      );
    } catch (_) {
      return "";
    }
  }

  function cspLikelyBlocksWs() {
    const csp = readCspText();
    if (!csp) return false;
    const connect = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^connect-src\b/i.test(part));
    if (!connect) return false;
    if (/\s(\*|ws:|wss:)\b/i.test(connect)) return false;
    try {
      const target = new URL(state.wsUrl);
      const selfOrigin = globalThis.location?.origin || "";
      const selfAllowsTarget = connect.includes("'self'") && selfOrigin && selfOrigin === target.origin;
      return !connect.includes(target.origin) && !connect.includes(target.host) && !selfAllowsTarget;
    } catch (_) {
      return true;
    }
  }

  function diagnose() {
    const api = getPageApi();
    return {
      id: SCRIPT_ID,
      version: SCRIPT_VERSION,
      wsUrl: state.wsUrl,
      online: state.online,
      lastError: state.lastError,
      lastConnectedAt: state.lastConnectedAt,
      lastMessageAt: state.lastMessageAt,
      lastOpenAttemptAt: state.lastOpenAttemptAt,
      lastCloseCode: state.lastCloseCode,
      lastCloseReason: state.lastCloseReason,
      queueLength: state.queue.length,
      pageApiOnline: state.pageApiOnline,
      pageApiDetected: !!api,
      pageApiVersion: api?.version || "",
      pageOutboxPending: api?.getState?.().injectorRelay?.outboxPending ?? null,
      webSocketAvailable: typeof WebSocket === "function",
      href: globalThis.location?.href || "",
      protocol: globalThis.location?.protocol || "",
      csp: readCspText(),
      cspLikelyBlocksWs: cspLikelyBlocksWs(),
    };
  }

  function drainPageOutbox() {
    const api = getPageApi();
    if (!api?.pullBridgeMessages) {
      state.pageApiOnline = false;
      return;
    }
    try {
      const items = api.pullBridgeMessages(50) || [];
      state.pageApiOnline = true;
      if (items.length) state.lastPagePullAt = new Date().toISOString();
      items.forEach((item) => sendToWs(item?.message || item));
    } catch (error) {
      state.pageApiOnline = false;
      state.lastError = error?.message || String(error);
    }
  }

  function sendStatus(online, error = "") {
    postToPage({
      type: online ? "relay-ready" : "relay-status",
      online,
      error,
      relay: {
        id: state.relayId,
        version: SCRIPT_VERSION,
        wsUrl: state.wsUrl,
      },
    });
  }

  function sendToWs(message) {
    if (!message || !remember(message)) return false;
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      state.queue.push(message);
      if (state.queue.length > 100) state.queue.splice(0, state.queue.length - 100);
      return false;
    }
    socket.send(JSON.stringify(message));
    state.lastMessageAt = new Date().toISOString();
    return true;
  }

  function flushQueue() {
    const queued = state.queue.splice(0, state.queue.length);
    queued.forEach((message) => {
      try {
        state.socket?.send(JSON.stringify(message));
      } catch (error) {
        state.lastError = error?.message || String(error);
      }
    });
  }

  function relayHello() {
    sendToWs({
      type: "hello",
      client: {
        sessionId: state.relayId,
        scriptId: SCRIPT_ID,
        version: SCRIPT_VERSION,
        relay: true,
        href: globalThis.location?.href || "",
        title: globalThis.document?.title || "",
      },
    });
  }

  function scheduleReconnect() {
    globalThis.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = globalThis.setTimeout(connect, RECONNECT_MS);
  }

  function connect() {
    try {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
      state.lastOpenAttemptAt = new Date().toISOString();
      const socket = new WebSocket(state.wsUrl);
      state.socket = socket;

      socket.addEventListener("open", () => {
        state.online = true;
        state.lastError = "";
        state.lastConnectedAt = new Date().toISOString();
        sendStatus(true);
        drainPageOutbox();
        relayHello();
        flushQueue();
      });

      socket.addEventListener("message", (event) => {
        state.lastMessageAt = new Date().toISOString();
        try {
          postToPage(JSON.parse(String(event.data || "{}")));
        } catch (error) {
          state.lastError = error?.message || String(error);
        }
      });

      socket.addEventListener("close", (event) => {
        state.online = false;
        state.lastCloseCode = event?.code || 0;
        state.lastCloseReason = event?.reason || "";
        sendStatus(false, `websocket closed ${state.lastCloseCode || ""}`.trim());
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        state.online = false;
        state.lastError = cspLikelyBlocksWs() ? "websocket error; CSP likely blocks wsUrl in this context" : "websocket error";
        sendStatus(false, state.lastError);
      });
    } catch (error) {
      state.online = false;
      state.lastError = error?.message || String(error);
      sendStatus(false, state.lastError);
      scheduleReconnect();
    }
  }

  globalThis.addEventListener?.("message", (event) => {
    if (event.source !== globalThis) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE || data.type !== RELAY_MESSAGE_TYPE) return;
    sendToWs(data.message);
  });

  globalThis.addEventListener?.(RELAY_OUTBOUND_EVENT, (event) => {
    sendToWs(event.detail);
  });

  globalThis.__codexQqBridgeInjectorRelay = {
    state,
    connect,
    sendToWs,
    sendToPage: postToPage,
    drainPageOutbox,
    diagnose,
  };

  connect();
  state.pagePollTimer = globalThis.setInterval(drainPageOutbox, PAGE_POLL_MS);
  globalThis.setInterval(() => {
    sendStatus(state.online, state.lastError);
    drainPageOutbox();
    if (!state.online) connect();
  }, HEARTBEAT_MS);
})();
