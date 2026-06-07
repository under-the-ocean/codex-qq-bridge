#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const SCRIPT_ID = "codex-qq-bridge-cdp-relay";
const SCRIPT_VERSION = "0.1.0";
const ROOT = __dirname;
const BRIDGE_SCRIPT = process.env.CODEX_BRIDGE_SCRIPT || path.join(ROOT, "codex-qq-bridge.js");
const CDP_HTTP = process.env.CODEX_CDP_HTTP || "http://127.0.0.1:9229";
const ASTRBOT_WS = process.env.CODEX_ASTRBOT_WS || "ws://192.168.10.11:32124/ws/codex";
const POLL_MS = Number(process.env.CODEX_RELAY_POLL_MS || 500);
const HEARTBEAT_MS = Number(process.env.CODEX_RELAY_HEARTBEAT_MS || 5000);
const RECONNECT_MS = Number(process.env.CODEX_RELAY_RECONNECT_MS || 2000);
const LOG_FILE = process.env.CODEX_RELAY_LOG || path.join(ROOT, "codex-qq-bridge-cdp-relay.log");

const state = {
  id: SCRIPT_ID,
  version: SCRIPT_VERSION,
  startedAt: new Date().toISOString(),
  cdpHttp: CDP_HTTP,
  astrbotWs: ASTRBOT_WS,
  target: null,
  cdpOnline: false,
  astrbotOnline: false,
  lastError: "",
  lastCdpAt: "",
  lastAstrbotAt: "",
  commandSeq: 0,
  sentCount: 0,
  receivedCount: 0,
};

