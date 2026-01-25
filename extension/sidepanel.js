const messagesContainer = document.getElementById("messagesContainer");
const messageInput = document.getElementById("messageInput");
const messageTextarea = document.getElementById("messageTextarea");
const textareaWrapper = document.getElementById("textareaWrapper");
const inputArea = document.getElementById("inputArea");
const emptyState = document.getElementById("emptyState");
const messagesArea = document.getElementById("messagesArea");
const sendButton = document.getElementById("sendButton");
const clearButton = document.getElementById("clear-chat");
const openOptionsButton = document.getElementById("open-options");
const openRecorderButton = document.getElementById("open-recorder");
const recorderView = document.getElementById("recorder-view");
const chatView = document.getElementById("chatView");
const recorderCloseButton = document.getElementById("recorder-close");
const micButton = document.getElementById("micButton");
const micIcon = document.querySelector(".mic-icon");
const micStatus = document.getElementById("micStatus");
const aiImage = document.querySelector(".ai-image");
const botShadow = document.querySelector(".bot-shadow");

const recordStartEl = document.getElementById("record-start");
const recordStopEl = document.getElementById("record-stop");
const recordPlayEl = document.getElementById("record-play");
const recordClearEl = document.getElementById("record-clear");
const playbackSpeedEl = document.getElementById("playback-speed");
const recorderStatusEl = document.getElementById("recorder-status");
const recorderStepsListEl = document.getElementById("recorder-steps-list");

let isBusy = false;
let currentRequestId = null;
let history = [];
const streamingMessages = new Map();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let recorderPollTimer = null;
let recorderAutoScroll = true;
let currentPlaybackIndex = null;
let chatAutoScroll = true;
let toolPollTimer = null;
let lastToolSnapshot = null;
const toolCallGroups = new Map();
const toolCallItems = new Map();
let lastActiveRequestId = null;

const tabParam = new URLSearchParams(window.location.search).get("tabId");
const parsedTabId = tabParam ? Number(tabParam) : null;
const tabId = Number.isFinite(parsedTabId) ? parsedTabId : null;
const historyKey = tabId ? `history_tab_${tabId}` : "history_tab_default";

const assetUrl = (path) => {
  if (window.chrome && chrome.runtime && typeof chrome.runtime.getURL === "function") {
    return chrome.runtime.getURL(path);
  }
  return path;
};

const micIdleSrc = micIcon ? micIcon.getAttribute("src") || "assets/Mic.svg" : "";
const micRecordingSrc = "assets/Mic-recording.svg";
const defaultPlaceholder = messageInput ? messageInput.getAttribute("placeholder") || "" : "";
const listeningPlaceholder = "Listening...";
const micOnAudio = new Audio(assetUrl("assets/audio/MicON.mp3"));
const micOffAudio = new Audio(assetUrl("assets/audio/MicOFF.mp3"));
micOnAudio.preload = "auto";
micOffAudio.preload = "auto";
if (micIcon) {
  micIcon.setAttribute("src", assetUrl(micIdleSrc));
}

let isExpanded = false;
let isRecording = false;
let isChatActive = false;

function activateChatMode() {
  if (isChatActive) return;
  isChatActive = true;
  emptyState.classList.add("hidden");
  messagesArea.classList.add("active");
}

function resetChat() {
  history = [];
  streamingMessages.clear();
  messagesContainer.innerHTML = "";
  toolCallGroups.clear();
  toolCallItems.clear();
  lastToolSnapshot = null;
  isChatActive = false;
  emptyState.classList.remove("hidden");
  messagesArea.classList.remove("active");
  saveHistory().catch(() => {});
  chrome.runtime.sendMessage({ type: "RESET_TOOL_CALLS" }).catch(() => {});
}

function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true });
    return marked.parse(text || "");
  }
  return escapeHtml(text || "");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderMessage(message) {
  const messageDiv = document.createElement("div");
  messageDiv.classList.add("message", message.role === "assistant" ? "bot" : "user");

  const bubbleDiv = document.createElement("div");
  bubbleDiv.classList.add("message-bubble");

  const textDiv = document.createElement("div");
  textDiv.classList.add("message-text", "selectable");
  textDiv.innerHTML = renderMarkdown(message.content);

  bubbleDiv.appendChild(textDiv);
  messageDiv.appendChild(bubbleDiv);
  messagesContainer.appendChild(messageDiv);
  chatAutoScroll = true;
  scrollMessagesToBottom();

  return { messageDiv, textDiv };
}

