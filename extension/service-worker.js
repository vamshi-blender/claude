const OPENAI_BASE_URL = "https://api.openai.com/v1";
const NATIVE_HOST = "com.vamshi.prompt_navigator";
const MAX_TOOL_LOOPS = 50;

const consoleBuffer = new Map();
const networkBuffer = new Map();
const screenshotStore = new Map();
// Removed global mcpGroupId - each tab group is independent
let nativePort = null;
let nativeRequestId = 0;
const pendingMcpRequests = new Map();
let lastToolCall = null;
let toolCallSequence = 0;
const activeChatRequests = new Map();
const recorderSessions = new Map();
const recorderLastUrls = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  // Side panel will be opened manually via chrome.action.onClicked
  // Do NOT set openPanelOnActionClick: true as it conflicts with manual handling
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number") {
    return;
  }
  // Fire side panel open immediately without awaiting (like reference extension)
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: `sidepanel.html?tabId=${encodeURIComponent(tab.id)}`,
    enabled: true
  });
  chrome.sidePanel.open({ tabId: tab.id });
  // Then handle group creation
  await ensureMcpGroup(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const session = recorderSessions.get(tabId);
  if (session?.isRecording) {
    const newUrl = changeInfo.url;
    if (newUrl) {
      recorderLastUrls.set(tabId, newUrl);
      session.steps.push({
        type: "navigate",
        url: newUrl,
        title: tab?.title || "",
        timestamp: Date.now()
      });
      void saveRecorderSession(tabId, session);
    } else if (changeInfo.status === "loading") {
      const lastUrl = recorderLastUrls.get(tabId);
      const currentUrl = tab?.url || lastUrl;
      if (lastUrl && currentUrl && lastUrl === currentUrl) {
        session.steps.push({
          type: "reload",
          url: currentUrl,
          title: tab?.title || "",
          timestamp: Date.now()
        });
        void saveRecorderSession(tabId, session);
      }
    }
  }

  if (changeInfo.status !== "complete") {
    return;
  }
  if (!session || !session.isRecording) {
    return;
  }
  void (async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["recorder-content.js"]
      });
      await chrome.tabs.sendMessage(tabId, { type: "RECORDER_SET_ACTIVE", active: true, paused: false });
    } catch {
      // ignore injection failures (e.g., non-scriptable URLs)
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHAT_REQUEST") {
    handleChatRequest(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "GET_LAST_TOOL") {
    sendResponse({ ok: true, tool: lastToolCall });
    return true;
  }
  if (message?.type === "CANCEL_REQUEST") {
    const entry = activeChatRequests.get(message.requestId);
    if (entry) {
      entry.controller.abort();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "RECORDER_START") {
    startRecording(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "RECORDER_STOP") {
    stopRecording(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "RECORDER_CLEAR") {
    clearRecording(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "RECORDER_GET") {
    getRecordingResolved(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "RECORDER_PLAY") {
    playRecording(message.tabId, message.speed)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "RECORDER_EVENT") {
    void handleRecorderEvent(sender?.tab?.id, message.step);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "RESET_TOOL_CALLS") {
    lastToolCall = null;
    toolCallSequence = 0;
    sendResponse({ ok: true });
    return true;
  }
});

async function ensureNativePort() {
  if (nativePort) {
    return nativePort;
  }
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected.";
    for (const [id, pending] of pendingMcpRequests.entries()) {
      pending.reject(new Error(error));
      pendingMcpRequests.delete(id);
    }
    nativePort = null;
  });
  return nativePort;
}

function handleNativeMessage(message) {
  if (message?.jsonrpc === "2.0" && message.id) {
    const pending = pendingMcpRequests.get(message.id);
    if (pending) {
      pendingMcpRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "MCP error"));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }
  if (message?.type === "EXECUTE_TOOL") {
    executeToolLocal(message.toolName, message.args, null)
      .then((result) => {
        nativePort?.postMessage({
          type: "TOOL_RESULT",
          requestId: message.requestId,
          result
        });
      })
      .catch((error) => {
        nativePort?.postMessage({
          type: "TOOL_RESULT",
          requestId: message.requestId,
          error: error.message || String(error)
        });
      });
  }
}

function setLastTool(tool) {
  toolCallSequence++;
  lastToolCall = {
    ...tool,
    sequence: toolCallSequence,
    timestamp: Date.now()
  };
}

function setLastToolResponse(response) {
  if (lastToolCall) {
    lastToolCall = {
      ...lastToolCall,
      response,
      responseTimestamp: Date.now()
    };
  }
}

async function startRecording(tabId) {
  const targetTabId = await resolveTabId(tabId, null);
  if (!targetTabId) {
    throw new Error("No tab available to record.");
  }
  const session = { steps: [], isRecording: true };
  recorderSessions.set(targetTabId, session);
  await saveRecorderSession(targetTabId, session);
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (tab?.url) {
    recorderLastUrls.set(targetTabId, tab.url);
  }
  try {
    await chrome.tabs.sendMessage(targetTabId, { type: "RECORDER_SET_ACTIVE", active: true, paused: false });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["recorder-content.js"]
    });
    await chrome.tabs.sendMessage(targetTabId, { type: "RECORDER_SET_ACTIVE", active: true, paused: false });
  }
  return { tabId: targetTabId };
}

