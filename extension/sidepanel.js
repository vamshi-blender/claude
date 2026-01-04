const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("open-options");
const clearEl = document.getElementById("clear-chat");
const lastToolEl = document.getElementById("last-tool");
const continueEl = document.getElementById("continue");

let isBusy = false;
let currentRequestId = null;

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