function addMessage(message) {
  if (!message.content.trim()) return;
  if (!isChatActive) {
    activateChatMode();
  }
  history.push(message);
  saveHistory().catch(() => {});
  renderMessage(message);
}

function ensureStreamMessage(requestId) {
  if (!requestId) return null;
  const existing = streamingMessages.get(requestId);
  if (existing) return existing;

  const message = { role: "assistant", content: "" };
  history.push(message);
  const { textDiv } = renderMessage(message);
  const entry = { index: history.length - 1, textDiv, content: "" };
  streamingMessages.set(requestId, entry);
  return entry;
}

function handleStreamChunk(requestId, delta) {
  if (!delta) return;
  const entry = ensureStreamMessage(requestId);
  if (!entry) return;
  entry.content += delta;
  entry.textDiv.innerHTML = renderMarkdown(entry.content);
  scrollMessagesToBottom();
}

function updateStreamMessage(requestId, content, finalize) {
  const entry = ensureStreamMessage(requestId);
  if (!entry) return;
  entry.content = content;
  entry.textDiv.innerHTML = renderMarkdown(content);
  scrollMessagesToBottom();
  if (finalize) {
    history[entry.index].content = content;
    saveHistory().catch(() => {});
    streamingMessages.delete(requestId);
  }
}

function finalizeStream(requestId) {
  const entry = streamingMessages.get(requestId);
  if (!entry) return;
  entry.done = true;
}

function getToolGroup(requestId) {
  if (!requestId) {
    return null;
  }
  const existing = toolCallGroups.get(requestId);
  if (existing) {
    return existing;
  }

  const container = document.createElement("div");
  container.className = "tool-calls";

  const header = document.createElement("button");
  header.className = "tool-calls-header";
  header.type = "button";
  header.setAttribute("aria-expanded", "false");
  header.innerHTML = `<span>Tool calls (<span class="tool-calls-count">0</span>)</span><span class="tool-calls-chevron">▾</span>`;

  const content = document.createElement("div");
  content.className = "tool-calls-content collapsed";

  const list = document.createElement("div");
  list.className = "tool-calls-list";
  content.appendChild(list);

  header.addEventListener("click", () => {
    const isCollapsed = content.classList.contains("collapsed");
    content.classList.toggle("collapsed", !isCollapsed);
    header.setAttribute("aria-expanded", String(isCollapsed));
  });

  container.appendChild(header);
  container.appendChild(content);
  messagesContainer.appendChild(container);
  scrollMessagesToBottom();

  const group = {
    requestId,
    container,
    header,
    countEl: header.querySelector(".tool-calls-count"),
    list,
    content,
    count: 0
  };

  toolCallGroups.set(requestId, group);
  return group;
}

function addToolCallToGroup(requestId, call) {
  if (!requestId) {
    return;
  }
  const group = getToolGroup(requestId);
  if (!group) {
    return;
  }

  const item = document.createElement("div");
  item.className = "tool-call-item";
  const title = document.createElement("div");
  title.className = "tool-call-title";
  title.textContent = call.name || "Tool";
  item.appendChild(title);

  const argsBlock = document.createElement("pre");
  argsBlock.className = "tool-call-block";
  argsBlock.textContent = JSON.stringify(call.args, null, 2);
  item.appendChild(argsBlock);

  const responseBlock = document.createElement("pre");
  responseBlock.className = "tool-call-block is-pending";
  responseBlock.textContent = "Waiting...";
  item.appendChild(responseBlock);

  group.list.appendChild(item);
  group.count += 1;
  group.countEl.textContent = String(group.count);

  toolCallItems.set(call.sequence, { responseBlock, group });
  scrollMessagesToBottom();
}

