const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const optionsEl = document.getElementById("open-options");

const tabId = Number(new URLSearchParams(window.location.search).get("tabId"));
const historyKey = Number.isFinite(tabId) ? `history_tab_${tabId}` : "history_tab_default";

let history = [];

optionsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());
sendEl.addEventListener("click", () => handleSend());
promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
});

loadHistory().then(renderHistory).catch(() => {});

async function handleSend() {
  const text = promptEl.value.trim();
  if (!text) {
    return;
  }
  promptEl.value = "";
  addMessage({ role: "user", content: text });
  setStatus("Thinking...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHAT_REQUEST",
      history,
      tabId: Number.isFinite(tabId) ? tabId : null
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Request failed.");
    }

    const assistantMessage = response.result?.assistantMessage || "Done.";
    addMessage({ role: "assistant", content: assistantMessage });
    setStatus("");
  } catch (error) {
    addMessage({ role: "assistant", content: `Error: ${error.message}` });
    setStatus("Failed");
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