async function stopRecording(tabId) {
  const targetTabId = await resolveTabId(tabId, null);
  if (!targetTabId) {
    throw new Error("No tab available to stop.");
  }
  const session = recorderSessions.get(targetTabId);
  if (session) {
    session.isRecording = false;
    await saveRecorderSession(targetTabId, session);
  }
  recorderLastUrls.delete(targetTabId);
  await chrome.tabs.sendMessage(targetTabId, { type: "RECORDER_SET_ACTIVE", active: false, paused: false });
  return { tabId: targetTabId };
}

async function clearRecording(tabId) {
  const targetTabId = await resolveTabId(tabId, null);
  if (!targetTabId) {
    return;
  }
  const session = { steps: [], isRecording: false };
  recorderSessions.set(targetTabId, session);
  await saveRecorderSession(targetTabId, session);
  recorderLastUrls.delete(targetTabId);
}

async function getRecordingResolved(tabId) {
  const targetTabId = await resolveTabId(tabId, null);
  if (!targetTabId) {
    return { tabId: null, steps: [], isRecording: false };
  }
  let session = recorderSessions.get(targetTabId);
  if (!session) {
    session = await loadRecorderSession(targetTabId);
  }
  if (!session) {
    return { tabId: targetTabId, steps: [], isRecording: false };
  }
  return { tabId: targetTabId, steps: session.steps, isRecording: session.isRecording };
}

function getRecorderStorage() {
  return chrome.storage?.session || chrome.storage.local;
}

async function loadRecorderSession(tabId) {
  const storage = getRecorderStorage();
  const key = `recorder_session_${tabId}`;
  const data = await storage.get(key);
  const session = data?.[key];
  if (session && Array.isArray(session.steps)) {
    recorderSessions.set(tabId, session);
    return session;
  }
  return null;
}

async function saveRecorderSession(tabId, session) {
  const storage = getRecorderStorage();
  const key = `recorder_session_${tabId}`;
  await storage.set({ [key]: session });
}

async function handleRecorderEvent(tabId, step) {
  if (!tabId || !step) {
    return;
  }
  let session = recorderSessions.get(tabId);
  if (!session) {
    session = await loadRecorderSession(tabId);
  }
  if (!session || !session.isRecording) {
    return;
  }
  const enriched = await enrichStepWithCdp(tabId, step);
  session.steps.push(enriched);
  recorderSessions.set(tabId, session);
  await saveRecorderSession(tabId, session);
}

async function playRecording(tabId, speed) {
  const targetTabId = await resolveTabId(tabId, null);
  if (!targetTabId) {
    throw new Error("No tab available to play.");
  }
  const playbackSpeed = clamp(Number(speed) || 1, 0.25, 4);
  const recording = await getRecordingResolved(targetTabId);
  for (let i = 0; i < recording.steps.length; i += 1) {
    const step = recording.steps[i];
    chrome.runtime.sendMessage({ type: "RECORDER_PLAYBACK_STEP", tabId: targetTabId, index: i });
    await executeRecorderStep(targetTabId, step, playbackSpeed);
    const delayMs = Math.max(50, 300 / playbackSpeed);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  chrome.runtime.sendMessage({ type: "RECORDER_PLAYBACK_DONE", tabId: targetTabId });
  return { ok: true, steps: recording.steps.length };
}

async function executeRecorderStep(tabId, step, speed) {
  if (step?.type === "wait") {
    const duration = Math.max(0, (Number(step.durationMs) || 0) / (Number(speed) || 1));
    if (duration) {
      await new Promise((resolve) => setTimeout(resolve, duration));
    }
    return { ok: true };
  }
  if (step?.type === "navigate") {
    await chrome.tabs.update(tabId, { url: step.url || "about:blank" });
    await waitForTabComplete(tabId, 15000);
    return { ok: true };
  }
  if (step?.type === "reload") {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, 15000);
    return { ok: true };
  }
  if (step?.type === "resize") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width: step.width, height: step.height });
    return { ok: true };
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (stepData) => {
      const findByCss = (css) => {
        try {
          return css ? document.querySelector(css) : null;
        } catch {
          return null;
        }
      };
      const findByXPath = (xpath) => {
        try {
          if (!xpath) return null;
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return result.singleNodeValue;
        } catch {
          return null;
        }
      };
      const findByText = (text) => {
        if (!text) return null;
        const candidates = Array.from(document.querySelectorAll("button, a, input, textarea, select, [role]"));
        return candidates.find((el) => (el.textContent || "").trim().includes(text));
      };
      const findByAria = (aria) => {
        if (!aria) return null;
        if (aria.label) {
          const labelMatch = document.querySelector(`[aria-label=\"${aria.label}\"]`);
          if (labelMatch) return labelMatch;
        }
        return null;
      };
      const findByPierce = (pierce) => {
        if (!pierce) return null;
        const parts = pierce.split(">>>").map((part) => part.trim()).filter(Boolean);
        let root = document;
        let node = null;
        for (const part of parts) {
          node = root.querySelector(part);
          if (!node) return null;
          if (node.shadowRoot) {
            root = node.shadowRoot;
          }
        }
        return node;
      };
      const selectors = stepData.selectors || {};
      const element =
        findByCss(selectors.css) ||
        findByXPath(selectors.xpath) ||
        findByPierce(selectors.pierce) ||
        findByAria(selectors.aria) ||
        findByText(selectors.text);
      if (stepData.type === "scroll" && stepData.target === "window") {
        window.scrollTo(stepData.x || 0, stepData.y || 0);
        return { ok: true };
      }
      if (!element) {
        return { ok: false, error: "Element not found." };
      }
      if (stepData.type === "click") {
        element.click();
        return { ok: true };
      }
      if (stepData.type === "double_click") {
        element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return { ok: true };
      }
      if (stepData.type === "triple_click") {
        for (let i = 0; i < 3; i += 1) {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: i + 1 }));
        }
        return { ok: true };
      }
      if (stepData.type === "right_click") {
        element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
        return { ok: true };
      }
      if (stepData.type === "hover") {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        return { ok: true };
      }
      if (stepData.type === "input") {
        if ("value" in element) {
          element.value = stepData.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
      }
      if (stepData.type === "select_change") {
        if ("value" in element) {
          element.value = stepData.value;
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
      }
      if (stepData.type === "file_upload") {
        return { ok: false, error: "File upload steps cannot be replayed automatically." };
      }
      if (stepData.type === "keydown") {
        element.focus?.();
        const eventInit = {
          key: stepData.key,
          code: stepData.code,
          ctrlKey: Boolean(stepData.ctrlKey),
          metaKey: Boolean(stepData.metaKey),
          altKey: Boolean(stepData.altKey),
          shiftKey: Boolean(stepData.shiftKey),
          bubbles: true
        };
        element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
        element.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        return { ok: true };
      }
      if (stepData.type === "focus") {
        element.focus?.();
        return { ok: true };
      }
      if (stepData.type === "blur") {
        element.blur?.();
        return { ok: true };
      }
      if (stepData.type === "scroll") {
        element.scrollLeft = stepData.x || 0;
        element.scrollTop = stepData.y || 0;
        return { ok: true };
      }
      if (stepData.type === "submit") {
        if (typeof element.submit === "function") {
          element.submit();
          return { ok: true };
        }
      }
      if (stepData.type === "drag_drop") {
        const sourceSelectors = stepData.sourceSelectors || {};
        const source =
          findByCss(sourceSelectors.css) ||
          findByXPath(sourceSelectors.xpath) ||
          findByPierce(sourceSelectors.pierce) ||
          findByAria(sourceSelectors.aria) ||
          findByText(sourceSelectors.text);
        if (!source) {
          return { ok: false, error: "Drag source not found." };
        }
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        element.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
        element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
        source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
        return { ok: true };
      }
      return { ok: false, error: "Unsupported step type." };
    },
    args: [step]
  });
  return result?.result;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let timeout = null;
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        cleanup();
      }
    };
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(cleanup, timeoutMs);
  });
}