function updateToolCallResponse(sequence, response) {
  const entry = toolCallItems.get(sequence);
  if (!entry) {
    return;
  }
  entry.responseBlock.classList.remove("is-pending");
  entry.responseBlock.textContent = JSON.stringify(response, null, 2);
  scrollMessagesToBottom();
}

async function pollToolCalls() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LAST_TOOL" });
    if (!response?.ok) {
      return;
    }
    const tool = response.tool;
    if (!tool) {
      return;
    }

    if (!lastToolSnapshot || tool.sequence !== lastToolSnapshot.sequence) {
      const requestId = currentRequestId || lastActiveRequestId || lastToolSnapshot?.requestId || "idle";
      addToolCallToGroup(requestId, tool);
      lastToolSnapshot = { ...tool, requestId };
      if (tool.response !== undefined) {
        updateToolCallResponse(tool.sequence, tool.response);
      }
      return;
    }

    if (
      tool.response !== undefined &&
      lastToolSnapshot.response === undefined &&
      tool.sequence === lastToolSnapshot.sequence
    ) {
      updateToolCallResponse(tool.sequence, tool.response);
      lastToolSnapshot = { ...tool, requestId: lastToolSnapshot.requestId };
    }
  } catch {
    // ignore polling errors
  }
}

function startToolPolling() {
  if (toolPollTimer) {
    return;
  }
  toolPollTimer = setInterval(() => {
    if (!recorderView.classList.contains("hidden")) {
      return;
    }
    pollToolCalls().catch(() => {});
  }, 1000);
}

function isMessagesNearBottom() {
  const { scrollTop, clientHeight, scrollHeight } = messagesContainer;
  return scrollTop + clientHeight >= scrollHeight - 8;
}

function scrollMessagesToBottom() {
  if (!chatAutoScroll) return;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function handleSend() {
  if (isBusy) return;
  const text = isExpanded ? messageTextarea.value.trim() : messageInput.value.trim();
  if (!text) return;

  addMessage({ role: "user", content: text });
  messageInput.value = "";
  messageTextarea.value = "";

  if (isExpanded) {
    collapseToInput();
  }

  isBusy = true;
  sendButton.disabled = true;
  currentRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  lastActiveRequestId = currentRequestId;

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
  } catch (error) {
    const errorMessage = `Error: ${error.message}`;
    if (currentRequestId && streamingMessages.has(currentRequestId)) {
      updateStreamMessage(currentRequestId, errorMessage, true);
    } else {
      addMessage({ role: "assistant", content: errorMessage });
    }
  } finally {
    isBusy = false;
    lastActiveRequestId = currentRequestId || lastActiveRequestId;
    currentRequestId = null;
    sendButton.disabled = false;
  }
}

function textExceedsInputWidth(text) {
  const span = document.createElement("span");
  const style = window.getComputedStyle(messageInput);
  span.style.font = style.font;
  span.style.fontSize = style.fontSize;
  span.style.visibility = "hidden";
  span.style.position = "absolute";
  span.style.whiteSpace = "nowrap";
  span.textContent = text;

  document.body.appendChild(span);
  const textWidth = span.offsetWidth;
  document.body.removeChild(span);

  const inputWidth = messageInput.offsetWidth;
  return textWidth > inputWidth - 10;
}

const transitionDuration =
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--transition-duration")) * 1000 || 300;

function expandToTextarea() {
  if (isExpanded) return;
  isExpanded = true;
  messageTextarea.value = messageInput.value;
  textareaWrapper.style.display = "block";

  requestAnimationFrame(() => {
    inputArea.classList.add("expanded");
    textareaWrapper.classList.add("visible");
    updateMicStatus();
    messageTextarea.focus();
    messageTextarea.setSelectionRange(messageTextarea.value.length, messageTextarea.value.length);
    updateTextareaHeight();
  });
}

function collapseToInput() {
  if (!isExpanded) return;
  isExpanded = false;
  messageInput.value = messageTextarea.value;
  inputArea.classList.remove("expanded");
  textareaWrapper.classList.remove("visible");
  updateMicStatus();

  setTimeout(() => {
    if (!isExpanded) {
      textareaWrapper.style.display = "none";
    }
  }, transitionDuration);

  messageInput.focus();
}

