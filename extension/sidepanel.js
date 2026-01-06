const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("open-options");
const clearEl = document.getElementById("clear-chat");
const continueEl = document.getElementById("continue");
const tabChatEl = document.getElementById("tab-chat");
const tabRecorderEl = document.getElementById("tab-recorder");
const chatViewEl = document.getElementById("chat-view");
const recorderViewEl = document.getElementById("recorder-view");
const toolDebugEl = document.getElementById("tool-debug");
const toolDebugToggle = document.getElementById("tool-debug-toggle");
const toolDebugContent = document.getElementById("tool-debug-content");
const toolCallsList = document.getElementById("tool-calls-list");
const recorderLoginEl = document.getElementById("recorder-login");
const recorderPanelEl = document.getElementById("recorder-panel");
const recorderEmailEl = document.getElementById("recorder-email");
const recorderPasswordEl = document.getElementById("recorder-password");
const recorderLoginBtn = document.getElementById("recorder-login-btn");
const recordStartEl = document.getElementById("record-start");
const recordStopEl = document.getElementById("record-stop");
const recordPlayEl = document.getElementById("record-play");
const recordClearEl = document.getElementById("record-clear");
const recorderStatusEl = document.getElementById("recorder-status");
const recorderStepsListEl = document.getElementById("recorder-steps-list");

let isBusy = false;
let currentRequestId = null;
let recorderPollTimer = null;
let toolCalls = [];
let lastToolCall = null;
const streamingMessages = new Map();

const tabParam = new URLSearchParams(window.location.search).get("tabId");
const parsedTabId = tabParam ? Number(tabParam) : null;
const tabId = Number.isFinite(parsedTabId) ? parsedTabId : null;
const historyKey = tabId ? `history_tab_${tabId}` : "history_tab_default";

let history = [];

optionsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());
clearEl.addEventListener("click", () => clearChat());
sendEl.addEventListener("click", () => {
  if (isBusy) {
    handlePause();
    return;
  }
  handleSend();
});
continueEl.addEventListener("click", () => handleContinue());
tabChatEl.addEventListener("click", () => switchTab("chat"));
tabRecorderEl.addEventListener("click", () => switchTab("recorder"));
toolDebugToggle.addEventListener("click", () => toggleToolDebug());
recorderLoginBtn.addEventListener("click", () => handleRecorderLogin());
recordStartEl.addEventListener("click", () => handleRecorderStart());
recordStopEl.addEventListener("click", () => handleRecorderStop());
recordPlayEl.addEventListener("click", () => handleRecorderPlay());
recordClearEl.addEventListener("click", () => handleRecorderClear());
promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (isBusy) {
      handlePause();
      return;
    }
    handleSend();
  }
});

loadHistory().then(renderHistory).catch(() => {});
setInterval(updateLastTool, 1000);
initRecorderView();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CHAT_STREAM") {
    handleStreamChunk(message.requestId, message.delta);
  }
  if (message?.type === "CHAT_STREAM_DONE") {
    finalizeStream(message.requestId);
  }
});

async function handleSend() {
  if (isBusy) {
    return;
  }
  const text = promptEl.value.trim();
  if (!text) {
    return;
  }
  promptEl.value = "";
  addMessage({ role: "user", content: text });
  setStatus("Thinking...");
  isBusy = true;
  currentRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sendEl.textContent = "Pause";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHAT_REQUEST",
      history,
      tabId,
      requestId: currentRequestId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Request failed.");
    }

    const assistantMessage = response.result?.assistantMessage || "Done.";
    if (currentRequestId && streamingMessages.has(currentRequestId)) {
      updateStreamMessage(currentRequestId, assistantMessage, true);
    } else {
      addMessage({ role: "assistant", content: assistantMessage });
    }
    setStatus("");
    if (response.result?.paused) {
      showContinue(true);
    }
  } catch (error) {
    if (currentRequestId && streamingMessages.has(currentRequestId)) {
      updateStreamMessage(currentRequestId, `Error: ${error.message}`, true);
    } else {
      addMessage({ role: "assistant", content: `Error: ${error.message}` });
    }
    setStatus("Failed");
  } finally {
    isBusy = false;
    currentRequestId = null;
    sendEl.textContent = "Send";
  }
}

