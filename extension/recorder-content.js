(function () {
  let isRecording = false;
  let isPaused = false;
  let lastStepTime = null;
  let lastHoverTime = 0;
  let lastHoverTarget = null;
  let lastScrollTime = 0;
  let lastScrollPos = { x: 0, y: 0 };
  let lastDragSource = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "RECORDER_SET_ACTIVE") {
      isRecording = Boolean(message.active);
      isPaused = Boolean(message.paused);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "RECORDER_PING") {
      sendResponse({ ok: true, recording: isRecording, paused: isPaused });
      return true;
    }
  });

  function emitStep(step) {
    if (!isRecording || isPaused) {
      return;
    }
    const now = Date.now();
    if (lastStepTime && now - lastStepTime > 1000) {
      chrome.runtime.sendMessage({
        type: "RECORDER_EVENT",
        step: {
          type: "wait",
          durationMs: now - lastStepTime,
          timestamp: now
        }
      });
    }
    lastStepTime = now;
    chrome.runtime.sendMessage({ type: "RECORDER_EVENT", step });
  }

  function captureClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const clickType = event.detail >= 3 ? "triple_click" : event.detail === 2 ? "double_click" : "click";
    emitStep({
      type: clickType,
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      text: getTextSnippet(target)
    });
  }

  function captureRightClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    emitStep({
      type: "right_click",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      text: getTextSnippet(target)
    });
  }

  function captureInput(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && target.tagName !== "SELECT") {
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "file") {
      return;
    }
    emitStep({
      type: "input",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      value: getInputValue(target)
    });
  }

  function captureSelectChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    emitStep({
      type: "select_change",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      value: target.value
    });
  }

  function captureFileUpload(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "file") {
      return;
    }
    const files = Array.from(target.files || []).map((file) => file.name);
    emitStep({
      type: "file_upload",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      files
    });
  }

  function captureKeydown(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const isEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;
    if (isEditable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return;
    }
    emitStep({
      type: "keydown",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    });
  }

  function captureFocus(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    emitStep({
      type: "focus",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target)
    });
  }

  function captureBlur(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    emitStep({
      type: "blur",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target)
    });
  }

  function captureHover(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const now = Date.now();
    if (target !== lastHoverTarget) {
      lastHoverTarget = target;
      lastHoverTime = now;
      return;
    }
    if (now - lastHoverTime < 2000) {
      return;
    }
    lastHoverTime = now;
    emitStep({
      type: "hover",
      url: location.href,
      title: document.title,
      timestamp: now,
      selectors: buildSelectors(target),
      text: getTextSnippet(target)
    });
  }

  function captureScroll(event) {
    const now = Date.now();
    if (now - lastScrollTime < 400) {
      return;
    }
    lastScrollTime = now;
    const target = event.target;
    if (target === document || target === document.documentElement || target === document.body) {
      const x = window.scrollX;
      const y = window.scrollY;
      if (Math.abs(x - lastScrollPos.x) < 20 && Math.abs(y - lastScrollPos.y) < 20) {
        return;
      }
      lastScrollPos = { x, y };
      emitStep({
        type: "scroll",
        url: location.href,
        title: document.title,
        timestamp: now,
        target: "window",
        x,
        y
      });
      return;
    }
    if (target instanceof Element) {
      emitStep({
        type: "scroll",
        url: location.href,
        title: document.title,
        timestamp: now,
        selectors: buildSelectors(target),
        x: target.scrollLeft,
        y: target.scrollTop
      });
    }
  }

  function captureSubmit(event) {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) {
      return;
    }
    emitStep({
      type: "submit",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target)
    });
  }

  function captureDragStart(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    lastDragSource = target;
  }

  function captureDrop(event) {
    const target = event.target;
    if (!(target instanceof Element) || !lastDragSource) {
      return;
    }
    const source = lastDragSource;
    lastDragSource = null;
    emitStep({
      type: "drag_drop",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      sourceSelectors: buildSelectors(source),
      targetSelectors: buildSelectors(target)
    });
  }

  function captureResize() {
    emitStep({
      type: "resize",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      width: window.innerWidth,
      height: window.innerHeight
    });
  }

  function getInputValue(element) {
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") {
        return element.checked;
      }
      return element.value;
    }
    if (element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    if (element instanceof HTMLSelectElement) {
      return element.value;
    }
    return "";
  }

  function getTextSnippet(element) {
    const text = (element.textContent || "").trim().replace(/\s+/g, " ");
    if (!text) {
      return "";
    }
    return text.slice(0, 160);
  }

  function buildSelectors(element) {
    return {
      css: getCssSelector(element),
      xpath: getXPath(element),
      aria: getAriaSelector(element),
      text: getTextSnippet(element),
      pierce: getPierceSelector(element)
    };
  }

  function getCssSelector(element) {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }
    const path = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() !== "html") {
      let selector = node.tagName.toLowerCase();
      if (node.classList.length) {
        selector += "." + Array.from(node.classList).slice(0, 3).map(cssEscape).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      path.unshift(selector);
      node = node.parentElement;
    }
    return path.join(" > ");
  }

  function getXPath(element) {
    const segments = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      const siblings = node.parentNode
        ? Array.from(node.parentNode.children).filter((child) => child.tagName === node.tagName)
        : [];
      const index = siblings.length > 1 ? `[${siblings.indexOf(node) + 1}]` : "";
      segments.unshift(`${tagName}${index}`);
      node = node.parentElement;
    }
    return "/" + segments.join("/");
  }

  function getAriaSelector(element) {
    const role = element.getAttribute("role");
    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("aria-labelledby") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      "";
    return role || label ? { role: role || "", label: label || "" } : null;
  }

  function getPierceSelector(element) {
    const segments = [];
    let node = element;
    while (node) {
      if (node instanceof ShadowRoot) {
        node = node.host;
      }
      if (!(node instanceof Element)) {
        break;
      }
      const part = node.id ? `#${cssEscape(node.id)}` : node.tagName.toLowerCase();
      segments.unshift(part);
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        segments.unshift(">>>");
        node = root.host;
      } else {
        node = node.parentElement;
      }
    }
    return segments.join(" ");
  }

  function cssEscape(value) {
    return value.replace(/([\\.#:[\\]()=+~*'\"\\s>])/g, "\\$1");
  }

  document.addEventListener("click", captureClick, true);
  document.addEventListener("contextmenu", captureRightClick, true);
  document.addEventListener("input", captureInput, true);
  document.addEventListener("change", captureSelectChange, true);
  document.addEventListener("change", captureFileUpload, true);
  document.addEventListener("keydown", captureKeydown, true);
  document.addEventListener("focusin", captureFocus, true);
  document.addEventListener("focusout", captureBlur, true);
  document.addEventListener("mouseover", captureHover, true);
  document.addEventListener("scroll", captureScroll, true);
  document.addEventListener("submit", captureSubmit, true);
  document.addEventListener("dragstart", captureDragStart, true);
  document.addEventListener("drop", captureDrop, true);
  window.addEventListener("resize", captureResize, true);
})();