function updateTextareaHeight() {
  messageTextarea.style.height = "auto";
  const newHeight = Math.min(Math.max(messageTextarea.scrollHeight, 50), 72);
  messageTextarea.style.height = `${newHeight}px`;
}

function updateMicStatus() {
  if (!micStatus) return;
  if (isRecording && isExpanded) {
    micStatus.textContent = listeningPlaceholder;
    micStatus.classList.add("is-visible");
  } else {
    micStatus.textContent = "";
    micStatus.classList.remove("is-visible");
  }
}

function setRecordingState(nextState) {
  if (!micButton || !micIcon || !messageInput || !messageTextarea) return;
  isRecording = nextState;
  micButton.classList.toggle("is-recording", isRecording);
  micIcon.setAttribute("src", assetUrl(isRecording ? micRecordingSrc : micIdleSrc));
  micButton.setAttribute("aria-pressed", isRecording ? "true" : "false");

  if (isRecording) {
    if (!isExpanded) {
      messageInput.setAttribute("placeholder", listeningPlaceholder);
    }
    messageInput.disabled = true;
    messageTextarea.disabled = true;
  } else {
    messageInput.setAttribute("placeholder", defaultPlaceholder);
    messageInput.disabled = false;
    messageTextarea.disabled = false;
  }

  updateMicStatus();
}

function playMicSound(isOn) {
  const audio = isOn ? micOnAudio : micOffAudio;
  if (!audio) return;
  audio.currentTime = 0;
  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {});
  }
}

function showRecorderView(show) {
  recorderView.classList.toggle("hidden", !show);
  chatView.classList.toggle("hidden", show);
  if (show) {
    refreshRecorderSteps().catch(() => {});
  }
}

function initAiHover() {
  if (!aiImage) return;

  const updateShadowFromOffset = (offsetY) => {
    if (!botShadow) return;
    const baseWidth = 114;
    const baseHeight = 4;
    const minScale = 0.55;
    const maxScale = 1.35;
    const minHeightScale = 0.5;
    const maxHeightScale = 1.25;
    const minBlur = 2;
    const maxBlur = 9;
    const maxOffset = 6;
    const clamp = Math.max(-maxOffset, Math.min(maxOffset, offsetY));
    const closeness = (clamp + maxOffset) / (2 * maxOffset);
    const scale = minScale + (maxScale - minScale) * closeness;
    const heightScale = minHeightScale + (maxHeightScale - minHeightScale) * closeness;
    const blur = minBlur + (maxBlur - minBlur) * closeness;

    botShadow.style.width = `${(baseWidth * scale).toFixed(1)}px`;
    botShadow.style.height = `${(baseHeight * heightScale).toFixed(2)}px`;
    botShadow.style.filter = `blur(${blur.toFixed(2)}px)`;
  };

  const startHoverLoop = () => {
    if (aiImage.classList.contains("is-hovering")) return;
    aiImage.classList.add("is-hovering");
    if (botShadow) {
      botShadow.classList.remove("is-animating");
    }

    const maxY = 6;
    const maxRot = 10;
    const durationMin = 1800;
    const durationMax = 3200;
    let startY = 0;
    let startRot = 0;
    let targetY = 0;
    let targetRot = 0;
    let startTime = performance.now();
    let duration = durationMin;

    const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

    const pickTarget = () => {
      startY = targetY;
      startRot = targetRot;
      targetY = Math.random() * maxY * 2 - maxY;
      targetRot = (Math.random() < 0.5 ? -1 : 1) * (Math.random() * maxRot);
      startTime = performance.now();
      duration = durationMin + Math.random() * (durationMax - durationMin);
    };

    const updateHover = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeInOutSine(t);
      const hoverY = startY + (targetY - startY) * eased;
      const hoverRot = startRot + (targetRot - startRot) * eased;

      aiImage.style.setProperty("--hover-y", `${hoverY.toFixed(2)}px`);
      aiImage.style.setProperty("--hover-rot", `${hoverRot.toFixed(2)}deg`);
      updateShadowFromOffset(hoverY);

      if (t >= 1) {
        pickTarget();
      }

      requestAnimationFrame(updateHover);
    };

    pickTarget();
    requestAnimationFrame(updateHover);
  };

  if (reduceMotion) {
    aiImage.classList.remove("is-animating");
    aiImage.classList.add("is-hovering");
    updateShadowFromOffset(0);
    return;
  }

  aiImage.addEventListener(
    "animationend",
    (event) => {
      if (event.animationName === "bot-rise-spin") {
        aiImage.classList.remove("is-animating");
        if (botShadow) {
          botShadow.classList.remove("is-animating");
        }
        startHoverLoop();
      }
    },
    { once: true }
  );

  requestAnimationFrame(() => {
    aiImage.classList.add("is-animating");
    if (botShadow) {
      botShadow.classList.add("is-animating");
    }
  });
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