async function enrichStepWithCdp(tabId, step) {
  if (!step?.selectors?.css) {
    return step;
  }
  try {
    await ensureDebugger(tabId);
    const documentResult = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", {
      depth: 1,
      pierce: true
    });
    const rootId = documentResult?.root?.nodeId;
    if (!rootId) {
      return step;
    }
    const queryResult = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: rootId,
      selector: step.selectors.css
    });
    const nodeId = queryResult?.nodeId;
    if (!nodeId) {
      return step;
    }
    const [nodeInfo, attributes, boxModel] = await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "DOM.describeNode", { nodeId }),
      chrome.debugger.sendCommand({ tabId }, "DOM.getAttributes", { nodeId }),
      chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", { nodeId }).catch(() => null)
    ]);
    return {
      ...step,
      cdp: {
        nodeId,
        nodeName: nodeInfo?.node?.nodeName || "",
        attributes: attributes?.attributes || [],
        boxModel: boxModel?.model || null
      }
    };
  } catch {
    return step;
  }
}

async function mcpRequest(method, params, timeoutMs = 8000) {
  await ensureNativePort();
  const id = `mcp_${Date.now()}_${nativeRequestId++}`;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    nativePort.postMessage(payload);
    const timer = setTimeout(() => {
      if (pendingMcpRequests.has(id)) {
        pendingMcpRequests.delete(id);
        reject(new Error("MCP request timed out."));
      }
    }, timeoutMs);
    const wrappedResolve = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const wrappedReject = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    pendingMcpRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (typeof tabId !== "number") {
    return;
  }
  if (method === "Log.entryAdded") {
    const entry = {
      type: params?.entry?.level || "log",
      text: params?.entry?.text || "",
      url: params?.entry?.url || "",
      timestamp: params?.entry?.timestamp || Date.now()
    };
    pushBuffer(consoleBuffer, tabId, entry);
  }
  if (method === "Runtime.exceptionThrown") {
    const entry = {
      type: "exception",
      text: params?.exceptionDetails?.text || "Exception",
      url: params?.exceptionDetails?.url || "",
      timestamp: params?.exceptionDetails?.timestamp || Date.now()
    };
    pushBuffer(consoleBuffer, tabId, entry);
  }
  if (method === "Network.requestWillBeSent") {
    const entry = {
      url: params?.request?.url || "",
      method: params?.request?.method || "",
      type: params?.type || "",
      timestamp: params?.timestamp || Date.now()
    };
    pushBuffer(networkBuffer, tabId, entry);
  }
});