function addMessage(message) {
  history.push(message);
  saveHistory().catch(() => {});
  renderMessage(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory() {
  messagesEl.innerHTML = "";
  for (const message of history) {
    renderMessage(message);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const row = document.createElement("div");
  row.className = `message ${message.role}`;
  row.textContent = message.content;
  messagesEl.appendChild(row);
  return row;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function toggleToolDebug() {
  const isCollapsed = toolDebugContent.classList.contains("collapsed");
  const arrow = toolDebugToggle.querySelector(".tool-debug-arrow");

  if (isCollapsed) {
    toolDebugContent.classList.remove("collapsed");
    arrow.classList.add("expanded");
  } else {
    toolDebugContent.classList.add("collapsed");
    arrow.classList.remove("expanded");
  }
}

async function updateLastTool() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_TOOL" });
    if (!response?.ok) {
      return;
    }
    const tool = response.tool;
    if (!tool) {
      return;
    }

    // Check if this is a new tool call or an update with response
    if (!lastToolCall || tool.timestamp !== lastToolCall.timestamp) {
      // New tool call
      lastToolCall = tool;
      toolCalls.push({ ...tool });
      // Limit to last 50 tool calls
      if (toolCalls.length > 50) {
        toolCalls.shift();
      }
      renderToolCalls();
    } else if (tool.response !== undefined && lastToolCall.response === undefined) {
      // Update with response
      lastToolCall = tool;
      const index = toolCalls.findIndex(c => c.timestamp === tool.timestamp);
      if (index !== -1) {
        toolCalls[index] = { ...tool };
        renderToolCalls();
      }
    }
  } catch {
    // ignore polling errors
  }
}

function renderToolCalls() {
  if (toolCalls.length === 0) {
    toolCallsList.innerHTML = '<div style="padding: 8px; color: #6d6b66;">No tool calls yet</div>';
    return;
  }

  toolCallsList.innerHTML = "";
  // Show oldest first (chronological order)
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    const item = document.createElement("div");
    item.className = "tool-call-item";

    const header = document.createElement("div");
    header.className = "tool-call-header";
    const sequenceNum = call.sequence || (i + 1);
    header.textContent = `#${sequenceNum} - ${call.name}`;
    item.appendChild(header);

    const argsSection = document.createElement("div");
    argsSection.className = "tool-call-section";
    const argsLabel = document.createElement("div");
    argsLabel.className = "tool-call-label";
    argsLabel.textContent = "Arguments:";
    argsSection.appendChild(argsLabel);
    const argsData = document.createElement("div");
    argsData.className = "tool-call-data";
    argsData.textContent = JSON.stringify(call.args, null, 2);
    argsSection.appendChild(argsData);
    item.appendChild(argsSection);

    if (call.response !== null && call.response !== undefined) {
      const responseSection = document.createElement("div");
      responseSection.className = "tool-call-section";
      const responseLabel = document.createElement("div");
      responseLabel.className = "tool-call-label";
      responseLabel.textContent = "Response:";
      responseSection.appendChild(responseLabel);
      const responseData = document.createElement("div");
      responseData.className = "tool-call-data";
      responseData.textContent = JSON.stringify(call.response, null, 2);
      responseSection.appendChild(responseData);
      item.appendChild(responseSection);
    } else {
      const loadingSection = document.createElement("div");
      loadingSection.className = "tool-call-section";
      const loadingLabel = document.createElement("div");
      loadingLabel.className = "tool-call-label";
      loadingLabel.textContent = "Response:";
      loadingSection.appendChild(loadingLabel);
      const loadingData = document.createElement("div");
      loadingData.className = "tool-call-data";
      loadingData.style.fontStyle = "italic";
      loadingData.style.color = "#6d6b66";
      loadingData.textContent = "Waiting...";
      loadingSection.appendChild(loadingData);
      item.appendChild(loadingSection);
    }

    toolCallsList.appendChild(item);
  }
}

async function loadHistory() {
  const stored = await chrome.storage.local.get(historyKey);
  const value = stored[historyKey];
  if (Array.isArray(value)) {
    history = value;
  }
}

async function saveHistory() {
  await chrome.storage.local.set({ [historyKey]: history });
}

async function clearChat() {
  if (isBusy) {
    await handlePause();
  }
  history = [];
  toolCalls = [];
  lastToolCall = null;
  streamingMessages.clear();
  await chrome.runtime.sendMessage({ type: "RESET_TOOL_CALLS" });
  await chrome.storage.local.remove(historyKey);
  messagesEl.innerHTML = "";
  renderToolCalls();
  setStatus("");
  showContinue(false);
}

async function handleContinue() {
  if (isBusy) {
    return;
  }
  showContinue(false);
  addMessage({ role: "user", content: "Continue" });
  setStatus("Thinking...");
  isBusy = true;
  currentRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sendEl.textContent = "Pause";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHAT_REQUEST",
      history,
      tabId,
      requestId: currentRequestId
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Request failed.");
    }
    const assistantMessage = response.result?.assistantMessage || "Done.";
    if (currentRequestId && streamingMessages.has(currentRequestId)) {
      updateStreamMessage(currentRequestId, assistantMessage, true);
    } else {
      addMessage({ role: "assistant", content: assistantMessage });
    }
    setStatus("");
    if (response.result?.paused) {
      showContinue(true);
    }
  } catch (error) {
    if (currentRequestId && streamingMessages.has(currentRequestId)) {
      updateStreamMessage(currentRequestId, `Error: ${error.message}`, true);
    } else {
      addMessage({ role: "assistant", content: `Error: ${error.message}` });
    }
    setStatus("Failed");
  } finally {
    isBusy = false;
    currentRequestId = null;
    sendEl.textContent = "Send";
  }
}