function renderHistory() {
  messagesContainer.innerHTML = "";
  if (history.length > 0) {
    activateChatMode();
  }
  for (const message of history) {
    renderMessage(message);
  }
  scrollMessagesToBottom();
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
  recorderAutoScroll = true;
  const speed = Number(playbackSpeedEl.value) || 1;
  await chrome.storage.local.set({ recorderPlaybackSpeed: speed });
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_PLAY", tabId, speed });
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
  const wasNearBottom = isRecorderNearBottom();
  const prevScrollTop = recorderStepsListEl.scrollTop;
  recorderStepsListEl.innerHTML = "";
  if (!response?.ok) {
    recorderStepsListEl.innerHTML = "<li>Unable to load steps.</li>";
    setRecorderControls({ isRecording: false, hasSteps: false });
    return;
  }
  const steps = response.result?.steps || [];
  const isRecordingNow = Boolean(response.result?.isRecording);
  setRecorderControls({ isRecording: isRecordingNow, hasSteps: steps.length > 0 });
  if (!steps.length) {
    recorderStepsListEl.innerHTML = "<li>No steps recorded.</li>";
    return;
  }
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const item = document.createElement("li");
    item.dataset.stepIndex = String(i);
    const labelMap = {
      click: "Click",
      double_click: "Double click",
      triple_click: "Triple click",
      right_click: "Right click",
      input: `Input: ${String(step.value).slice(0, 40)}`,
      select_change: `Select: ${String(step.value).slice(0, 40)}`,
      file_upload: `File upload: ${(step.files || []).join(", ") || "file"}`,
      keydown: `Key: ${step.key}`,
      focus: "Focus",
      blur: "Blur",
      hover: "Hover",
      scroll: "Scroll",
      submit: "Submit",
      drag_drop: "Drag and drop",
      navigate: `Navigate: ${step.url || ""}`,
      reload: "Reload",
      resize: `Resize: ${step.width}x${step.height}`,
      wait: `Wait: ${Math.round((step.durationMs || 0) / 100) / 10}s`
    };
    const label = labelMap[step.type] || step.type;
    const selector =
      step.selectors?.css ||
      step.selectors?.text ||
      step.targetSelectors?.css ||
      step.sourceSelectors?.css ||
      step.url ||
      "element";
    item.textContent = `${label} - ${selector}`;
    recorderStepsListEl.appendChild(item);
  }
  applyPlaybackHighlight();
  if (wasNearBottom) {
    recorderStepsListEl.scrollTo({ top: recorderStepsListEl.scrollHeight, behavior: "smooth" });
    recorderAutoScroll = true;
  } else {
    recorderStepsListEl.scrollTop = prevScrollTop;
  }
}

function setRecorderControls({ isRecording: isRecordingNow, hasSteps }) {
  recordStartEl.classList.toggle("hidden", isRecordingNow);
  recordStopEl.classList.toggle("hidden", !isRecordingNow);
  recordPlayEl.classList.toggle("hidden", isRecordingNow || !hasSteps);
  recordClearEl.classList.toggle("hidden", isRecordingNow || !hasSteps);
}

function handlePlaybackSpeedChange() {
  const speed = Number(playbackSpeedEl.value) || 1;
  chrome.storage.local.set({ recorderPlaybackSpeed: speed }).catch(() => {});
}

function handleRecorderScroll() {
  recorderAutoScroll = isRecorderNearBottom();
}