async function handleChatRequest(message) {
  const { history, tabId, requestId } = message;
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("Missing chat history.");
  }

  const { openaiApiKey, openaiModel } = await chrome.storage.local.get([
    "openaiApiKey",
    "openaiModel"
  ]);

  if (!openaiApiKey) {
    throw new Error("OpenAI API key not set. Open Options to add it.");
  }

  const controller = new AbortController();
  if (requestId) {
    activeChatRequests.set(requestId, { controller });
  }

  const localTools = buildTools();
  let tools = localTools;
  try {
    const remoteTools = await mcpRequest("tools/list", {});
    if (remoteTools?.tools?.length) {
      const remoteMapped = remoteTools.tools.map((toolDef) => ({
        type: "function",
        function: {
          name: toolDef.name,
          description: toolDef.description || "",
          parameters: toolDef.inputSchema || { type: "object", properties: {} }
        }
      }));
      const toolByName = new Map();
      for (const tool of localTools) {
        toolByName.set(tool.function.name, tool);
      }
      for (const tool of remoteMapped) {
        toolByName.set(tool.function.name, tool);
      }
      tools = Array.from(toolByName.values());
    }
  } catch (error) {
    // Fallback to local tool registry if native host is unavailable.
  }
  const systemMessage = {
    role: "system",
    content:
      "You are a browser automation agent. Use the available tools to navigate, " +
      "read pages, and interact with web content. Behave like a careful human: " +
      "load pages, wait for content, click visible elements, and only type after " +
      "focusing an input. Capture a screenshot after each action when it helps " +
      "verify the UI state or the result of the last step. If the current tab is not a normal web page (e.g. chrome://), " +
      "navigate to a regular URL first. If you need a tab id, use tabs_context or " +
      "tabs_context_mcp first."
  };

  const model = openaiModel || "gpt-4o-mini";
  let messages = [systemMessage, ...history];
  let loops = 0;

  try {
    while (loops < MAX_TOOL_LOOPS) {
      if (controller.signal.aborted) {
        return { assistantMessage: "Paused by user.", paused: true };
      }
      loops += 1;
      const assistant = await callOpenAIStreaming(
        openaiApiKey,
        model,
        messages,
        tools,
        controller.signal,
        (delta) => {
          if (delta && requestId) {
            chrome.runtime.sendMessage({ type: "CHAT_STREAM", requestId, delta });
          }
        }
      );
      if (!assistant) {
        return { assistantMessage: "No response from model." };
      }

      messages = [...messages, assistant];

      const toolCalls = assistant.tool_calls || [];
      if (toolCalls.length === 0) {
        if (requestId) {
          chrome.runtime.sendMessage({ type: "CHAT_STREAM_DONE", requestId });
        }
        return { assistantMessage: assistant.content || "Done." };
      }

      for (const toolCall of toolCalls) {
        if (controller.signal.aborted) {
          return { assistantMessage: "Paused by user.", paused: true };
        }
        setLastTool({
          name: toolCall.function?.name || "unknown",
          args: safeParseJson(toolCall.function?.arguments || "{}") || {}
        });
        let result;
        const toolName = toolCall.function?.name;
        const toolArgs = safeParseJson(toolCall.function?.arguments || "{}") || {};
        try {
          if (controller.signal.aborted) {
            return { assistantMessage: "Paused by user.", paused: true };
          }
          if (toolName === "computer") {
            result = await executeToolLocal(toolName, toolArgs, tabId);
          } else {
            result = await mcpRequest("tools/call", {
              name: toolName,
              arguments: toolArgs,
              tabId
            });
            console.log("[tool] MCP call", toolName, toolCall.function?.arguments);
          }
        } catch (error) {
          console.warn("[tool] MCP failed, using local", toolName, error.message || error);
          result = await executeToolLocal(toolName, toolArgs, tabId);
        }
        setLastToolResponse(result);
        messages = [
          ...messages,
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          }
        ];
      }
    }

    return {
      assistantMessage: `Paused after ${MAX_TOOL_LOOPS} tool calls. Click Continue to proceed.`,
      paused: true
    };
  } finally {
    if (requestId) {
      activeChatRequests.delete(requestId);
    }
  }
}