let cdpSocket = null;
let astrbotSocket = null;
let cdpMessageId = 0;
let pollTimer = null;
let heartbeatTimer = null;
const cdpPending = new Map();
const astrbotQueue = [];

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  const line = `[${nowIso()}] ${args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (_) {
    // Console logging is still useful if file logging fails.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteExpressionSource(source) {
  return `(0, eval)(${JSON.stringify(source)})`;
}

async function findCodexTarget() {
  const targets = await fetch(`${CDP_HTTP}/json/list`).then((response) => response.json());
  const page =
    targets.find((item) => item.type === "page" && item.url === "app://-/index.html") ||
    targets.find((item) => item.type === "page" && /Codex/i.test(item.title || "")) ||
    targets.find((item) => item.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("Codex CDP page target not found");
  return page;
}

function cdpSend(method, params = {}) {
  if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
    throw new Error("CDP is not connected");
  }
  const id = ++cdpMessageId;
  cdpSocket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdpPending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 5000);
    cdpPending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
        return;
      }
      resolve(message.result);
    });
  });
}

async function cdpEval(expression, options = {}) {
  const result = await cdpSend("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...options,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "CDP evaluation failed");
  }
  return result?.result?.value;
}

async function connectCdp() {
  const target = await findCodexTarget();
  state.target = {
    id: target.id,
    title: target.title,
    url: target.url,
  };

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    cdpSocket = ws;
    const timer = setTimeout(() => reject(new Error("CDP websocket timeout")), 5000);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      state.cdpOnline = true;
      state.lastCdpAt = nowIso();
      resolve();
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data || "{}"));
      const waiter = cdpPending.get(message.id);
      if (waiter) {
        cdpPending.delete(message.id);
        waiter(message);
      }
    });

    ws.addEventListener("close", () => {
      state.cdpOnline = false;
      cdpSocket = null;
      clearInterval(pollTimer);
      pollTimer = null;
      log("CDP disconnected");
      setTimeout(run, RECONNECT_MS);
    });

    ws.addEventListener("error", () => {
      state.cdpOnline = false;
      state.lastError = "CDP websocket error";
    });
  });

  await cdpSend("Runtime.enable");
  await injectBridgeScript();
  log("CDP connected", JSON.stringify(state.target));
}

async function injectBridgeScript() {
  const bridgeVersion = await cdpEval("window.__codexQqBridgeVersion || ''");
  const bridgeSource = fs.readFileSync(BRIDGE_SCRIPT, "utf8");
  await cdpEval(quoteExpressionSource(bridgeSource));
  const nextVersion = await cdpEval("window.__codexQqBridgeVersion || ''");
  log(`bridge injected ${bridgeVersion || "-"} -> ${nextVersion || "-"}`);
}

function sendAstrbot(message) {
  if (!message) return false;
  if (!astrbotSocket || astrbotSocket.readyState !== WebSocket.OPEN) {
    astrbotQueue.push(message);
    if (astrbotQueue.length > 500) astrbotQueue.splice(0, astrbotQueue.length - 500);
    return false;
  }
  astrbotSocket.send(JSON.stringify(message));
  state.sentCount += 1;
  state.lastAstrbotAt = nowIso();
  return true;
}

function flushAstrbotQueue() {
  const queued = astrbotQueue.splice(0, astrbotQueue.length);
  queued.forEach((message) => sendAstrbot(message));
}

function connectAstrbot() {
  if (astrbotSocket && astrbotSocket.readyState === WebSocket.OPEN) return;

  const ws = new WebSocket(ASTRBOT_WS);
  astrbotSocket = ws;

  ws.addEventListener("open", () => {
    state.astrbotOnline = true;
    state.lastError = "";
    state.lastAstrbotAt = nowIso();
    log("AstrBot connected");
    sendAstrbot({
      type: "hello",
      client: {
        sessionId: "cdp-relay",
        scriptId: SCRIPT_ID,
        version: SCRIPT_VERSION,
        relay: true,
      },
    });
    flushAstrbotQueue();
  });

  ws.addEventListener("message", async (event) => {
    state.receivedCount += 1;
    state.lastAstrbotAt = nowIso();
    try {
      const message = JSON.parse(String(event.data || "{}"));
      await pushPageMessage(message);
    } catch (error) {
      state.lastError = error?.message || String(error);
      log("AstrBot message error", state.lastError);
    }
  });

  ws.addEventListener("close", () => {
    state.astrbotOnline = false;
    log("AstrBot disconnected");
    setTimeout(connectAstrbot, RECONNECT_MS);
  });

  ws.addEventListener("error", () => {
    state.astrbotOnline = false;
    state.lastError = "AstrBot websocket error";
  });
}

async function pullPageMessages() {
  if (!state.cdpOnline) return;
  const items = await cdpEval(`(() => {
    const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
    if (!bridge?.pullBridgeMessages) return [];
    return bridge.pullBridgeMessages(100);
  })()`);
  for (const item of items || []) {
    sendAstrbot(item?.message || item);
  }
}

async function pushPageMessage(message) {
  if (!state.cdpOnline) return;
  await cdpEval(`(() => {
    const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
    if (!bridge?.pushBridgeMessage) return { ok: false, error: "bridge api not found" };
    return bridge.pushBridgeMessage(${JSON.stringify(message)});
  })()`);
}

async function sendHeartbeat() {
  if (!state.cdpOnline) return;
  const snapshot = await cdpEval(`(() => {
    const bridge = window.__codexQqBridge || window.__CODEX_QQ_BRIDGE__;
    if (!bridge?.getState) return null;
    return {
      type: "state",
      reason: "cdp-relay-heartbeat",
      client: { sessionId: "cdp-relay" },
      state: bridge.getState(),
      lastAssistant: bridge.getLastAssistantMessage?.() || null
    };
  })()`);
  if (snapshot) sendAstrbot(snapshot);
}

async function run() {
  if (state.cdpOnline) return;
  try {
    await connectCdp();
    connectAstrbot();
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    pollTimer = setInterval(() => pullPageMessages().catch((error) => {
      state.lastError = error?.message || String(error);
    }), POLL_MS);
    heartbeatTimer = setInterval(() => sendHeartbeat().catch((error) => {
      state.lastError = error?.message || String(error);
    }), HEARTBEAT_MS);
  } catch (error) {
    state.lastError = error?.message || String(error);
    log("relay error", state.lastError);
    await delay(RECONNECT_MS);
    run();
  }
}

process.on("SIGINT", () => {
  log("stopping");
  try {
    cdpSocket?.close();
    astrbotSocket?.close();
  } finally {
    process.exit(0);
  }
});

process.on("uncaughtException", (error) => {
  log("uncaughtException", error?.stack || error?.message || String(error));
});

process.on("unhandledRejection", (error) => {
  log("unhandledRejection", error?.stack || error?.message || String(error));
});

process.on("exit", (code) => {
  log("exit", String(code));
});

setInterval(() => {
  log(
    "alive",
    JSON.stringify({
      cdpOnline: state.cdpOnline,
      astrbotOnline: state.astrbotOnline,
      sentCount: state.sentCount,
      receivedCount: state.receivedCount,
      lastError: state.lastError,
    }),
  );
}, 30000);

log("starting", JSON.stringify({ CDP_HTTP, ASTRBOT_WS, BRIDGE_SCRIPT }));
run();