function isRecorderNearBottom() {
  const { scrollTop, clientHeight, scrollHeight } = recorderStepsListEl;
  return scrollTop + clientHeight >= scrollHeight - 8;
}

function applyPlaybackHighlight() {
  const items = recorderStepsListEl.querySelectorAll("li");
  for (const item of items) {
    item.classList.remove("recorder-step-active");
  }
  if (currentPlaybackIndex === null || currentPlaybackIndex === undefined) {
    return;
  }
  const active = recorderStepsListEl.querySelector(`li[data-step-index="${currentPlaybackIndex}"]`);
  if (active) {
    active.classList.add("recorder-step-active");
    if (recorderAutoScroll) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

function startRecorderPolling() {
  if (recorderPollTimer) return;
  recorderPollTimer = setInterval(() => {
    if (!recorderView.classList.contains("hidden")) {
      refreshRecorderSteps().catch(() => {});
    }
  }, 1000);
}

messageInput.addEventListener("input", (event) => {
  const text = event.target.value;
  if (textExceedsInputWidth(text)) {
    expandToTextarea();
  }
});

messageTextarea.addEventListener("input", (event) => {
  const text = event.target.value;
  updateTextareaHeight();
  if (text.trim() === "") {
    setTimeout(() => {
      if (messageTextarea.value.trim() === "") {
        collapseToInput();
      }
    }, 100);
  }
  messageInput.value = text;
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  } else if (event.key === "Enter" && event.shiftKey) {
    event.preventDefault();
    messageInput.value += "\n";
    expandToTextarea();
  }
});

messageTextarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
});

messageTextarea.addEventListener("blur", () => {
  if (messageTextarea.value.trim() === "") {
    setTimeout(() => {
      if (messageTextarea.value.trim() === "") {
        collapseToInput();
      }
    }, 100);
  }
});

sendButton.addEventListener("click", () => handleSend());
clearButton.addEventListener("click", () => resetChat());
openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
openRecorderButton.addEventListener("click", () => showRecorderView(true));
recorderCloseButton.addEventListener("click", () => showRecorderView(false));

if (micButton && micIcon && messageInput && messageTextarea) {
  micButton.addEventListener("click", () => {
    if (isRecording) {
      setRecordingState(false);
      playMicSound(false);
      return;
    }
    setRecordingState(true);
    playMicSound(true);
  });
}

if (recordStartEl) {
  recordStartEl.addEventListener("click", () => handleRecorderStart());
}
if (recordStopEl) {
  recordStopEl.addEventListener("click", () => handleRecorderStop());
}
if (recordPlayEl) {
  recordPlayEl.addEventListener("click", () => handleRecorderPlay());
}
if (recordClearEl) {
  recordClearEl.addEventListener("click", () => handleRecorderClear());
}
if (playbackSpeedEl) {
  playbackSpeedEl.addEventListener("change", () => handlePlaybackSpeedChange());
}
if (recorderStepsListEl) {
  recorderStepsListEl.addEventListener("scroll", () => handleRecorderScroll());
}

messagesContainer.addEventListener("scroll", () => {
  chatAutoScroll = isMessagesNearBottom();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CHAT_STREAM") {
    handleStreamChunk(message.requestId, message.delta);
  }
  if (message?.type === "CHAT_STREAM_DONE") {
    finalizeStream(message.requestId);
  }
  if (message?.type === "RECORDER_PLAYBACK_STEP") {
    if (tabId && message.tabId && tabId !== message.tabId) {
      return;
    }
    currentPlaybackIndex = message.index;
    applyPlaybackHighlight();
  }
  if (message?.type === "RECORDER_PLAYBACK_DONE") {
    if (tabId && message.tabId && tabId !== message.tabId) {
      return;
    }
    currentPlaybackIndex = null;
    applyPlaybackHighlight();
  }
});

Promise.all([loadHistory(), chrome.storage.local.get(["recorderPlaybackSpeed"])])
  .then(([, { recorderPlaybackSpeed }]) => {
    if (recorderPlaybackSpeed) {
      playbackSpeedEl.value = String(recorderPlaybackSpeed);
    }
    renderHistory();
  })
  .catch(() => {});

startRecorderPolling();
startToolPolling();
initAiHover();