function buildTools() {
  return [
    tool("navigate", "Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context first to get available tabs.", {
      url: { type: "string", description: "The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use \"forward\" to go forward in history or \"back\" to go back in history." },
      tabId: { type: "number", description: "Tab ID to navigate. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID." }
    }, ["url"]),
    tool("computer", "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context first to get available tabs.", {
      action: { type: "string", enum: ["left_click","right_click","type","screenshot","wait","scroll","key","left_click_drag","double_click","triple_click","zoom","scroll_to","hover"] },
      coordinate: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
      text: { type: "string" },
      duration: { type: "number" },
      scroll_direction: { type: "string", enum: ["up","down","left","right"] },
      scroll_amount: { type: "number" },
      start_coordinate: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
      region: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
      repeat: { type: "number" },
      ref: { type: "string" },
      modifiers: { type: "string" },
      tabId: { type: "number" }
    }, ["action"]),
    tool("read_page", "Get an accessibility tree representation of elements on the page.", {
      filter: { type: "string", enum: ["interactive","all"] },
      tabId: { type: "number" },
      depth: { type: "number" },
      ref_id: { type: "string" }
    }, []),
    tool("form_input", "Set values in form elements using element reference ID from the read_page or find tools.", {
      ref: { type: "string" },
      value: { type: ["string","boolean","number"] },
      tabId: { type: "number" }
    }, ["ref","value"]),
    tool("get_page_text", "Extract raw text content from the page, prioritizing article content.", {
      tabId: { type: "number" }
    }, []),
    tool("find", "Find elements on the page using natural language.", {
      query: { type: "string" },
      tabId: { type: "number" }
    }, ["query"]),
    tool("tabs_context", "Get context information about all tabs in the current tab group.", {}, []),
    tool("tabs_create", "Creates a new empty tab in the current tab group.", {}, []),
    tool("upload_image", "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target.", {
      imageId: { type: "string" },
      ref: { type: "string" },
      coordinate: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
      tabId: { type: "number" },
      filename: { type: "string" }
    }, ["imageId"]),
    tool("read_console_messages", "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab.", {
      tabId: { type: "number" },
      onlyErrors: { type: "boolean" },
      clear: { type: "boolean" },
      pattern: { type: "string" },
      limit: { type: "number" }
    }, ["tabId","pattern"]),
    tool("read_network_requests", "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab.", {
      tabId: { type: "number" },
      urlPattern: { type: "string" },
      clear: { type: "boolean" },
      limit: { type: "number" }
    }, ["tabId"]),
    tool("user_context", "Get the user's local date/time, timezone, and (if permitted) location.", {
      tabId: { type: "number", description: "Optional tab id used to request geolocation permission." },
      timeoutMs: { type: "number", description: "Optional timeout for geolocation in milliseconds." }
    }, []),
    tool("resize_window", "Resize the current browser window to specified dimensions.", {
      width: { type: "number" },
      height: { type: "number" },
      tabId: { type: "number" }
    }, ["width","height"]),
    tool("turn_answer_start", "Call this immediately before your text response to the user for this turn.", {}, []),
    tool("javascript_tool", "Execute JavaScript code in the context of the current page.", {
      action: { type: "string" },
      text: { type: "string" },
      tabId: { type: "number" }
    }, ["action","text"]),
    tool("tabs_context_mcp", "Get context information about the current MCP tab group.", {
      createIfEmpty: { type: "boolean" }
    }, []),
    tool("tabs_create_mcp", "Creates a new empty tab in the MCP tab group.", {}, [])
  ];
}

function tool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required
      }
    }
  };
}

async function executeToolLocal(name, args, fallbackTabId) {
  switch (name) {
    case "navigate":
      return toolNavigate(args, fallbackTabId);
    case "computer":
      return toolComputer(args, fallbackTabId);
    case "read_page":
      return toolReadPage(args, fallbackTabId);
    case "form_input":
      return toolFormInput(args, fallbackTabId);
    case "get_page_text":
      return toolGetPageText(args, fallbackTabId);
    case "find":
      return toolFind(args, fallbackTabId);
    case "tabs_context":
      return toolTabsContext();
    case "tabs_create":
      return toolTabsCreate();
    case "upload_image":
      return toolUploadImage(args, fallbackTabId);
    case "read_console_messages":
      return toolReadConsole(args);
    case "read_network_requests":
      return toolReadNetwork(args);
    case "user_context":
      return toolUserContext(args, fallbackTabId);
    case "resize_window":
      return toolResizeWindow(args);
    case "javascript_tool":
      return toolJavascript(args, fallbackTabId);
    case "tabs_context_mcp":
      return toolTabsContextMcp(args);
    case "tabs_create_mcp":
      return toolTabsCreateMcp();
    case "turn_answer_start":
      return { ok: true };
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

async function toolNavigate(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const url = normalizeUrl(args.url);
  if (url === "back") {
    await chrome.tabs.goBack(tabId);
  } else if (url === "forward") {
    await chrome.tabs.goForward(tabId);
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  return { ok: true, tabId, url };
}

async function toolComputer(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const action = args.action;
  if (action === "screenshot") {
    const image = await chrome.tabs.captureVisibleTab();
    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    screenshotStore.set(id, image);
    return { ok: true, imageId: id, dataUrl: image };
  }
  if (action === "wait") {
    // Duration is in milliseconds, clamped between 0 and 30000ms (30 seconds)
    const duration = clamp(args.duration || 1000, 0, 30000);
    await new Promise((resolve) => setTimeout(resolve, duration));
    return { ok: true };
  }

  await ensureDebugger(tabId);

  if (action === "scroll") {
    const coordinate = args.coordinate || (await getViewportCenter(tabId));
    const delta = (args.scroll_amount || 3) * 100;
    const direction = args.scroll_direction || "down";
    const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
    const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;
    await dispatchMouseWheel(tabId, coordinate, deltaX, deltaY);
    return { ok: true };
  }

  if (action === "scroll_to") {
    if (!args.ref) {
      return { ok: false, error: "scroll_to requires ref." };
    }
    const rect = await scrollToRef(tabId, args.ref);
    return { ok: true, rect };
  }

  if (action === "type") {
    const text = typeof args.text === "string" ? args.text : String(args.text ?? "");
    if (!text) {
      return { ok: false, error: "type requires text." };
    }
    await dispatchType(tabId, text);
    return { ok: true };
  }

  if (action === "key") {
    if (!args.text) {
      return { ok: false, error: "key requires text." };
    }
    const repeat = clamp(args.repeat || 1, 1, 100);
    for (let i = 0; i < repeat; i += 1) {
      await dispatchKey(tabId, args.text);
    }
    return { ok: true };
  }

  if (action === "hover") {
    const coordinate = await resolveCoordinate(tabId, args);
    await dispatchMouseMove(tabId, coordinate);
    return { ok: true };
  }

  if (action === "left_click_drag") {
    const start = args.start_coordinate;
    const end = args.coordinate;
    if (!start || !end) {
      return { ok: false, error: "left_click_drag requires start_coordinate and coordinate." };
    }
    await dispatchMouseMove(tabId, start);
    await dispatchMousePress(tabId, start, 0, 1);
    await dispatchMouseMove(tabId, end);
    await dispatchMouseRelease(tabId, end, 0, 1);
    return { ok: true };
  }

  if (action === "zoom") {
    return { ok: false, error: "zoom not implemented." };
  }

  const clickMap = {
    left_click: { button: 0, count: 1 },
    right_click: { button: 2, count: 1 },
    double_click: { button: 0, count: 2 },
    triple_click: { button: 0, count: 3 }
  };
  if (clickMap[action]) {
    const coordinate = await resolveCoordinate(tabId, args);
    const { button, count } = clickMap[action];
    await dispatchMouseClick(tabId, coordinate, button, count);
    return { ok: true };
  }

  return { ok: false, error: `Unsupported computer action: ${action}` };
}

async function toolReadPage(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const filter = args.filter || "all";
  const depth = Number.isFinite(args.depth) ? args.depth : null;
  const refId = args.ref_id || null;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (filterValue, depthValue, refValue) => {
      if (typeof window.__generateAccessibilityTree !== "function") {
        return { error: "Accessibility tree helper not available." };
      }
      return window.__generateAccessibilityTree(filterValue, depthValue, refValue);
    },
    args: [filter, depth, refId]
  });
  return result?.result || { ok: false, error: "Failed to read page." };
}

async function toolFormInput(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, value) => {
      const map = window.__claudeElementMap;
      const entry = map?.[ref];
      const el = entry?.deref?.();
      if (!el) {
        return { ok: false, error: "Ref not found." };
      }
      if (el.type === "checkbox") {
        el.checked = Boolean(value);
      } else if (el.tagName === "SELECT") {
        const options = Array.from(el.options);
        const match = options.find((opt) => opt.value === String(value) || opt.textContent === String(value));
        if (match) {
          el.value = match.value;
        }
      } else {
        el.value = String(value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    args: [args.ref, args.value]
  });
  return result?.result || { ok: false, error: "Failed to set form input." };
}

async function toolGetPageText(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = document.body ? document.body.innerText : "";
      return { ok: true, text };
    }
  });
  return result?.result || { ok: false, error: "Failed to read text." };
}

