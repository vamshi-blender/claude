const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("open-options");
const clearEl = document.getElementById("clear-chat");
const lastToolEl = document.getElementById("last-tool");
const continueEl = document.getElementById("continue");
const tabChatEl = document.getElementById("tab-chat");
const tabRecorderEl = document.getElementById("tab-recorder");
const chatViewEl = document.getElementById("chat-view");
const recorderViewEl = document.getElementById("recorder-view");
const toolDebugEl = document.getElementById("tool-debug");
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
    addMessage({ role: "assistant", content: assistantMessage });
    setStatus("");
    if (response.result?.paused) {
      showContinue(true);
    }
  } catch (error) {
    addMessage({ role: "assistant", content: `Error: ${error.message}` });
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
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function updateLastTool() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_TOOL" });
    if (!response?.ok) {
      return;
    }
    lastToolEl.textContent = response.tool
      ? JSON.stringify(response.tool, null, 2)
      : "None";
  } catch {
    // ignore polling errors
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
  await chrome.storage.local.remove(historyKey);
  messagesEl.innerHTML = "";
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
    addMessage({ role: "assistant", content: assistantMessage });
    setStatus("");
    if (response.result?.paused) {
      showContinue(true);
    }
  } catch (error) {
    addMessage({ role: "assistant", content: `Error: ${error.message}` });
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
