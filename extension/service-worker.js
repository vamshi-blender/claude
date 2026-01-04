const OPENAI_BASE_URL = "https://api.openai.com/v1";
const NATIVE_HOST = "com.vamshi.prompt_navigator";

const consoleBuffer = new Map();
const networkBuffer = new Map();
const screenshotStore = new Map();
let mcpGroupId = null;
let nativePort = null;
let nativeRequestId = 0;
const pendingMcpRequests = new Map();
let lastToolCall = null;

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("Failed to set side panel behavior", error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number") {
    return;
  }
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: `sidepanel.html?tabId=${encodeURIComponent(tab.id)}`,
    enabled: true
  });
  await chrome.sidePanel.open({ tabId: tab.id });
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
  lastToolCall = {
    ...tool,
    timestamp: Date.now()
  };
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
  const { history, tabId } = message;
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

  let tools = buildTools();
  try {
    const remoteTools = await mcpRequest("tools/list", {});
    if (remoteTools?.tools?.length) {
      tools = remoteTools.tools.map((toolDef) => ({
        type: "function",
        function: {
          name: toolDef.name,
          description: toolDef.description || "",
          parameters: toolDef.inputSchema || { type: "object", properties: {} }
        }
      }));
    }
  } catch (error) {
    // Fallback to local tool registry if native host is unavailable.
  }
  const systemMessage = {
    role: "system",
    content:
      "You are a browser automation agent. Use the available tools to navigate, " +
      "read pages, and interact with web content. If you need a tab id, use tabs_context " +
      "or tabs_context_mcp first."
  };

  const model = openaiModel || "gpt-4o-mini";
  let messages = [systemMessage, ...history];
  let loops = 0;

  while (loops < 6) {
    loops += 1;
    const response = await callOpenAI(openaiApiKey, model, messages, tools);
    const assistant = response?.choices?.[0]?.message;
    if (!assistant) {
      return { assistantMessage: "No response from model." };
    }

    messages = [...messages, assistant];

    const toolCalls = assistant.tool_calls || [];
    if (toolCalls.length === 0) {
      return { assistantMessage: assistant.content || "Done." };
    }

    for (const toolCall of toolCalls) {
      setLastTool({
        name: toolCall.function?.name || "unknown",
        args: safeParseJson(toolCall.function?.arguments || "{}") || {}
      });
      let result;
      try {
        result = await mcpRequest("tools/call", {
          name: toolCall.function?.name,
          arguments: safeParseJson(toolCall.function?.arguments || "{}") || {},
          tabId
        });
        console.log("[tool] MCP call", toolCall.function?.name, toolCall.function?.arguments);
      } catch (error) {
        console.warn("[tool] MCP failed, using local", toolCall.function?.name, error.message || error);
        result = await executeToolLocal(toolCall.function?.name, safeParseJson(toolCall.function?.arguments || "{}") || {}, tabId);
      }
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

  return { assistantMessage: "Stopped after too many tool calls." };
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
    const duration = clamp(args.duration || 1, 0, 30);
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
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
    if (!args.text) {
      return { ok: false, error: "type requires text." };
    }
    await dispatchType(tabId, args.text);
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
  let tabs;
  if (groupId && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    tabs = await chrome.tabs.query({ groupId });
  } else {
    tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  }
  return {
    ok: true,
    groupId: groupId || null,
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
  if (mcpGroupId === null) {
    if (args?.createIfEmpty) {
      const windowInfo = await chrome.windows.create({ url: "about:blank" });
      const tabId = windowInfo?.tabs?.[0]?.id;
      if (!tabId) {
        return { ok: false, error: "Failed to create MCP window." };
      }
      mcpGroupId = await chrome.tabs.group({ tabIds: tabId });
      return { ok: true, groupId: mcpGroupId, tabs: [tabId] };
    }
    return { ok: true, groupId: null, tabs: [] };
  }
  const tabs = await chrome.tabs.query({ groupId: mcpGroupId });
  return { ok: true, groupId: mcpGroupId, tabs: tabs.map((tab) => tab.id) };
}

async function toolTabsCreateMcp() {
  if (mcpGroupId === null) {
    const context = await toolTabsContextMcp({ createIfEmpty: true });
    return { ok: true, tabId: context.tabs?.[0] || null };
  }
  const tabs = await chrome.tabs.query({ groupId: mcpGroupId });
  if (!tabs.length) {
    const context = await toolTabsContextMcp({ createIfEmpty: true });
    return { ok: true, tabId: context.tabs?.[0] || null };
  }
  const newTab = await chrome.tabs.create({ windowId: tabs[0].windowId, url: "about:blank" });
  if (newTab.id) {
    await chrome.tabs.group({ tabIds: newTab.id, groupId: mcpGroupId });
  }
  return { ok: true, tabId: newTab.id };
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

async function toolResizeWindow(args) {
  const tabId = args.tabId;
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;
  await chrome.windows.update(windowId, { width: args.width, height: args.height });
  return { ok: true };
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
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id || null;
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
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
}

async function dispatchKey(tabId, key) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    text: key
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    text: key
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

async function callOpenAI(apiKey, model, messages, tools) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
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

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