async function toolFind(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const query = String(args.query || "").trim().toLowerCase();
  if (!query) {
    return { ok: false, error: "Query required." };
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (q) => {
      const results = [];
      const map = window.__claudeElementMap || (window.__claudeElementMap = {});
      const getLabel = (el) => {
        return (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          el.textContent ||
          ""
        )
          .trim()
          .slice(0, 200);
      };
      const isInteractive = (el) => {
        const tag = el.tagName?.toLowerCase();
        return ["a","button","input","select","textarea"].includes(tag) || el.getAttribute("role") === "button";
      };
      const elements = Array.from(document.querySelectorAll("*")).filter(isInteractive);
      for (const el of elements) {
        if (results.length >= 20) break;
        const label = getLabel(el).toLowerCase();
        if (label.includes(q)) {
          let ref = null;
          for (const key in map) {
            if (map[key]?.deref?.() === el) {
              ref = key;
              break;
            }
          }
          if (!ref) {
            const id = `ref_${Object.keys(map).length + 1}`;
            map[id] = new WeakRef(el);
            ref = id;
          }
          results.push({ ref, label: getLabel(el) });
        }
      }
      return { ok: true, matches: results, truncated: elements.length > 20 };
    },
    args: [query]
  });
  return result?.result || { ok: false, error: "Failed to find elements." };
}

async function toolTabsContext() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || typeof activeTab.id !== "number") {
    return { ok: false, error: "No active tab." };
  }
  const groupId = activeTab.groupId;
  // Only return tabs from the current tab's group - enforce isolation
  if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    // Tab is not in a group - only return this tab
    return {
      ok: true,
      groupId: null,
      tabs: [{ id: activeTab.id, title: activeTab.title, url: activeTab.url }]
    };
  }
  const tabs = await chrome.tabs.query({ groupId });
  return {
    ok: true,
    groupId: groupId,
    tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }))
  };
}

async function toolTabsCreate() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    return { ok: false, error: "No active tab." };
  }
  const tab = await chrome.tabs.create({ windowId: activeTab.windowId, url: "about:blank" });
  if (activeTab.groupId && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && tab.id) {
    await chrome.tabs.group({ tabIds: tab.id, groupId: activeTab.groupId });
  }
  return { ok: true, tabId: tab.id };
}

async function toolTabsContextMcp(args) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || typeof activeTab.id !== "number") {
    return { ok: false, error: "No active tab." };
  }
  const groupId = activeTab.groupId;
  // If tab is already in a group, return that group's tabs
  if (groupId && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const tabs = await chrome.tabs.query({ groupId });
    return { ok: true, groupId, tabs: tabs.map((tab) => tab.id) };
  }
  // Tab is not in a group
  if (args?.createIfEmpty) {
    const newGroupId = await chrome.tabs.group({ tabIds: activeTab.id });
    await chrome.tabGroups.update(newGroupId, {
      title: "Prompt Navigator",
      color: "blue"
    });
    if (!isScriptableUrl(activeTab.url)) {
      const newTab = await chrome.tabs.create({ windowId: activeTab.windowId, url: "about:blank" });
      if (newTab.id) {
        await chrome.tabs.group({ tabIds: newTab.id, groupId: newGroupId });
        return { ok: true, groupId: newGroupId, tabs: [newTab.id] };
      }
    }
    return { ok: true, groupId: newGroupId, tabs: [activeTab.id] };
  }
  return { ok: true, groupId: null, tabs: [activeTab.id] };
}