function showContinue(show) {
  continueEl.classList.toggle("hidden", !show);
}

function ensureStreamMessage(requestId) {
  if (!requestId) {
    return null;
  }
  const existing = streamingMessages.get(requestId);
  if (existing) {
    return existing;
  }
  const message = { role: "assistant", content: "" };
  history.push(message);
  const row = renderMessage(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const entry = { index: history.length - 1, row, content: "" };
  streamingMessages.set(requestId, entry);
  return entry;
}

function handleStreamChunk(requestId, delta) {
  if (!delta) {
    return;
  }
  const entry = ensureStreamMessage(requestId);
  if (!entry) {
    return;
  }
  entry.content += delta;
  entry.row.textContent = entry.content;
}

function updateStreamMessage(requestId, content, finalize) {
  const entry = ensureStreamMessage(requestId);
  if (!entry) {
    return;
  }
  entry.content = content;
  entry.row.textContent = content;
  if (finalize) {
    history[entry.index].content = content;
    saveHistory().catch(() => {});
    streamingMessages.delete(requestId);
  }
}

function finalizeStream(requestId) {
  const entry = streamingMessages.get(requestId);
  if (!entry) {
    return;
  }
  entry.done = true;
}

async function handlePause() {
  if (!isBusy || !currentRequestId) {
    return;
  }
  await chrome.runtime.sendMessage({ type: "CANCEL_REQUEST", requestId: currentRequestId });
  setStatus("Paused");
  showContinue(true);
}

function switchTab(name) {
  const isChat = name === "chat";
  tabChatEl.classList.toggle("active", isChat);
  tabRecorderEl.classList.toggle("active", !isChat);
  chatViewEl.classList.toggle("hidden", !isChat);
  toolDebugEl.classList.toggle("hidden", !isChat);
  recorderViewEl.classList.toggle("hidden", isChat);
  if (!isChat) {
    refreshRecorderSteps().catch(() => {});
  }
}

async function initRecorderView() {
  const { recorderLoggedIn } = await chrome.storage.local.get(["recorderLoggedIn"]);
  if (recorderLoggedIn) {
    showRecorderPanel();
  } else {
    showRecorderLogin();
  }
  await refreshRecorderSteps();
  startRecorderPolling();
}

function showRecorderLogin() {
  recorderLoginEl.classList.remove("hidden");
  recorderPanelEl.classList.add("hidden");
}

function showRecorderPanel() {
  recorderLoginEl.classList.add("hidden");
  recorderPanelEl.classList.remove("hidden");
}

async function handleRecorderLogin() {
  const email = recorderEmailEl.value.trim();
  const password = recorderPasswordEl.value.trim();
  if (!email || !password) {
    recorderStatusEl.textContent = "Enter email and password.";
    return;
  }
  await chrome.storage.local.set({ recorderLoggedIn: true, recorderUser: email });
  recorderStatusEl.textContent = "Signed in.";
  showRecorderPanel();
  await refreshRecorderSteps();
}

async function handleRecorderStart() {
  recorderStatusEl.textContent = "Recording...";
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_START", tabId });
  if (!response?.ok) {
    recorderStatusEl.textContent = `Error: ${response?.error || "Failed"}`;
    return;
  }
  await refreshRecorderSteps();
}

async function handleRecorderStop() {
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_STOP", tabId });
  if (!response?.ok) {
    recorderStatusEl.textContent = `Error: ${response?.error || "Failed"}`;
    return;
  }
  recorderStatusEl.textContent = "Stopped.";
  await refreshRecorderSteps();
}

async function handleRecorderPlay() {
  recorderStatusEl.textContent = "Playing...";
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_PLAY", tabId });
  if (!response?.ok) {
    recorderStatusEl.textContent = `Error: ${response?.error || "Failed"}`;
    return;
  }
  recorderStatusEl.textContent = "Playback complete.";
}

async function handleRecorderClear() {
  await chrome.runtime.sendMessage({ type: "RECORDER_CLEAR", tabId });
  recorderStatusEl.textContent = "Cleared.";
  await refreshRecorderSteps();
}

async function refreshRecorderSteps() {
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_GET", tabId });
  recorderStepsListEl.innerHTML = "";
  if (!response?.ok) {
    recorderStepsListEl.innerHTML = "<li>Unable to load steps.</li>";
    setRecorderControls({ isRecording: false, hasSteps: false });
    return;
  }
  const steps = response.result?.steps || [];
  const isRecording = Boolean(response.result?.isRecording);
  setRecorderControls({ isRecording, hasSteps: steps.length > 0 });
  if (!steps.length) {
    recorderStepsListEl.innerHTML = "<li>No steps recorded.</li>";
    return;
  }
  for (const step of steps) {
    const item = document.createElement("li");
    const label = step.type === "input" ? `Input: ${String(step.value).slice(0, 40)}` : "Click";
    const selector = step.selectors?.css || step.selectors?.text || "element";
    item.textContent = `${label} - ${selector}`;
    recorderStepsListEl.appendChild(item);
  }
}

function setRecorderControls({ isRecording, hasSteps }) {
  recordStartEl.classList.toggle("hidden", isRecording);
  recordStopEl.classList.toggle("hidden", !isRecording);
  recordPlayEl.classList.toggle("hidden", isRecording || !hasSteps);
  recordClearEl.classList.toggle("hidden", isRecording || !hasSteps);
}

function startRecorderPolling() {
  if (recorderPollTimer) {
    return;
  }
  recorderPollTimer = setInterval(() => {
    if (!recorderViewEl.classList.contains("hidden")) {
      refreshRecorderSteps().catch(() => {});
    }
  }, 1000);
}
