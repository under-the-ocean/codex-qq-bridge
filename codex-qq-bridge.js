(() => {
  "use strict";

  const SCRIPT_ID = "codex-qq-bridge";
  const SCRIPT_VERSION = "0.2.17";
  const API_NAME = "__codexQqBridge";
  const DEBUG_NAME = "__codexQqBridgeDebug";
  const CDP_EVENT_BINDING = "__codexQqBridgeCdpEvent";
  const VIRTUAL_HTTP_ORIGIN = "http://codex-bridge.local";
  const REMOTE_BRIDGE_WS_URL = String(window.__codexQqBridgeConfig?.wsUrl || "ws://192.168.10.11:32124/ws/codex");
  const RELAY_PAGE_SOURCE = "codex-qq-bridge";
  const RELAY_SOURCE = "codex-qq-bridge-relay";
  const RELAY_MESSAGE_TYPE = "bridge-message";
  const RELAY_INBOUND_EVENT = "codex-qq-bridge-inbound";
  const RELAY_OUTBOUND_EVENT = "codex-qq-bridge-outbound";
  const ROUTE_SYNC_DELAY_MS = 80;
  const COMPOSER_ACTION_POLL_MS = 100;
  const SIDEBAR_STATUS_POLL_MS = 1000;
  const TASK_COMPLETE_STABLE_MS = 1200;
  const SEND_VERIFY_TIMEOUT_MS = 2500;
  const DEBUG_LIMIT = 200;
  const MESSAGE_LIMIT = 100;
  const BRIDGE_HEARTBEAT_MS = 5000;
  const CONVERSATION_SWITCH_TIMEOUT_MS = 4000;
  const CONVERSATION_SWITCH_SETTLE_MS = 300;

  if (window.__codexQqBridgeScriptInstalled && window.__codexQqBridgeVersion === SCRIPT_VERSION) return;
  window.__codexQqBridgeScriptInstalled = true;
  window.__codexQqBridgeVersion = SCRIPT_VERSION;

  const LABELS = {
    send: /^(send|submit|run|continue|发送|提交|运行|继续)$/i,
    stop: /^(stop|cancel|interrupt|停止|取消|中断)$/i,
    copyMessage: /^(copy message|copy|复制消息|复制)$/i,
    branch: /^(branch from here|从此处开始分叉)$/i,
    reviewButton: /^(approve|allow|confirm|authorize|授权|批准|允许|同意|是)$/i,
    reviewRequestButton: /^(request approval|请求批准)$/i,
    reviewSubmitButton: /^(submit|提交)(?:\s*⏎)?$/i,
    reviewText: /(needs your approval|requires approval|approval required|需要批准|请求授权|需要授权|等待批准)/i,
    runningText: /(\bthinking\b|\bgenerating\b|正在思考|生成中)/i,
    processingMarker: /^(已处理|processed)\s*(?:\d+\s*(?:s|秒|分|分钟|m|min|mins|minute|minutes)\s*)+$/i,
  };

  const state = {
    installedAt: new Date().toISOString(),
    activeConversationId: "",
    activeConversationName: "",
    activeProjectId: "",
    lastAssistantText: "",
    lastAssistantHtml: "",
    lastAssistantAt: 0,
    lastUserDraft: "",
    lastStatus: "idle",
    lastTaskCompletionAt: 0,
    taskCompletionTimer: 0,
    taskCompletionSeq: 0,
    lastReviewAt: 0,
    messages: [],
    debug: [],
    sidebarConversationStatuses: {},
    sidebarStatusPollTimer: 0,
    seq: 0,
    listeners: new Map(),
    hookStatus: {
      fetch: false,
      xhr: false,
      websocket: false,
      dom: false,
      route: false,
      submit: false,
      remoteBridge: false,
      injectorRelay: false,
      composerAction: false,
      sidebar: false,
    },
    composerAction: {
      fingerprint: "",
      lastChangedAt: "",
      pollTimer: 0,
    },
    network: {
      pending: 0,
      seq: 0,
      lastStartedAt: "",
      lastFinishedAt: "",
      lastUrl: "",
    },
    remoteBridge: {
      wsUrl: REMOTE_BRIDGE_WS_URL,
      sessionId: `codex-${Math.random().toString(36).slice(2, 10)}`,
      online: false,
      lastHeartbeatAt: "",
      lastError: "",
      heartbeatTimer: 0,
      lastCommandId: 0,
      socket: null,
      reconnectTimer: 0,
    },
    injectorRelay: {
      online: false,
      lastHeartbeatAt: "",
      lastError: "",
      lastCommandId: 0,
      lastSeenAt: 0,
      outbox: [],
      outboxSeq: 0,
    },
    capture: {
      active: false,
      previousConversationId: "",
      previousConversationName: "",
    },
  };

  const pendingConversationCaptures = new Set();

  function now() {
    return Date.now();
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input?.url) return String(input.url);
    return String(input || "");
  }

  function isCodexApiUrl(url) {
    const text = String(url || "");
    return /\/(responses|chat\/completions|conversation|thread|api)\b/i.test(text) || /codex/i.test(text);
  }

  function visibleRect(node) {
    if (!(node instanceof Element)) return null;
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return rect;
  }

  function isInViewport(node) {
    const rect = visibleRect(node);
    if (!rect) return false;
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function isVisible(node) {
    const rect = visibleRect(node);
    if (!rect) return false;
    const style = window.getComputedStyle?.(node);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && isInViewport(node);
  }

  function isRendered(node) {
    const rect = visibleRect(node);
    if (!rect) return false;
    const style = window.getComputedStyle?.(node);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden" && isInViewport(node);
  }

  function pushDebug(type, detail) {
    const entry = {
      at: new Date().toISOString(),
      type,
      detail,
    };
    state.debug.push(entry);
    if (state.debug.length > DEBUG_LIMIT) state.debug.splice(0, state.debug.length - DEBUG_LIMIT);
    window[DEBUG_NAME] = state.debug.slice();
    if (window[API_NAME]) window[API_NAME].debug = state.debug.slice();
    queueInjectorOutbox({
      type: "debug",
      client: {
        sessionId: state.remoteBridge.sessionId,
      },
      debug: entry,
    });
    sendCdpBindingMessage({
      type: "debug",
      client: {
        sessionId: state.remoteBridge.sessionId,
      },
      debug: entry,
    });
  }

  function normalizeConversationId(value) {
    const text = String(value || "").trim();
    if (!text || text === "__proto__" || text === "prototype" || text === "constructor") return "";
    return /^[A-Za-z0-9_.:-]{3,180}$/.test(text) ? text : "";
  }

  function normalizeProjectId(value) {
    return normalizeConversationId(value);
  }

  function conversationIdFromLocation() {
    const locationText = `${window.location?.pathname || ""}${window.location?.search || ""}${window.location?.hash || ""}`;
    const match =
      locationText.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.:-]+)/i) ||
      locationText.match(/\/([0-9a-fA-F-]{36})(?:[/?#]|$)/i) ||
      locationText.match(/\/([A-Za-z0-9_-]{12,})(?:[/?#]|$)/);
    return normalizeConversationId(match?.[1]);
  }

  function conversationIdFromActiveRow() {
    try {
      const row = document.querySelector(
        "[data-app-action-sidebar-thread-active='true'],[aria-current='page'],[aria-current='true']",
      );
      const id =
        row?.getAttribute?.("data-app-action-sidebar-thread-id") ||
        row?.getAttribute?.("data-session-id") ||
        row?.getAttribute?.("data-testid");
      return normalizeConversationId(id);
    } catch (_) {
      return "";
    }
  }

  function cleanConversationTitle(value, fallback = "") {
    let text = normalizeText(value)
      .split("\n")
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .filter((line) => !/^(等待批准|已完成待查看|运行中)$/.test(line))
      .filter((line) => !/^\d+\s*(?:秒|分|分钟|小时|天|周|月|年)$/.test(line))
      .join(" ")
      .replace(/\s*…+\s*$/g, "")
      .replace(/\s+(?:等待批准|已完成待查看|运行中)\s*/g, " ")
      .replace(/\s+(?:刚刚|昨天|今天|前天|\d+\s*(?:秒|分钟|小时|天|周|月|年))\s*$/g, "")
      .replace(/\s*…+\s*$/g, "")
      .trim();
    return text || normalizeText(fallback);
  }

  function sidebarThreadRows() {
    try {
      return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]")).filter(
        (node) => node instanceof Element && isVisible(node),
      );
    } catch (_) {
      return [];
    }
  }

  function sidebarFolderRows() {
    try {
      return Array.from(document.querySelectorAll("[role='button'],button"))
        .filter((node) => node instanceof Element && isVisible(node))
        .filter((node) => {
          const className = normalizeText(node.getAttribute?.("class") || "");
          const label = normalizeText(node.getAttribute?.("aria-label") || node.innerText || node.textContent || "");
          return className.includes("folder-row") && label;
        });
    } catch (_) {
      return [];
    }
  }

  function folderNameForThreadRow(row) {
    if (!(row instanceof Element)) return "";
    const rowRect = row.getBoundingClientRect();
    const folders = sidebarFolderRows()
      .map((folder) => ({
        folder,
        rect: folder.getBoundingClientRect(),
        name: cleanConversationTitle(folder.getAttribute?.("aria-label") || folder.innerText || folder.textContent || ""),
      }))
      .filter((item) => item.name && item.rect.top < rowRect.top && Math.abs(item.rect.left - rowRect.left) < 80)
      .sort((a, b) => b.rect.top - a.rect.top);
    return folders[0]?.name || "";
  }

  function sidebarConversationStatus(row) {
    if (!(row instanceof Element)) return { status: "idle", label: "" };
    const text = normalizeText(
      [
        row.getAttribute?.("aria-label"),
        row.getAttribute?.("title"),
        row.innerText,
        row.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
    const rowRect = row.getBoundingClientRect();
    const nodes = Array.from(row.querySelectorAll("*")).filter((node) => node instanceof Element && isRendered(node));
    const nodeText = (node) =>
      normalizeText(
        [
          node.getAttribute?.("aria-label"),
          node.getAttribute?.("title"),
          node.getAttribute?.("data-state"),
          node.getAttribute?.("data-codex-status"),
          node.innerText,
          node.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      );
    const hasApprovalBadge = nodes.some((node) => {
      const label = nodeText(node);
      const className = normalizeText(node.getAttribute?.("class") || "");
      return /等待批准|需要批准|需要审核|请求授权|approval|required|review/i.test(label) && /rounded-full|charts|green|yellow|red|badge|pill|status/i.test(className);
    });
    if (hasApprovalBadge || /等待批准|需要批准|需要审核|请求授权|approval required|requires approval/i.test(text)) {
      return { status: "review_required", label: "等待批准", reason: "approval-badge" };
    }

    const hasSpinner = nodes.some((node) => /animate-spin/.test(node.getAttribute?.("class") || ""));
    if (hasSpinner) return { status: "running", label: "运行中", reason: "spinner" };

    if (/已完成待查看|完成待查看|待查看|unread completion|completion unread|ready to view/i.test(text)) {
      return { status: "task_complete_unread", label: "已完成待查看", reason: "completion-text" };
    }

    const hasUnreadDot = nodes.some((node) => {
      const rect = node.getBoundingClientRect();
      const className = normalizeText(node.getAttribute?.("class") || "");
      const label = nodeText(node);
      if (/置顶|归档|更多操作|pin|archive|more/i.test(label)) return false;
      return (
        rect.width > 0 &&
        rect.width <= 12 &&
        rect.height > 0 &&
        rect.height <= 12 &&
        rect.left - rowRect.left > rowRect.width * 0.6 &&
        /rounded-full|status|dot|absolute inset-0/i.test(className)
      );
    });
    if (hasUnreadDot) return { status: "task_complete_unread", label: "已完成待查看", reason: "unread-dot" };

    return { status: "idle", label: "", reason: "" };
  }

  function conversationItemFromRow(row, index) {
    const id = normalizeConversationId(row?.getAttribute?.("data-app-action-sidebar-thread-id"));
    const titleNode = Array.from(row?.querySelectorAll?.("span") || []).find((node) => {
      const className = normalizeText(node?.getAttribute?.("class") || "");
      return node instanceof Element && /truncate/.test(className) && /select-none/.test(className) && normalizeText(node.innerText || node.textContent || "");
    });
    const rawTitle =
      row?.getAttribute?.("aria-label") ||
      row?.getAttribute?.("title") ||
      titleNode?.innerText ||
      titleNode?.textContent ||
      row?.innerText ||
      row?.textContent ||
      "";
    const title = cleanConversationTitle(rawTitle, id || `对话 ${index + 1}`);
    const folderName = folderNameForThreadRow(row);
    const sidebarStatus = sidebarConversationStatus(row);
    const active =
      row?.getAttribute?.("data-app-action-sidebar-thread-active") === "true" ||
      row?.getAttribute?.("aria-current") === "page" ||
      row?.getAttribute?.("aria-current") === "true";
    return {
      index: index + 1,
      id,
      name: title,
      title,
      folderName,
      displayName: folderName ? `${folderName} / ${title}` : title,
      status: sidebarStatus.status,
      statusLabel: sidebarStatus.label,
      statusReason: sidebarStatus.reason,
      active,
    };
  }

  function getConversations() {
    return sidebarThreadRows()
      .map(conversationItemFromRow)
      .filter((item) => item.id || item.name);
  }

  function conversationNameFromActiveRow() {
    const active = getConversations().find((item) => item.active);
    return active?.displayName || active?.name || "";
  }

  function projectIdFromLocation() {
    const locationText = `${window.location?.pathname || ""}${window.location?.search || ""}${window.location?.hash || ""}`;
    const match = locationText.match(/(?:project|workspace)(?:\/|=|:|-)([A-Za-z0-9_.:-]+)/i);
    return normalizeProjectId(match?.[1]);
  }

  function projectIdFromActiveRow() {
    try {
      const row = document.querySelector("[data-app-action-sidebar-project-active='true'],[data-project-id],[data-workspace-id]");
      const id =
        row?.getAttribute?.("data-project-id") ||
        row?.getAttribute?.("data-workspace-id") ||
        row?.getAttribute?.("data-testid");
      return normalizeProjectId(id);
    } catch (_) {
      return "";
    }
  }

  function currentConversationId() {
    return conversationIdFromActiveRow() || conversationIdFromLocation() || state.activeConversationId;
  }

  function currentConversationName() {
    return conversationNameFromActiveRow() || state.activeConversationName || currentConversationId();
  }

  function currentProjectId() {
    return projectIdFromActiveRow() || projectIdFromLocation() || state.activeProjectId;
  }

  function updateRouteState() {
    state.activeConversationId = currentConversationId();
    state.activeConversationName = currentConversationName();
    state.activeProjectId = currentProjectId();
  }

  function queryVisibleElements(selectors) {
    const nodes = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((node) => {
          if (node instanceof Element && isVisible(node)) nodes.push(node);
        });
      } catch (_) {
        // Ignore unsupported selector shape.
      }
    });
    return nodes;
  }

  function elementLabel(node) {
    return normalizeText(
      node?.getAttribute?.("aria-label") ||
        node?.getAttribute?.("data-testid") ||
        node?.getAttribute?.("title") ||
        node?.textContent ||
        "",
    );
  }

  function focusElement(node) {
    try {
      node?.focus?.();
    } catch (_) {
      // Ignore focus errors.
    }
  }

  function findComposerElement() {
    const explicit = queryVisibleElements([
      "main .ProseMirror[contenteditable='true']",
      ".ProseMirror[contenteditable='true']",
      "main .ProseMirror",
      ".ProseMirror",
    ]);
    if (explicit.length) return explicit[explicit.length - 1];

    const candidates = queryVisibleElements([
      "main textarea",
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
      "main input[type='text']",
      "input[type='text']",
    ]);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const node = candidates[index];
      const text = normalizeText(node.textContent || "");
      const placeholder = normalizeText(node.getAttribute?.("placeholder") || "");
      if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") return node;
      if (node.isContentEditable && (text || placeholder || node.closest("main"))) return node;
    }
    return null;
  }

  function findComposerContainer() {
    const composer = findComposerElement();
    return (
      composer?.closest?.(".relative.flex.flex-col.bg-token-input-background\\/90") ||
      composer?.closest?.(".relative.flex.w-full.flex-col.gap-2") ||
      composer?.closest?.("[class*='bg-token-input-background']") ||
      composer?.parentElement ||
      null
    );
  }

  function isInsideComposer(node) {
    const container = findComposerContainer();
    return !!(container && node instanceof Element && (node === container || container.contains(node)));
  }

  function isTimelineMarker(node) {
    return !!node?.closest?.(".codex-conversation-timeline-marker,[class*='timeline-marker']");
  }

  function isConversationResultAction(node) {
    if (!(node instanceof Element)) return false;
    let current = node;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      const text = normalizeText(current.innerText || current.textContent || "");
      const className = normalizeText(current.getAttribute?.("class") || "");
      if (/已编辑|edited|撤销|undo/i.test(text)) return true;
      if (/command|output|tool|diff|patch|summary/i.test(className) && /审核|review/i.test(text)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function isCurrentReviewCandidate(node) {
    if (!(node instanceof Element) || !isVisible(node)) return false;
    if (isInsideComposer(node) || isTimelineMarker(node)) return false;
    if (isConversationResultAction(node)) return false;
    const label = elementLabel(node);
    return LABELS.reviewButton.test(label) || LABELS.reviewText.test(label);
  }

  function getComposerText() {
    const composer = findComposerElement();
    if (!composer) return "";
    if ("value" in composer) return String(composer.value || "");
    return normalizeText(composer.textContent || "");
  }

  function setNativeValue(element, value) {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditableValue(element, value) {
    focusElement(element);
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
  }

  function setComposerText(text) {
    const composer = findComposerElement();
    if (!composer) throw new Error("Composer not found");
    const nextText = String(text ?? "");
    focusElement(composer);
    if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
      setNativeValue(composer, nextText);
    } else if (composer.isContentEditable || composer.classList.contains("ProseMirror")) {
      setContentEditableValue(composer, nextText);
    } else {
      throw new Error("Unsupported composer element");
    }
    state.lastUserDraft = nextText;
    emit("draft-updated", { text: nextText });
    return { ok: true, text: nextText };
  }

  function matchesButtonLabel(node, pattern) {
    return pattern.test(elementLabel(node));
  }

  function isDisabledControl(node) {
    return !!(
      node?.disabled ||
      node?.getAttribute?.("aria-disabled") === "true" ||
      node?.getAttribute?.("disabled") !== null
    );
  }

  function describeControl(node) {
    if (!(node instanceof Element)) return null;
    return {
      label: elementLabel(node),
      text: normalizeText(node.innerText || node.textContent || ""),
      ariaLabel: normalizeText(node.getAttribute?.("aria-label") || ""),
      title: normalizeText(node.getAttribute?.("title") || ""),
      testId: normalizeText(node.getAttribute?.("data-testid") || ""),
      disabled: isDisabledControl(node),
    };
  }

  function findActionButton(pattern) {
    const buttons = queryVisibleElements(["button", "[role='button']"]);
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      if (matchesButtonLabel(buttons[index], pattern)) return buttons[index];
    }
    return null;
  }

  function findComposerNearbyButton(pattern) {
    const container = findComposerContainer();
    if (!container) return null;
    const buttons = Array.from(container.querySelectorAll("button,[role='button']")).filter(
      (node) => node instanceof Element && isVisible(node),
    );
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      if (matchesButtonLabel(buttons[index], pattern)) return buttons[index];
    }
    return null;
  }

  function getComposerActionState() {
    const container = findComposerContainer();
    const buttons = container
      ? Array.from(container.querySelectorAll("button,[role='button']")).filter((node) => node instanceof Element && isVisible(node))
      : [];
    const stopButton = findComposerNearbyButton(LABELS.stop);
    const sendButton = findComposerNearbyButton(LABELS.send);
    return {
      running: !!stopButton,
      runningBy: stopButton ? "composer-stop-button" : "",
      idle: !stopButton,
      stopButton: describeControl(stopButton),
      sendButton: describeControl(sendButton),
      buttons: buttons.map(describeControl).filter(Boolean),
    };
  }

  function composerActionFingerprint() {
    const actionState = getComposerActionState();
    return JSON.stringify({
      running: actionState.running,
      runningBy: actionState.runningBy,
      stopLabel: actionState.stopButton?.label || "",
      sendLabel: actionState.sendButton?.label || "",
      buttons: actionState.buttons.map((button) => `${button.label}:${button.disabled ? "disabled" : "enabled"}`),
    });
  }

  function syncComposerActionChange(reason = "composer-action") {
    const fingerprint = composerActionFingerprint();
    if (fingerprint === state.composerAction.fingerprint) return false;
    state.composerAction.fingerprint = fingerprint;
    state.composerAction.lastChangedAt = new Date().toISOString();
    syncState(reason);
    return true;
  }

  function findSendButton() {
    return findComposerNearbyButton(LABELS.send) || findActionButton(LABELS.send);
  }

  function findStopButton() {
    return findComposerNearbyButton(LABELS.stop);
  }

  function findReviewButton() {
    const buttons = queryVisibleElements(["button", "[role='button']"]);
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      const button = buttons[index];
      if (isCurrentReviewCandidate(button) && LABELS.reviewButton.test(elementLabel(button))) return button;
    }
    return null;
  }

  function findApprovalSurface() {
    const surfaces = queryVisibleElements(["[data-codex-approval-surface='true']"]);
    return surfaces[surfaces.length - 1] || null;
  }

  function isApprovalTextCandidate(node) {
    if (!(node instanceof Element) || !isVisible(node)) return false;
    if (node.closest("button,[role='button'],[role='radio'],textarea,input")) return false;
    const text = normalizeText(node.innerText || node.textContent || "");
    if (!text || text.length > 2000) return false;
    if ((text.match(/--[\w-]+\s*:/g) || []).length > 3) return false;
    if (/--vscode-|--color-|oklch\(|color-mix\(|box-sizing:\s*border-box/i.test(text)) return false;
    return true;
  }

  function firstApprovalText(surface, selectors) {
    for (const selector of selectors) {
      const node = Array.from(surface.querySelectorAll(selector)).find(isApprovalTextCandidate);
      if (node) return normalizeText(node.innerText || node.textContent || "");
    }
    return "";
  }

  function readApprovalSnapshot() {
    const surface = findApprovalSurface();
    if (!surface) return { text: "", explanation: "", command: "" };
    const explanation = firstApprovalText(surface, [
      ".text-base.font-medium",
      "[class~='text-base'][class~='font-medium']",
      "[class*='font-medium']",
    ]);
    let command = firstApprovalText(surface, [
      "pre code",
      "pre",
      "code",
      ".font-mono span.block",
      "[class*='font-mono'] span[class*='whitespace-pre-wrap']",
      "span[class*='break-words'][class*='whitespace-pre-wrap']",
      ".font-mono",
      "[class*='font-mono']",
    ]);
    if (command && command === explanation) command = "";
    const parts = [];
    if (explanation) parts.push(`说明：${explanation}`);
    if (command) parts.push(`命令：\n${command}`);
    return {
      text: parts.join("\n\n"),
      explanation,
      command,
    };
  }

  function findApprovalSurfaceControl(surface, pattern) {
    if (!(surface instanceof Element)) return null;
    const controls = Array.from(surface.querySelectorAll("button,[role='button'],[role='radio']")).filter(
      (node) => node instanceof Element && isVisible(node) && !isDisabledControl(node),
    );
    for (const control of controls) {
      if (pattern.test(elementLabel(control))) return control;
    }
    return null;
  }

  function approvalSubmitButton(surface) {
    return findApprovalSurfaceControl(surface, LABELS.reviewSubmitButton);
  }

  function findReviewActionButton() {
    const composerContainer = findComposerContainer();
    const scopes = [document.querySelector("main"), composerContainer, document.body].filter(Boolean);
    for (const scope of scopes) {
      const buttons = Array.from(scope.querySelectorAll("button,[role='button']")).filter(
        (node) => node instanceof Element && isVisible(node) && !isDisabledControl(node),
      );
      for (let index = buttons.length - 1; index >= 0; index -= 1) {
        const button = buttons[index];
        const label = elementLabel(button);
        if (LABELS.reviewButton.test(label) || LABELS.reviewRequestButton.test(label)) return button;
      }
    }
    return null;
  }

  function clickElement(node) {
    if (!node) return false;
    try {
      node.scrollIntoView?.({ block: "center", inline: "center" });
      focusElement(node);
      node.click();
      return true;
    } catch (_) {
      try {
        const rect = node.getBoundingClientRect();
        const options = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
          node.dispatchEvent(new MouseEvent(type, options));
        });
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function matchesConversation(item, target) {
    const text = normalizeText(target).toLowerCase();
    if (!text) return false;
    if (String(item.index) === text) return true;
    if (normalizeText(item.id).toLowerCase() === text) return true;
    const candidates = [
      item.name,
      item.displayName,
      item.title,
      item.folderName,
      item.folderName && item.name ? `${item.folderName} / ${item.name}` : "",
    ]
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean);
    return candidates.some((value) => value === text || value.includes(text) || text.includes(value));
  }

  function conversationClickableTarget(row) {
    return row;
  }

  function switchConversation(target) {
    const rows = sidebarThreadRows();
    const items = rows.map(conversationItemFromRow);
    const matchIndex = items.findIndex((item) => matchesConversation(item, target));
    pushDebug("conversation-switch-attempt", {
      target,
      items: items.map((item) => ({
        index: item.index,
        id: item.id,
        name: item.name,
        displayName: item.displayName,
        active: item.active,
      })),
    });
    if (matchIndex < 0) {
      throw new Error(`Conversation not found: ${target}`);
    }
    const row = rows[matchIndex];
    const item = items[matchIndex];
    const clickTarget = conversationClickableTarget(row);
    pushDebug("conversation-switch-match", {
      target,
      matchIndex,
      item,
      clickableTag: clickTarget?.tagName || "",
      clickableRole: clickTarget?.getAttribute?.("role") || "",
      rowTag: row?.tagName || "",
    });
    if (!clickElement(clickTarget) && !clickElement(row)) {
      throw new Error(`Failed to switch conversation: ${item.name || item.id}`);
    }
    window.setTimeout(() => syncState("conversation-switch"), ROUTE_SYNC_DELAY_MS);
    emit("conversation-switched", {
      id: item.id,
      name: item.name,
      index: item.index,
    });
    return { ok: true, item };
  }

  async function waitForConversationActive(target, timeoutMs = CONVERSATION_SWITCH_TIMEOUT_MS) {
    const startedAt = now();
    const wanted = normalizeText(target).toLowerCase();
    while (now() - startedAt < timeoutMs) {
      updateRouteState();
      const active = activeSidebarConversation();
      const activeId = normalizeText(active?.id || currentConversationId()).toLowerCase();
      const activeName = normalizeText(active?.displayName || active?.name || currentConversationName()).toLowerCase();
      pushDebug("conversation-switch-wait", {
        target,
        activeId,
        activeName,
      });
      if (wanted && (activeId === wanted || activeName === wanted || (active && matchesConversation(active, wanted)))) {
        await sleep(CONVERSATION_SWITCH_SETTLE_MS);
        syncState("conversation-active");
        return active || { id: currentConversationId(), name: currentConversationName() };
      }
      await sleep(100);
    }
    throw new Error(`Conversation did not become active: ${target}`);
  }

  async function ensureConversationActive(target) {
    const normalizedTarget = normalizeText(target);
    pushDebug("conversation-ensure-start", {
      target,
      normalizedTarget,
      currentConversationId: currentConversationId(),
      currentConversationName: currentConversationName(),
    });
    if (!normalizedTarget) {
      return {
        switched: false,
        previousConversationId: currentConversationId(),
        previousConversationName: currentConversationName(),
        activeConversationId: currentConversationId(),
        activeConversationName: currentConversationName(),
      };
    }
    const items = getConversations();
    const current = items.find((item) => item.active) || activeSidebarConversation();
    const currentId = current?.id || currentConversationId();
    const currentName = current?.displayName || current?.name || currentConversationName();
    const targetItem = items.find((item) => matchesConversation(item, normalizedTarget));
    const targetId = targetItem?.id || normalizedTarget;
    const targetName = targetItem?.displayName || targetItem?.name || normalizedTarget;
    pushDebug("conversation-ensure-resolved", {
      target,
      normalizedTarget,
      currentId,
      currentName,
      targetId,
      targetName,
      targetItem,
    });
    if (
      (currentId && normalizeText(currentId).toLowerCase() === normalizeText(targetId).toLowerCase()) ||
      (currentName && normalizeText(currentName).toLowerCase() === normalizeText(targetName).toLowerCase())
    ) {
      pushDebug("conversation-ensure-skip", {
        target,
        currentId,
        currentName,
        targetId,
        targetName,
      });
      return {
        switched: false,
        previousConversationId: currentId,
        previousConversationName: currentName,
        activeConversationId: currentId,
        activeConversationName: currentName,
      };
    }
    switchConversation(normalizedTarget);
    const active = await waitForConversationActive(targetId || targetName);
    pushDebug("conversation-ensure-active", {
      target,
      switched: true,
      previousConversationId: currentId,
      previousConversationName: currentName,
      activeConversationId: active?.id || currentConversationId(),
      activeConversationName: active?.displayName || active?.name || currentConversationName(),
    });
    return {
      switched: true,
      previousConversationId: currentId,
      previousConversationName: currentName,
      activeConversationId: active?.id || currentConversationId(),
      activeConversationName: active?.displayName || active?.name || currentConversationName(),
    };
  }

  async function withConversationTarget(target, fn) {
    pushDebug("conversation-target-enter", {
      target,
      beforeConversationId: currentConversationId(),
      beforeConversationName: currentConversationName(),
    });
    const context = await ensureConversationActive(target);
    try {
      pushDebug("conversation-target-ready", {
        target,
        context,
      });
      return await fn(context);
    } finally {
      if (context.switched && (context.previousConversationId || context.previousConversationName)) {
        const returnTarget = context.previousConversationId || context.previousConversationName;
        try {
          pushDebug("conversation-target-return-start", {
            target,
            returnTarget,
          });
          switchConversation(returnTarget);
          await waitForConversationActive(returnTarget);
          pushDebug("conversation-target-returned", {
            target,
            returnTarget,
            currentConversationId: currentConversationId(),
            currentConversationName: currentConversationName(),
          });
        } catch (error) {
          pushDebug("conversation-return-failed", {
            target: returnTarget,
            message: error?.message || String(error),
          });
        }
      }
    }
  }

  function submitComposer() {
    const composer = findComposerElement();
    if (!composer) throw new Error("Composer not found");
    const sendButton = findSendButton();
    if (sendButton && clickElement(sendButton)) {
      emit("user-submit", { source: "button", text: getComposerText() });
      return { ok: true, source: "button" };
    }
    focusElement(composer);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(event);
    emit("user-submit", { source: "keyboard", text: getComposerText() });
    return { ok: true, source: "keyboard" };
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function waitForEnabledApprovalSubmit(surface, timeoutMs = 1500) {
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      const button = approvalSubmitButton(surface);
      if (button && !isDisabledControl(button)) return button;
      await sleep(50);
    }
    return approvalSubmitButton(surface);
  }

  async function submitApprovalFeedback(text) {
    const surface = findApprovalSurface();
    if (!surface) throw new Error("Approval surface not found");
    const textarea = Array.from(surface.querySelectorAll("textarea")).find(
      (node) => node instanceof HTMLTextAreaElement && isVisible(node) && !isDisabledControl(node),
    );
    if (!textarea) throw new Error("Approval feedback textarea not found");
    const nextText = String(text ?? "");
    focusElement(textarea);
    clickElement(textarea);
    setNativeValue(textarea, nextText);
    await sleep(100);
    const submitButton = await waitForEnabledApprovalSubmit(surface);
    if (!submitButton) throw new Error("Approval submit button not found");
    if (!clickElement(submitButton)) throw new Error("Failed to submit approval feedback");
    emit("review-feedback-submitted", {
      source: "remote-command",
      text: nextText,
      submittedBy: elementLabel(submitButton),
    });
    return {
      ok: true,
      submitted: true,
      source: "approval-feedback",
      text: nextText,
      submittedBy: elementLabel(submitButton),
    };
  }

  async function waitForMessageSent(previousDraft, timeoutMs = SEND_VERIFY_TIMEOUT_MS) {
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      const draft = normalizeText(getComposerText());
      const status = detectStatus();
      if (!draft || draft !== normalizeText(previousDraft)) {
        return { ok: true, verifiedBy: "draft-changed", draft, status };
      }
      if (status === "running" || status === "review_required") {
        return { ok: true, verifiedBy: "status", draft, status };
      }
      await sleep(100);
    }
    return {
      ok: false,
      verifiedBy: "timeout",
      draft: normalizeText(getComposerText()),
      status: detectStatus(),
      timeoutMs,
    };
  }

  async function sendMessage(text, options = {}) {
    const submit = options.submit !== false;
    const nextText = String(text ?? "");
    if (options.target) {
      return withConversationTarget(options.target, () => sendMessage(nextText, { ...options, target: "" }));
    }
    if (submit && findApprovalSurface()) {
      return submitApprovalFeedback(nextText);
    }
    setComposerText(nextText);
    if (!submit) return { ok: true, submitted: false, text: nextText };
    await sleep(50);
    const beforeSubmitDraft = getComposerText();
    const submission = submitComposer();
    const verify = await waitForMessageSent(beforeSubmitDraft, Number(options.verifyTimeoutMs) || SEND_VERIFY_TIMEOUT_MS);
    if (!verify.ok) {
      return {
        ok: false,
        submitted: false,
        submission,
        verify,
        text: nextText,
        error: "Message was not confirmed as sent",
      };
    }
    return {
      ok: true,
      submitted: true,
      submission,
      verify,
      text: nextText,
    };
  }

  async function approveReview(options = {}) {
    if (options.target) {
      return withConversationTarget(options.target, () => approveReview({ ...options, target: "" }));
    }
    const surface = findApprovalSurface();
    if (surface) {
      const yesButton = findApprovalSurfaceControl(surface, LABELS.reviewButton);
      if (!yesButton) throw new Error("Approval option not found");
      if (!clickElement(yesButton)) throw new Error("Failed to select approval option");
      await sleep(100);
      const submitButton = await waitForEnabledApprovalSubmit(surface);
      if (!submitButton) throw new Error("Approval submit button not found");
      if (!clickElement(submitButton)) throw new Error("Failed to submit approval");
      emit("review-approved", {
        source: "remote-command",
        label: elementLabel(yesButton),
        submittedBy: elementLabel(submitButton),
      });
      return {
        ok: true,
        label: elementLabel(yesButton),
        submittedBy: elementLabel(submitButton),
      };
    }

    const button = findReviewButton();
    if (!button) {
      throw new Error("Review button not found");
    }
    if (!clickElement(button)) {
      throw new Error("Failed to click review button");
    }
    emit("review-approved", {
      source: "remote-command",
      label: elementLabel(button),
    });
    return {
      ok: true,
      label: elementLabel(button),
    };
  }

  async function stopCurrentRun(options = {}) {
    if (options.target) {
      return withConversationTarget(options.target, () => stopCurrentRun({ ...options, target: "" }));
    }
    const actionState = getComposerActionState();
    pushDebug("stop-command-start", {
      conversationId: currentConversationId(),
      conversationName: currentConversationName(),
      running: actionState.running,
      stopButton: actionState.stopButton,
    });
    const button = findStopButton();
    if (!button) {
      throw new Error("Stop button not found");
    }
    const label = elementLabel(button);
    if (!clickElement(button)) {
      throw new Error("Failed to click stop button");
    }
    await sleep(100);
    syncState("remote-stop");
    pushDebug("stop-command-clicked", {
      conversationId: currentConversationId(),
      conversationName: currentConversationName(),
      label,
    });
    emit("stop-requested", {
      source: "remote-command",
      label,
    });
    return {
      ok: true,
      label,
    };
  }

  function isConversationActionButton(node) {
    if (!(node instanceof Element)) return false;
    const label = elementLabel(node);
    return LABELS.copyMessage.test(label) || LABELS.branch.test(label);
  }

  function scoreAssistantContainer(node) {
    if (!(node instanceof Element)) return -1;
    const rect = visibleRect(node);
    if (!rect || rect.width < 240 || rect.height < 36) return -1;
    const text = normalizeText(node.innerText || node.textContent || "");
    if (!text || text.length < 8) return -1;
    if (node.querySelector("textarea,input,.ProseMirror,[contenteditable='true']")) return -1;

    let score = 0;
    if (node.matches?.("[data-message-author-role='assistant']")) score += 10;
    if (/assistant/i.test(node.getAttribute?.("data-testid") || "")) score += 8;
    const hasCopyButton = Array.from(node.querySelectorAll?.("button,[role='button']") || []).some((button) =>
      LABELS.copyMessage.test(elementLabel(button)),
    );
    if (hasCopyButton) score += 6;
    if (node.querySelector?.("p,li,pre,code")) score += 2;
    if (rect.height > 80) score += 1;
    return score;
  }

  function latestAssistantFromActionBar() {
    const buttons = Array.from(document.querySelectorAll("button,[role='button']")).filter(isConversationActionButton);
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      let current = buttons[index];
      let best = null;
      let bestScore = -1;
      while (current && current !== document.body) {
        const score = scoreAssistantContainer(current);
        if (score > bestScore) {
          best = current;
          bestScore = score;
        }
        if (score >= 10) break;
        current = current.parentElement;
      }
      if (bestScore > 0) return best;
    }
    return null;
  }

  function latestAssistantNode() {
    const actionBarTarget = latestAssistantFromActionBar();
    if (actionBarTarget) return actionBarTarget;

    const selectors = [
      "[data-message-author-role='assistant']",
      "[data-testid*='assistant']",
      "main article",
      "main [class*='message']",
    ];
    for (const selector of selectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => node instanceof Element && isVisible(node));
        if (nodes.length) return nodes[nodes.length - 1];
      } catch (_) {
        // Ignore unsupported selector shape.
      }
    }
    return null;
  }

  function hasActiveProcessingMarker() {
    const root = document.querySelector("main") || document.body;
    if (!root) return false;
    const candidates = Array.from(root.querySelectorAll("span,div"))
      .filter((node) => node instanceof Element && isVisible(node))
      .map((node) => ({
        node,
        text: normalizeText(node.innerText || node.textContent || ""),
        rect: node.getBoundingClientRect(),
        className: normalizeText(node.getAttribute?.("class") || ""),
      }))
      .filter((item) => {
        if (!LABELS.processingMarker.test(item.text)) return false;
        if (item.text.length > 32) return false;
        if (/inline-markdown/i.test(item.className)) return false;
        return /foreground\/60|text-token-text-secondary|text-token-description/i.test(item.className);
      });
    return candidates.length > 0;
  }

  function readAssistantSnapshot() {
    const node = latestAssistantNode();
    if (!node) return { text: "", html: "" };
    return {
      text: normalizeText(node.innerText || node.textContent || ""),
      html: String(node.innerHTML || ""),
    };
  }

  function cleanPushText(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => normalizeText(line));
    const cleaned = [];
    for (let line of lines) {
      if (!line) {
        cleaned.push("");
        continue;
      }
      if (/^(撤销|审核)$/.test(line)) continue;
      line = line.replace(/(?:^|\s)(撤销|审核)(?=\s|$)/g, " ").replace(/[ \t]{2,}/g, " ").trim();
      if (line) cleaned.push(line);
    }
    return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function upsertMessage(message) {
    const key = `${message.role}:${message.conversationId}:${message.text}`;
    const existing = state.messages.find((item) => item.key === key);
    if (existing) {
      existing.at = message.at;
      existing.html = message.html;
      return existing;
    }
    const next = { ...message, key };
    state.messages.push(next);
    if (state.messages.length > MESSAGE_LIMIT) state.messages.splice(0, state.messages.length - MESSAGE_LIMIT);
    return next;
  }

  function snapshotMessages(limit = 20) {
    const assistant = readAssistantSnapshot();
    if (assistant.text) {
      upsertMessage({
        role: "assistant",
        conversationId: currentConversationId(),
        text: assistant.text,
        html: assistant.html,
        at: new Date().toISOString(),
      });
    }
    const draft = getComposerText();
    if (draft) {
      upsertMessage({
        role: "draft",
        conversationId: currentConversationId(),
        text: normalizeText(draft),
        html: "",
        at: new Date().toISOString(),
      });
    }
    return state.messages.slice(-Math.max(1, Number(limit) || 20));
  }

  function detectReviewRequired() {
    if (findApprovalSurface()) return true;
    if (findReviewButton()) return true;
    const candidates = queryVisibleElements([
      "main [role='alert']",
      "main [role='status']",
      "main [data-testid*='approval']",
      "main [data-testid*='review']",
      "main [class*='approval']",
      "main [class*='review']",
    ]);
    return candidates.some((node) => isCurrentReviewCandidate(node));
  }

  function detectRunning() {
    if (state.network.pending > 0) return true;
    if (hasActiveProcessingMarker()) return true;
    return getComposerActionState().running;
  }

  function detectStatus() {
    if (detectReviewRequired()) return "review_required";
    if (detectRunning()) return "running";
    return "idle";
  }

  function activeSidebarConversation() {
    const id = currentConversationId();
    const items = getConversations();
    return items.find((item) => (id && item.id === id) || item.active) || null;
  }

  function shouldSuppressActiveTaskCompletion() {
    const active = activeSidebarConversation();
    return active?.status === "review_required";
  }

  function isCurrentConversationItem(item) {
    const id = currentConversationId();
    if (item?.active) return true;
    if (id && item?.id === id) return true;
    const currentName = normalizeText(currentConversationName());
    const itemName = normalizeText(item?.displayName || item?.name || "");
    return !!(currentName && itemName && currentName === itemName);
  }

  function shouldSuppressSidebarReview(item) {
    return item?.status === "review_required" && isCurrentConversationItem(item) && !!findApprovalSurface();
  }

  function shouldSuppressSidebarTaskComplete(item) {
    return item?.status === "task_complete_unread" && isCurrentConversationItem(item);
  }

  async function captureConversationEventFromSidebar(item, reason = "sidebar-capture") {
    const key = `${item?.id || item?.name}:${item?.status}:${reason}`;
    if (!item?.id || pendingConversationCaptures.has(key)) return false;
    pendingConversationCaptures.add(key);
    pushDebug("sidebar-capture-start", {
      key,
      reason,
      item,
      currentConversationId: currentConversationId(),
      currentConversationName: currentConversationName(),
    });
    try {
      await withConversationTarget(item.id || item.name, async () => {
        state.capture.active = true;
        state.capture.previousConversationId = currentConversationId();
        state.capture.previousConversationName = currentConversationName();
        await sleep(CONVERSATION_SWITCH_SETTLE_MS);
        syncState(`${reason}:after-switch`);
        const assistant = readAssistantSnapshot();
        const text = cleanPushText(assistant.text || state.lastAssistantText);
        pushDebug("sidebar-capture-read", {
          key,
          reason,
          conversationId: currentConversationId(),
          conversationName: currentConversationName(),
          assistantTextLength: (assistant.text || "").length,
          cachedTextLength: (state.lastAssistantText || "").length,
          finalTextLength: text.length,
          status: item.status,
        });
        if (item.status === "review_required") {
          const approval = readApprovalSnapshot();
          pushDebug("sidebar-capture-approval", {
            key,
            reason,
            explanationLength: String(approval?.explanation || "").length,
            commandLength: String(approval?.command || "").length,
            textLength: String(approval?.text || text || "").length,
          });
          emit("review-required", {
            reason: `${reason}:captured`,
            source: "captured",
            conversationId: currentConversationId(),
            conversationName: currentConversationName(),
            text: approval.text || text,
            approval,
            active: false,
            viaAutoSwitch: true,
          });
        } else if (item.status === "task_complete_unread" && text) {
          pushDebug("sidebar-capture-complete", {
            key,
            reason,
            textPreview: text.slice(0, 200),
            textLength: text.length,
          });
          emit("task-complete", {
            reason: `${reason}:captured`,
            source: "captured",
            conversationId: currentConversationId(),
            conversationName: currentConversationName(),
            text,
            active: false,
            viaAutoSwitch: true,
          });
        }
      });
      pushDebug("sidebar-capture-finished", {
        key,
        reason,
      });
      return true;
    } catch (error) {
      pushDebug("sidebar-capture-failed", {
        reason,
        conversationId: item?.id,
        conversationName: item?.displayName || item?.name,
        message: error?.message || String(error),
      });
      return false;
    } finally {
      state.capture.active = false;
      state.capture.previousConversationId = "";
      state.capture.previousConversationName = "";
      pendingConversationCaptures.delete(key);
    }
  }

  function setStatus(nextStatus, reason = "manual", extra = {}) {
    if (!nextStatus || nextStatus === state.lastStatus) return false;
    const previousStatus = state.lastStatus;
    state.lastStatus = nextStatus;
    if (nextStatus === "running" || nextStatus === "review_required") {
      window.clearTimeout(state.taskCompletionTimer);
      state.taskCompletionTimer = 0;
      state.taskCompletionSeq += 1;
    }
    emit("status-change", {
      reason,
      previousStatus,
      status: nextStatus,
      ...extra,
    });

    if (nextStatus === "review_required") {
      state.lastReviewAt = now();
      const approval = readApprovalSnapshot();
      emit("review-required", {
        reason,
        text: approval.text || cleanPushText(state.lastAssistantText),
        approval,
        ...extra,
      });
    }

    if (previousStatus === "running" && nextStatus === "idle") {
      if (shouldSuppressActiveTaskCompletion()) return true;
      scheduleTaskCompletion(reason, extra);
    }
    return true;
  }

  function scheduleTaskCompletion(reason, extra = {}) {
    window.clearTimeout(state.taskCompletionTimer);
    state.taskCompletionSeq += 1;
    const seq = state.taskCompletionSeq;
    state.taskCompletionTimer = window.setTimeout(() => {
      if (seq !== state.taskCompletionSeq) return;
      if (detectStatus() !== "idle") return;
      if (hasActiveProcessingMarker()) return;
      if (shouldSuppressActiveTaskCompletion()) return;
      const assistant = readAssistantSnapshot();
      const text = cleanPushText(assistant.text || state.lastAssistantText);
      if (!text) return;
      state.lastTaskCompletionAt = now();
      state.lastAssistantText = text;
      if (assistant.html) state.lastAssistantHtml = assistant.html;
      emit("task-complete", {
        reason: `${reason}:stable`,
        text,
        stableMs: TASK_COMPLETE_STABLE_MS,
        ...extra,
      });
    }, TASK_COMPLETE_STABLE_MS);
  }

  function emit(event, detail = {}) {
    state.seq += 1;
    const payload = {
      id: state.seq,
      event,
      at: new Date().toISOString(),
      conversationId: detail.conversationId || currentConversationId(),
      conversationName: detail.conversationName || currentConversationName(),
      projectId: currentProjectId(),
      detail,
    };
    pushDebug("event", payload);
    const handlers = state.listeners.get(event);
    if (handlers) {
      [...handlers].forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          pushDebug("listener-error", {
            event,
            message: error?.message || String(error),
          });
        }
      });
    }
    window.dispatchEvent(new CustomEvent("codex-qq-bridge", { detail: payload }));
    sendRemoteEvent(payload);
    return payload;
  }

  function syncSidebarConversationStatuses(reason = "sidebar") {
    const items = getConversations();
    items.forEach((item) => {
      if (!item.id || item.status === "idle" || item.status === "running") {
        if (item.id) state.sidebarConversationStatuses[item.id] = item.status;
        return;
      }
      const previousStatus = state.sidebarConversationStatuses[item.id] || "";
      state.sidebarConversationStatuses[item.id] = item.status;
      if (previousStatus === item.status) return;
      if (shouldSuppressSidebarReview(item)) {
        pushDebug("sidebar-review-suppressed", {
          reason,
          conversationId: item.id,
          conversationName: item.displayName || item.name,
          active: !!item.active,
        });
        return;
      }
      if (shouldSuppressSidebarTaskComplete(item)) {
        pushDebug("sidebar-task-complete-suppressed", {
          reason,
          conversationId: item.id,
          conversationName: item.displayName || item.name,
          active: !!item.active,
        });
        scheduleTaskCompletion(`${reason}:sidebar-current`, {
          conversationId: item.id,
          conversationName: item.displayName || item.name,
          source: "sidebar-current",
          sidebarStatus: item.status,
          sidebarStatusLabel: item.statusLabel,
          sidebarStatusReason: item.statusReason || "",
          active: !!item.active,
        });
        return;
      }

      const detail = {
        reason,
        source: "sidebar",
        conversationId: item.id,
        conversationName: item.displayName || item.name,
        text: `${item.displayName || item.name}：${item.statusLabel}`,
        sidebarStatus: item.status,
        sidebarStatusLabel: item.statusLabel,
        sidebarStatusReason: item.statusReason || "",
        active: !!item.active,
      };
      if (item.status === "review_required") {
        if (detail.active) {
          emit("review-required", detail);
        } else {
          captureConversationEventFromSidebar(item, `${reason}:review`);
        }
      } else if (item.status === "task_complete_unread") {
        if (detail.active) {
          emit("task-complete", detail);
        } else {
          captureConversationEventFromSidebar(item, `${reason}:complete`);
        }
      }
    });
  }

  function on(event, handler) {
    if (!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    state.listeners.get(event)?.delete(handler);
  }

  function extractJsonFragmentsFromSse(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
  }

  function collectPayloadText(value, depth = 0, output = [], seen = new WeakSet()) {
    if (value == null || depth > 6) return output;
    if (typeof value === "string") {
      const text = normalizeText(value);
      if (text) output.push(text);
      return output;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      output.push(String(value));
      return output;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectPayloadText(item, depth + 1, output, seen));
      return output;
    }
    if (typeof value !== "object") return output;
    if (seen.has(value)) return output;
    seen.add(value);

    [
      "text",
      "content",
      "message",
      "output_text",
      "outputText",
      "summary",
      "title",
      "status",
      "label",
      "description",
      "error",
      "reason",
    ].forEach((key) => {
      if (key in value) collectPayloadText(value[key], depth + 1, output, seen);
    });
    return output;
  }

  function inspectPayload(value, source, url) {
    const texts = collectPayloadText(value);
    const joined = normalizeText(texts.join("\n"));
    pushDebug("payload", {
      source,
      url: String(url || ""),
      preview: joined.slice(0, 400),
    });
    if (joined && LABELS.runningText.test(joined)) {
      setStatus("running", source, { url });
    }
    window.setTimeout(() => syncState(source), 0);
  }

  function inspectPayloadText(text, source, url) {
    const raw = String(text || "");
    if (!raw) {
      window.setTimeout(() => syncState(source), 0);
      return;
    }
    let parsedAny = false;
    try {
      inspectPayload(JSON.parse(raw), source, url);
      parsedAny = true;
    } catch (_) {
      // Fall through and inspect as SSE/plain text below.
    }
    extractJsonFragmentsFromSse(raw).forEach((fragment) => {
      try {
        inspectPayload(JSON.parse(fragment), source, url);
        parsedAny = true;
      } catch (_) {
        // Ignore malformed fragment.
      }
    });
    if (!parsedAny) inspectPayload(raw, source, url);
  }

  function markRequestStarted(source, url) {
    if (!isCodexApiUrl(url)) return 0;
    state.network.seq += 1;
    const requestId = state.network.seq;
    state.network.pending += 1;
    state.network.lastStartedAt = new Date().toISOString();
    state.network.lastUrl = String(url || "");
    setStatus("running", `${source}-start`, { url, requestId, pendingRequests: state.network.pending });
    pushDebug("request-start", {
      source,
      url: String(url || ""),
      requestId,
      pendingRequests: state.network.pending,
    });
    return requestId;
  }

  function markRequestFinished(source, url, requestId) {
    if (!requestId) return;
    state.network.pending = Math.max(0, state.network.pending - 1);
    state.network.lastFinishedAt = new Date().toISOString();
    state.network.lastUrl = String(url || "");
    pushDebug("request-finish", {
      source,
      url: String(url || ""),
      requestId,
      pendingRequests: state.network.pending,
    });
    window.setTimeout(() => syncState(`${source}-finish`), 0);
  }

  function syncState(reason = "manual") {
    updateRouteState();

    const assistant = readAssistantSnapshot();
    if (assistant.text && assistant.text !== state.lastAssistantText) {
      state.lastAssistantText = cleanPushText(assistant.text);
      state.lastAssistantHtml = assistant.html;
      state.lastAssistantAt = now();
      upsertMessage({
        role: "assistant",
        conversationId: currentConversationId(),
        text: state.lastAssistantText,
        html: assistant.html,
        at: new Date().toISOString(),
      });
      emit("assistant-message", { reason, text: state.lastAssistantText });
    }

    const draft = getComposerText();
    if (draft !== state.lastUserDraft) state.lastUserDraft = draft;

    const nextStatus = detectStatus();
    setStatus(nextStatus, reason);
    syncSidebarConversationStatuses(reason);
  }

  function installDomObserver() {
    if (!window.MutationObserver || window.__codexQqBridgeDomObserverVersion === SCRIPT_VERSION) return;
    window.__codexQqBridgeDomObserver?.disconnect?.();
    const observer = new MutationObserver(() => {
      if (!syncComposerActionChange("composer-action-dom")) syncState("dom");
    });
    const start = () => {
      const root = document.body || document.documentElement || document.querySelector("main");
      if (!root) return;
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      syncComposerActionChange("observer-start-composer-action");
      syncState("observer-start");
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    window.__codexQqBridgeDomObserver = observer;
    window.__codexQqBridgeDomObserverVersion = SCRIPT_VERSION;
    state.hookStatus.dom = true;
  }

  function installComposerActionObserver() {
    if (window.__codexQqBridgeComposerActionObserverVersion === SCRIPT_VERSION) return;
    window.clearInterval(window.__codexQqBridgeComposerActionPollTimer);
    state.composerAction.fingerprint = composerActionFingerprint();
    state.composerAction.lastChangedAt = new Date().toISOString();
    const timer = window.setInterval(() => {
      syncComposerActionChange("composer-action-poll");
    }, COMPOSER_ACTION_POLL_MS);
    state.composerAction.pollTimer = timer;
    window.__codexQqBridgeComposerActionPollTimer = timer;
    window.__codexQqBridgeComposerActionObserverVersion = SCRIPT_VERSION;
    state.hookStatus.composerAction = true;
  }

  function installSidebarStatusObserver() {
    if (window.__codexQqBridgeSidebarStatusObserverVersion === SCRIPT_VERSION) return;
    window.clearInterval(window.__codexQqBridgeSidebarStatusPollTimer);
    const timer = window.setInterval(() => {
      syncSidebarConversationStatuses("sidebar-poll");
    }, SIDEBAR_STATUS_POLL_MS);
    state.sidebarStatusPollTimer = timer;
    window.__codexQqBridgeSidebarStatusPollTimer = timer;
    window.__codexQqBridgeSidebarStatusObserverVersion = SCRIPT_VERSION;
    state.hookStatus.sidebar = true;
    syncSidebarConversationStatuses("sidebar-observer-start");
  }

  function installRouteObserver() {
    if (window.__codexQqBridgeRouteObserverVersion === SCRIPT_VERSION) return;
    const routeHistory = window.history;
    const originals = window.__codexQqBridgeRouteOriginals || {};
    window.__codexQqBridgeRouteOriginals = originals;
    const sync = () => window.setTimeout(() => syncState("route"), ROUTE_SYNC_DELAY_MS);
    ["pushState", "replaceState"].forEach((method) => {
      const original = originals[method] || routeHistory?.[method];
      originals[method] = original;
      if (typeof original !== "function") return;
      routeHistory[method] = function codexQqBridgePatchedHistory(...args) {
        const result = original.apply(routeHistory, args);
        sync();
        return result;
      };
    });
    window.addEventListener("popstate", sync, true);
    window.addEventListener("hashchange", sync, true);
    window.__codexQqBridgeRouteObserverVersion = SCRIPT_VERSION;
    state.hookStatus.route = true;
    sync();
  }

  function installSubmitObserver() {
    if (window.__codexQqBridgeSubmitObserverVersion === SCRIPT_VERSION) return;
    const handler = (event) => {
      const target = event.target;
      if (event.type === "submit") {
        emit("user-submit", { source: "submit-event", text: getComposerText() });
        return;
      }
      if (event.type === "keydown" && event.key === "Enter" && !event.shiftKey) {
        const composer = findComposerElement();
        if (composer && target && (target === composer || composer.contains?.(target))) {
          emit("user-submit", { source: "enter-key", text: getComposerText() });
        }
        return;
      }
      if (event.type === "click") {
        const button = target?.closest?.("button,[role='button']");
        if (button && matchesButtonLabel(button, LABELS.send)) {
          emit("user-submit", { source: "click", text: getComposerText() });
        }
      }
    };
    ["submit", "keydown", "click"].forEach((type) => {
      document.addEventListener(type, handler, true);
    });
    window.__codexQqBridgeSubmitObserverVersion = SCRIPT_VERSION;
    state.hookStatus.submit = true;
  }

  function installFetchObserver() {
    if (typeof window.fetch !== "function" || window.fetch.__codexQqBridgeNetworkWrapped === SCRIPT_VERSION) return;
    const baseFetch = window.fetch.__codexQqBridgeNetworkOriginal || window.fetch;
    const originalFetch = baseFetch.bind(window);

    async function wrappedFetch(input, init) {
      const url = requestUrl(input);
      if (typeof url === "string" && url.startsWith(VIRTUAL_HTTP_ORIGIN)) {
        return originalFetch(input, init);
      }
      const requestId = markRequestStarted("fetch", url);
      try {
        const response = await originalFetch(input, init);
        if (isCodexApiUrl(url) && response?.clone) {
          response
            .clone()
            .text()
            .then((text) => inspectPayloadText(text, "fetch", url))
            .catch(() => window.setTimeout(() => syncState("fetch"), 0))
            .finally(() => markRequestFinished("fetch", url, requestId));
        } else {
          markRequestFinished("fetch", url, requestId);
        }
        return response;
      } catch (error) {
        markRequestFinished("fetch", url, requestId);
        throw error;
      }
    }

    wrappedFetch.__codexQqBridgeNetworkWrapped = SCRIPT_VERSION;
    wrappedFetch.__codexQqBridgeNetworkOriginal = baseFetch;
    window.fetch = wrappedFetch;
    state.hookStatus.fetch = true;
  }

  function installXhrObserver() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr || Xhr.prototype.__codexQqBridgeWrapped === SCRIPT_VERSION) return;
    const originalOpen = Xhr.prototype.__codexQqBridgeOriginalOpen || Xhr.prototype.open;
    const originalSend = Xhr.prototype.__codexQqBridgeOriginalSend || Xhr.prototype.send;

    Xhr.prototype.open = function open(method, url, ...rest) {
      this.__codexQqBridgeUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    Xhr.prototype.send = function send(...args) {
      const url = this.__codexQqBridgeUrl;
      const requestId = markRequestStarted("xhr", url);
      this.addEventListener?.("loadend", () => {
        try {
          if (isCodexApiUrl(url)) {
            try {
              inspectPayloadText(this.responseText || "", "xhr", url);
            } catch (_) {
              window.setTimeout(() => syncState("xhr"), 0);
            }
          }
        } finally {
          markRequestFinished("xhr", url, requestId);
        }
      });
      return originalSend.apply(this, args);
    };

    Xhr.prototype.__codexQqBridgeOriginalOpen = originalOpen;
    Xhr.prototype.__codexQqBridgeOriginalSend = originalSend;
    Xhr.prototype.__codexQqBridgeWrapped = SCRIPT_VERSION;
    state.hookStatus.xhr = true;
  }

  function installWebSocketObserver() {
    if (typeof window.WebSocket !== "function" || window.__codexQqBridgeWebSocketWrapped === SCRIPT_VERSION) return;
    const NativeWebSocket = window.__codexQqBridgeNativeWebSocket || window.WebSocket;

    function HookedWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      const url = args[0];
      socket.addEventListener?.("message", (event) => {
        try {
          if (typeof event.data === "string") {
            inspectPayloadText(event.data, "websocket", url);
          } else if (event.data instanceof Blob && event.data.size <= 512000) {
            event.data
              .text()
              .then((text) => inspectPayloadText(text, "websocket", url))
              .catch(() => window.setTimeout(() => syncState("websocket"), 0));
          }
        } catch (_) {
          window.setTimeout(() => syncState("websocket"), 0);
        }
      });
      return socket;
    }

    try {
      HookedWebSocket.prototype = NativeWebSocket.prototype;
      Object.defineProperty(HookedWebSocket, "CONNECTING", { value: NativeWebSocket.CONNECTING });
      Object.defineProperty(HookedWebSocket, "OPEN", { value: NativeWebSocket.OPEN });
      Object.defineProperty(HookedWebSocket, "CLOSING", { value: NativeWebSocket.CLOSING });
      Object.defineProperty(HookedWebSocket, "CLOSED", { value: NativeWebSocket.CLOSED });
    } catch (_) {
      // Best-effort compatibility only.
    }

    window.WebSocket = HookedWebSocket;
    window.__codexQqBridgeNativeWebSocket = NativeWebSocket;
    window.__codexQqBridgeWebSocketWrapped = SCRIPT_VERSION;
    state.hookStatus.websocket = true;
  }

  async function readJsonBody(input, init) {
    if (init?.body == null && !(input instanceof Request)) return null;
    let body = init?.body;
    if (body == null && input instanceof Request) body = await input.clone().text();
    if (body == null || body === "") return null;
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch (_) {
        return { raw: body };
      }
    }
    if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
    return body;
  }

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-codex-bridge": SCRIPT_ID,
        "x-codex-bridge-version": SCRIPT_VERSION,
      },
    });
  }

  async function executeRemoteCommand(command) {
    const type = String(command?.type || "");
    const payload = command?.payload || {};
    if (type === "send") return sendMessage(payload.text ?? "", { submit: payload.submit !== false, target: payload.target ?? "" });
    if (type === "draft") return setComposerText(payload.text ?? "");
    if (type === "submit") return submitComposer();
    if (type === "approve") return approveReview({ target: payload.target ?? "" });
    if (type === "stop") return stopCurrentRun({ target: payload.target ?? "" });
    if (type === "switch-conversation") return switchConversation(payload.target ?? payload.name ?? payload.id ?? payload.index ?? "");
    if (type === "list-conversations") return { ok: true, items: getConversations() };
    if (type === "sync") {
      syncState("remote-command");
      return getState();
    }
    throw new Error(`Unsupported command type: ${type}`);
  }

  function sendRemoteMessage(message) {
    const socket = state.remoteBridge.socket;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function queueInjectorOutbox(message) {
    state.injectorRelay.outboxSeq += 1;
    const item = {
      id: state.injectorRelay.outboxSeq,
      at: new Date().toISOString(),
      message,
    };
    state.injectorRelay.outbox.push(item);
    if (state.injectorRelay.outbox.length > 200) {
      state.injectorRelay.outbox.splice(0, state.injectorRelay.outbox.length - 200);
    }
    return item;
  }

  function pullBridgeMessages(limit = 50) {
    const count = Math.max(1, Math.min(200, Number(limit) || 50));
    return state.injectorRelay.outbox.splice(0, count);
  }

  function pushBridgeMessage(message) {
    markInjectorRelayOnline("external-api");
    handleInjectorRelayMessage(message, "external-api");
    return { ok: true, state: getState() };
  }

  function sendInjectorRelayMessage(message, allowWhenOffline = false) {
    queueInjectorOutbox(message);
    if (!allowWhenOffline && !state.injectorRelay.online) return false;
    const envelope = {
      source: RELAY_PAGE_SOURCE,
      type: RELAY_MESSAGE_TYPE,
      message,
    };
    try {
      window.postMessage(envelope, "*");
      window.dispatchEvent(new CustomEvent(RELAY_OUTBOUND_EVENT, { detail: message }));
      state.injectorRelay.lastHeartbeatAt = new Date().toISOString();
      return true;
    } catch (error) {
      state.injectorRelay.lastError = error?.message || String(error);
      return false;
    }
  }

  function sendBridgeMessage(message, allowInjectorWhenOffline = false) {
    const remoteOk = sendRemoteMessage(message);
    const relayOk = sendInjectorRelayMessage(message, allowInjectorWhenOffline);
    return remoteOk || relayOk;
  }

  function sendRemoteState(reason = "state") {
    const message = {
      type: "state",
      reason,
      client: {
        sessionId: state.remoteBridge.sessionId,
      },
      state: getState(),
      lastAssistant: api.getLastAssistantMessage(),
    };
    const remoteOk = sendRemoteMessage(message);
    const relayOk = sendInjectorRelayMessage(message);
    if (remoteOk) {
      state.remoteBridge.lastHeartbeatAt = new Date().toISOString();
    }
    return remoteOk || relayOk;
  }

  function sendRemoteEvent(eventPayload) {
    const message = {
      type: "event",
      client: {
        sessionId: state.remoteBridge.sessionId,
      },
      event: eventPayload,
    };
    const cdpOk = sendCdpBindingMessage(message);
    return sendBridgeMessage(message) || cdpOk;
  }

  function sendCdpBindingMessage(message) {
    try {
      const binding = window[CDP_EVENT_BINDING];
      if (typeof binding !== "function") return false;
      binding(JSON.stringify(message));
      return true;
    } catch (error) {
      pushDebug("cdp-binding-error", { message: error?.message || String(error) });
      return false;
    }
  }

  function sendHello(reason = "hello") {
    return sendBridgeMessage(
      {
        type: "hello",
        reason,
        client: {
          sessionId: state.remoteBridge.sessionId,
          scriptId: SCRIPT_ID,
          version: SCRIPT_VERSION,
          href: window.location.href,
          title: document.title,
        },
      },
      true,
    );
  }

  function markInjectorRelayOnline(reason) {
    state.injectorRelay.online = true;
    state.injectorRelay.lastError = "";
    state.injectorRelay.lastSeenAt = now();
    state.injectorRelay.lastHeartbeatAt = new Date().toISOString();
    pushDebug("injector-relay-online", { reason });
  }

  function handleBridgeCommand(command, transportState) {
    const commandId = Number(command?.id) || 0;
    if (commandId && commandId <= Number(transportState.lastCommandId || 0)) return;
    if (commandId) transportState.lastCommandId = commandId;
    runRemoteCommand(command);
  }

  async function runRemoteCommand(command) {
    let ok = true;
    let result = null;
    let error = "";
    try {
      result = await executeRemoteCommand(command);
    } catch (err) {
      ok = false;
      error = err?.message || String(err);
    }
    sendBridgeMessage({
      type: "command-result",
      client: {
        sessionId: state.remoteBridge.sessionId,
      },
      commandId: command?.id,
      ok,
      result,
      error,
    });
  }

  function handleInjectorRelayMessage(message, source) {
    if (!message || typeof message !== "object") return;
    try {
      if (message.type === "relay-ready" || message.type === "relay-status") {
        if (message.online !== false) {
          markInjectorRelayOnline(`${source}:${message.type}`);
          sendHello("injector-relay-ready");
          sendRemoteState(message.type);
        } else {
          state.injectorRelay.online = false;
          state.injectorRelay.lastError = message.error || "";
        }
        return;
      }

      if (message.type === "hello-ack") {
        markInjectorRelayOnline(`${source}:hello-ack`);
        sendRemoteState("injector-hello-ack");
        return;
      }

      if (message.type === "command" && message.command) {
        markInjectorRelayOnline(`${source}:command`);
        handleBridgeCommand(message.command, state.injectorRelay);
      }
    } catch (error) {
      state.injectorRelay.lastError = error?.message || String(error);
      pushDebug("injector-relay-message-error", { source, message: state.injectorRelay.lastError });
    }
  }

  function installInjectorRelayBridge() {
    if (window.__codexQqBridgeInjectorRelayVersion === SCRIPT_VERSION) return;

    window.addEventListener(
      "message",
      (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== RELAY_SOURCE || data.type !== RELAY_MESSAGE_TYPE) return;
        handleInjectorRelayMessage(data.message, "postMessage");
      },
      false,
    );

    window.addEventListener(RELAY_INBOUND_EVENT, (event) => {
      handleInjectorRelayMessage(event.detail, "customEvent");
    });

    window.__codexQqBridgeInjectorRelayVersion = SCRIPT_VERSION;
    state.hookStatus.injectorRelay = true;
    sendHello("injector-relay-install");
  }

  function installRemoteBridgeClient() {
    if (window.__codexQqBridgeRemoteClientVersion === SCRIPT_VERSION) return;

    const connect = () => {
      try {
        const NativeBridgeWebSocket = window.__codexQqBridgeNativeWebSocket || window.WebSocket;
        const socket = new NativeBridgeWebSocket(state.remoteBridge.wsUrl);
        state.remoteBridge.socket = socket;

        socket.addEventListener("open", () => {
          state.remoteBridge.online = true;
          state.remoteBridge.lastError = "";
          sendHello("websocket-open");
          sendRemoteState("open");
        });

        socket.addEventListener("message", (event) => {
          try {
            const data = JSON.parse(String(event.data || "{}"));
            if (data?.type === "command" && data.command) {
              handleBridgeCommand(data.command, state.remoteBridge);
              return;
            }
            if (data?.type === "hello-ack") {
              sendRemoteState("hello-ack");
            }
          } catch (error) {
            pushDebug("remote-message-error", { message: error?.message || String(error) });
          }
        });

        socket.addEventListener("close", () => {
          state.remoteBridge.online = false;
          state.remoteBridge.socket = null;
          window.clearTimeout(state.remoteBridge.reconnectTimer);
          state.remoteBridge.reconnectTimer = window.setTimeout(connect, 2000);
        });

        socket.addEventListener("error", (event) => {
          state.remoteBridge.lastError = event?.message || "websocket error";
        });
      } catch (error) {
        state.remoteBridge.online = false;
        state.remoteBridge.lastError = error?.message || String(error);
        window.clearTimeout(state.remoteBridge.reconnectTimer);
        state.remoteBridge.reconnectTimer = window.setTimeout(connect, 2000);
      }
    };

    connect();
    state.remoteBridge.heartbeatTimer = window.setInterval(() => {
      if (!sendRemoteState("heartbeat")) {
        state.remoteBridge.online = false;
      }
    }, BRIDGE_HEARTBEAT_MS);
    window.__codexQqBridgeRemoteClientVersion = SCRIPT_VERSION;
    state.hookStatus.remoteBridge = true;
  }

  function getState() {
    const composerActionState = getComposerActionState();
    const processingMarkerActive = hasActiveProcessingMarker();
    const approval = readApprovalSnapshot();
    return {
      ok: true,
      id: SCRIPT_ID,
      version: SCRIPT_VERSION,
      installedAt: state.installedAt,
      conversationId: currentConversationId(),
      conversationName: currentConversationName(),
      conversations: getConversations(),
      sidebarConversationStatuses: { ...state.sidebarConversationStatuses },
      projectId: currentProjectId(),
      status: state.lastStatus,
      lastAssistantText: state.lastAssistantText,
      lastAssistantHtml: state.lastAssistantHtml,
      lastAssistantAt: state.lastAssistantAt ? new Date(state.lastAssistantAt).toISOString() : "",
      lastTaskCompletionAt: state.lastTaskCompletionAt ? new Date(state.lastTaskCompletionAt).toISOString() : "",
      taskCompleteStableMs: TASK_COMPLETE_STABLE_MS,
      lastReviewAt: state.lastReviewAt ? new Date(state.lastReviewAt).toISOString() : "",
      approval,
      draft: getComposerText(),
      composerActionState,
      runningBy: state.network.pending > 0 ? "network-pending" : processingMarkerActive ? "processing-marker" : composerActionState.runningBy || "",
      network: { ...state.network },
      processingMarkerActive,
      lastComposerActionChangedAt: state.composerAction.lastChangedAt,
      virtualHttpOrigin: VIRTUAL_HTTP_ORIGIN,
      hookStatus: { ...state.hookStatus },
      remoteBridge: {
        wsUrl: state.remoteBridge.wsUrl,
        sessionId: state.remoteBridge.sessionId,
        online: state.remoteBridge.online,
        lastHeartbeatAt: state.remoteBridge.lastHeartbeatAt,
        lastError: state.remoteBridge.lastError,
        lastCommandId: state.remoteBridge.lastCommandId,
      },
      injectorRelay: {
        online: state.injectorRelay.online,
        lastHeartbeatAt: state.injectorRelay.lastHeartbeatAt,
        lastError: state.injectorRelay.lastError,
        lastCommandId: state.injectorRelay.lastCommandId,
        lastSeenAt: state.injectorRelay.lastSeenAt ? new Date(state.injectorRelay.lastSeenAt).toISOString() : "",
        outboxPending: state.injectorRelay.outbox.length,
        outboxSeq: state.injectorRelay.outboxSeq,
      },
    };
  }

  async function handleVirtualHttp(input, init) {
    const method = String(init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const url = new URL(requestUrl(input));
    const path = url.pathname || "/";
    const body = await readJsonBody(input, init);

    if (method === "GET" && path === "/health") {
      return jsonResponse({
        ok: true,
        id: SCRIPT_ID,
        version: SCRIPT_VERSION,
        conversationId: currentConversationId(),
        conversationName: currentConversationName(),
        projectId: currentProjectId(),
      });
    }

    if (method === "GET" && path === "/state") {
      syncState("http-state");
      return jsonResponse(getState());
    }

    if (method === "GET" && path === "/messages") {
      return jsonResponse({ ok: true, items: snapshotMessages(Number(url.searchParams.get("limit") || 20)) });
    }

    if (method === "GET" && path === "/conversations") {
      return jsonResponse({ ok: true, items: getConversations() });
    }

    if (method === "GET" && path === "/last-assistant") {
      const snapshot = readAssistantSnapshot();
      return jsonResponse({
        ok: true,
        item: {
          role: "assistant",
          conversationId: currentConversationId(),
          text: snapshot.text,
          html: snapshot.html,
        },
      });
    }

    if (method === "POST" && path === "/draft") {
      return jsonResponse({ ok: true, result: setComposerText(body?.text ?? "") });
    }

    if (method === "POST" && path === "/send") {
      return jsonResponse({ ok: true, result: sendMessage(body?.text ?? "", { submit: body?.submit !== false }) });
    }

    if (method === "POST" && path === "/submit") {
      return jsonResponse({ ok: true, result: submitComposer() });
    }

    if (method === "POST" && path === "/stop") {
      return jsonResponse({ ok: true, result: stopCurrentRun({ target: body?.target ?? "" }) });
    }

    if (method === "POST" && path === "/conversation") {
      return jsonResponse({ ok: true, result: switchConversation(body?.target ?? body?.name ?? body?.id ?? body?.index ?? "") });
    }

    return jsonResponse({ ok: false, error: "Not found", method, path }, 404);
  }

  function installVirtualHttpFetch() {
    if (typeof window.fetch !== "function" || window.fetch.__codexQqBridgeWrapped === SCRIPT_VERSION) return;
    const baseFetch = window.fetch.__codexQqBridgeOriginal || window.fetch;
    const originalFetch = baseFetch.bind(window);
    async function wrappedFetch(input, init) {
      const url = requestUrl(input);
      if (typeof url === "string" && url.startsWith(VIRTUAL_HTTP_ORIGIN)) {
        return handleVirtualHttp(input, init);
      }
      return originalFetch(input, init);
    }
    wrappedFetch.__codexQqBridgeWrapped = SCRIPT_VERSION;
    wrappedFetch.__codexQqBridgeOriginal = baseFetch;
    window.fetch = wrappedFetch;
  }

  const api = {
    version: SCRIPT_VERSION,
    id: SCRIPT_ID,
    virtualHttpOrigin: VIRTUAL_HTTP_ORIGIN,
    debug: state.debug.slice(),
    getState,
    sync: (reason) => {
      syncState(reason || "api");
      return getState();
    },
    getMessages: (limit) => snapshotMessages(limit),
    getConversations,
    switchConversation,
    getLastAssistantMessage: () => ({
      role: "assistant",
      conversationId: currentConversationId(),
      conversationName: currentConversationName(),
      text: state.lastAssistantText || readAssistantSnapshot().text,
      html: state.lastAssistantHtml || readAssistantSnapshot().html,
    }),
    getDraft: () => getComposerText(),
    setDraft: (text) => setComposerText(text),
    submit: () => submitComposer(),
    sendMessage: (text, options) => sendMessage(text, options),
    approveReview,
    stopCurrentRun,
    pullBridgeMessages,
    pushBridgeMessage,
    connectRemoteBridge: () => {
      installInjectorRelayBridge();
      installRemoteBridgeClient();
      return getState();
    },
    request: async (path, options = {}) => {
      const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${VIRTUAL_HTTP_ORIGIN}${path}`;
      const init = { ...options };
      if (init.body && typeof init.body !== "string") {
        init.body = JSON.stringify(init.body);
        init.headers = {
          "content-type": "application/json",
          ...(init.headers || {}),
        };
      }
      const response = await window.fetch(url, init);
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    },
    on,
    off,
  };

  window[DEBUG_NAME] = state.debug.slice();
  window[API_NAME] = api;
  window.__CODEX_QQ_BRIDGE__ = api;

  installVirtualHttpFetch();
  installFetchObserver();
  installXhrObserver();
  installWebSocketObserver();
  installRouteObserver();
  installDomObserver();
  installComposerActionObserver();
  installSidebarStatusObserver();
  installSubmitObserver();
  installInjectorRelayBridge();
  installRemoteBridgeClient();
  syncState("install");
  emit("bridge-ready", {
    version: SCRIPT_VERSION,
    virtualHttpOrigin: VIRTUAL_HTTP_ORIGIN,
  });
})();