async function toolTabsCreateMcp() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || typeof activeTab.id !== "number") {
    return { ok: false, error: "No active tab." };
  }
  const groupId = activeTab.groupId;
  // If tab is not in a group, create a group first
  if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const context = await toolTabsContextMcp({ createIfEmpty: true });
    return { ok: true, tabId: context.tabs?.[0] || null };
  }
  // Create a new tab in the current group
  const newTab = await chrome.tabs.create({ windowId: activeTab.windowId, url: "about:blank" });
  if (newTab.id) {
    await chrome.tabs.group({ tabIds: newTab.id, groupId });
  }
  return { ok: true, tabId: newTab.id };
}

async function ensureMcpGroup(tab) {
  // If tab is already in a group, use that group
  if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return tab.groupId;
  }
  // Create a new group for this tab
  const groupId = await chrome.tabs.group({ tabIds: tab.id });
  await chrome.tabGroups.update(groupId, {
    title: "Prompt Navigator",
    color: "blue"
  });
  return groupId;
}

async function toolUploadImage(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  const dataUrl = screenshotStore.get(args.imageId);
  if (!dataUrl) {
    return { ok: false, error: "Unknown imageId." };
  }
  if (args.coordinate) {
    return { ok: false, error: "Coordinate upload not implemented." };
  }
  if (!args.ref) {
    return { ok: false, error: "upload_image requires ref or coordinate." };
  }
  const filename = args.filename || "image.png";
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref, fileName, dataUrlValue) => {
      const map = window.__claudeElementMap;
      const entry = map?.[ref];
      const el = entry?.deref?.();
      if (!el) {
        return { ok: false, error: "Ref not found." };
      }
      const [meta, b64] = dataUrlValue.split(",");
      const mime = meta?.match(/data:(.*);base64/)?.[1] || "image/png";
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    },
    args: [args.ref, filename, dataUrl]
  });
  return result?.result || { ok: false, error: "Failed to upload image." };
}

async function toolReadConsole(args) {
  const tabId = args.tabId;
  const items = consoleBuffer.get(tabId) || [];
  const pattern = args.pattern ? new RegExp(args.pattern, "i") : null;
  const filtered = pattern
    ? items.filter((item) => pattern.test(item.text || "") || pattern.test(item.url || ""))
    : items;
  const onlyErrors = args.onlyErrors || false;
  const result = onlyErrors
    ? filtered.filter((item) => item.type === "error" || item.type === "exception")
    : filtered;
  const limit = clamp(args.limit || 100, 1, 500);
  const output = result.slice(-limit);
  if (args.clear) {
    consoleBuffer.set(tabId, []);
  }
  return { ok: true, messages: output };
}

async function toolReadNetwork(args) {
  const tabId = args.tabId;
  const items = networkBuffer.get(tabId) || [];
  const filtered = args.urlPattern
    ? items.filter((item) => item.url.includes(args.urlPattern))
    : items;
  const limit = clamp(args.limit || 100, 1, 500);
  const output = filtered.slice(-limit);
  if (args.clear) {
    networkBuffer.set(tabId, []);
  }
  return { ok: true, requests: output };
}

async function toolUserContext(args, fallbackTabId) {
  const now = new Date();
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const offsetMinutes = -now.getTimezoneOffset();
  const dateTimeIso = now.toISOString();
  const dateTimeLocal = now.toString();
  const timeoutMs = clamp(args?.timeoutMs || 5000, 1000, 20000);
  const tabId = await resolveTabId(args?.tabId, fallbackTabId);

  let location = { ok: false, source: "none", error: "Location unavailable." };
  if (tabId) {
    location = await getGeolocationFromTab(tabId, timeoutMs);
  }
  if (!location?.ok) {
    location = {
      ok: false,
      source: "timezone",
      error: location?.error || "Location unavailable without permission.",
      timeZone
    };
  }

  return {
    ok: true,
    dateTimeIso,
    dateTimeLocal,
    timeZone,
    locale,
    offsetMinutes,
    location
  };
}

async function toolResizeWindow(args) {
  const tabId = args.tabId;
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;
  await chrome.windows.update(windowId, { width: args.width, height: args.height });
  return { ok: true };
}

async function getGeolocationFromTab(tabId, timeoutMs) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (timeoutValue) =>
        new Promise((resolve) => {
          if (!("geolocation" in navigator)) {
            resolve({ ok: false, error: "Geolocation not supported." });
            return;
          }
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ ok: false, error: "Geolocation timed out." });
          }, timeoutValue);
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({
                ok: true,
                source: "geolocation",
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                altitude: pos.coords.altitude,
                heading: pos.coords.heading,
                speed: pos.coords.speed
              });
            },
            (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve({ ok: false, error: err.message || "Geolocation error.", code: err.code });
            },
            { enableHighAccuracy: false, maximumAge: 60000, timeout: timeoutValue }
          );
        }),
      args: [timeoutMs]
    });
    return result?.result || { ok: false, error: "Geolocation failed." };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function toolJavascript(args, fallbackTabId) {
  const tabId = await resolveTabId(args.tabId, fallbackTabId);
  if (!tabId) {
    return { ok: false, error: "No tab available." };
  }
  if (args.action !== "javascript_exec") {
    return { ok: false, error: "Invalid javascript_tool action." };
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (code) => {
      try {
        // eslint-disable-next-line no-eval
        const value = eval(code);
        return { ok: true, result: value };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    },
    args: [args.text]
  });
  return result?.result || { ok: false, error: "Execution failed." };
}

