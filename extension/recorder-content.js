(function () {
  let isRecording = false;
  let isPaused = false;

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
    chrome.runtime.sendMessage({ type: "RECORDER_EVENT", step });
  }

  function captureClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    emitStep({
      type: "click",
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
    emitStep({
      type: "input",
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      selectors: buildSelectors(target),
      value: getInputValue(target)
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
  document.addEventListener("input", captureInput, true);
})();