async function resolveTabId(requested, fallback) {
  if (typeof requested === "number") {
    return requested;
  }
  if (typeof fallback === "number") {
    return fallback;
  }
  // Get the active tab and use its group for resolution
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    return null;
  }
  const groupId = activeTab.groupId;
  // If active tab is in a group, prefer tabs from that group
  if (groupId && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const groupTabs = await chrome.tabs.query({ groupId });
    if (groupTabs.length) {
      const scriptable = groupTabs.find((tab) => isScriptableUrl(tab.url));
      const active = groupTabs.find((tab) => tab.active);
      return (scriptable || active || groupTabs[0]).id || null;
    }
  }
  return activeTab.id || null;
}

function isScriptableUrl(url) {
  if (!url) {
    return false;
  }
  const lowered = url.toLowerCase();
  if (lowered === "about:blank" || lowered === "about:srcdoc") {
    return true;
  }
  return !(
    lowered.startsWith("chrome://") ||
    lowered.startsWith("chrome-extension://") ||
    lowered.startsWith("edge://") ||
    lowered.startsWith("about:")
  );
}

async function ensureDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!String(error?.message || "").includes("already attached")) {
      throw error;
    }
  }
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
}

async function dispatchMouseClick(tabId, coordinate, button, clickCount) {
  await dispatchMouseMove(tabId, coordinate);
  await dispatchMousePress(tabId, coordinate, button, clickCount);
  await dispatchMouseRelease(tabId, coordinate, button, clickCount);
}

async function dispatchMousePress(tabId, coordinate, button, clickCount) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: button === 2 ? "right" : "left",
    x: coordinate[0],
    y: coordinate[1],
    clickCount
  });
}

async function dispatchMouseRelease(tabId, coordinate, button, clickCount) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: button === 2 ? "right" : "left",
    x: coordinate[0],
    y: coordinate[1],
    clickCount
  });
}

async function dispatchMouseMove(tabId, coordinate) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: coordinate[0],
    y: coordinate[1]
  });
}

async function dispatchMouseWheel(tabId, coordinate, deltaX, deltaY) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: coordinate[0],
    y: coordinate[1],
    deltaX,
    deltaY
  });
}

async function dispatchType(tabId, text) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
  } catch (error) {
    const message = error?.message || "";
    if (!message.includes("Invalid 'text' parameter")) {
      throw error;
    }
    for (const ch of text) {
      await dispatchKey(tabId, ch);
    }
  }
}

async function dispatchKey(tabId, key) {
  const keyText = String(key || "");
  const specialKeys = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }
  };
  const payload =
    specialKeys[keyText] ||
    (keyText.length === 1 ? { key: keyText, text: keyText, code: keyText, windowsVirtualKeyCode: keyText.charCodeAt(0) } : { key: keyText, code: keyText });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...payload
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...payload
  });
}

async function getViewportCenter(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => [window.innerWidth / 2, window.innerHeight / 2]
  });
  return result?.result || [0, 0];
}

async function resolveCoordinate(tabId, args) {
  if (args.coordinate) {
    return args.coordinate;
  }
  if (args.ref) {
    const rect = await scrollToRef(tabId, args.ref);
    if (rect?.center) {
      return rect.center;
    }
  }
  return getViewportCenter(tabId);
}

async function scrollToRef(tabId, ref) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (refId) => {
      const map = window.__claudeElementMap;
      const entry = map?.[refId];
      const el = entry?.deref?.();
      if (!el) {
        return { ok: false, error: "Ref not found." };
      }
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          center: [rect.x + rect.width / 2, rect.y + rect.height / 2]
        }
      };
    },
    args: [ref]
  });
  return result?.result?.rect || null;
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "back" || trimmed === "forward") {
    return trimmed;
  }
  if (!trimmed) {
    return "about:blank";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function pushBuffer(buffer, tabId, entry) {
  const list = buffer.get(tabId) || [];
  list.push(entry);
  if (list.length > 1000) {
    list.shift();
  }
  buffer.set(tabId, list);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function callOpenAI(apiKey, model, messages, tools, signal) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }
  return response.json();
}

async function callOpenAIStreaming(apiKey, model, messages, tools, signal, onDelta) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Streaming not supported by response body.");
  }

  let buffer = "";
  let content = "";
  const toolCalls = new Map();

  const flushEvent = (data) => {
    if (!data || data === "[DONE]") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onDelta) {
        onDelta(delta.content);
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index;
        if (typeof index !== "number") {
          continue;
        }
        const existing =
          toolCalls.get(index) || {
            id: call.id,
            type: call.type || "function",
            function: { name: call.function?.name || "", arguments: "" }
          };
        if (call.id) {
          existing.id = call.id;
        }
        if (call.function?.name) {
          existing.function.name = call.function.name;
        }
        if (call.function?.arguments) {
          existing.function.arguments += call.function.arguments;
        }
        toolCalls.set(index, existing);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += new TextDecoder().decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        flushEvent(data);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  const orderedToolCalls = Array.from(toolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);

  return {
    role: "assistant",
    content,
    tool_calls: orderedToolCalls.length ? orderedToolCalls : undefined
  };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
