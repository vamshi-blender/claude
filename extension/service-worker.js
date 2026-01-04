const OPENAI_BASE_URL = "https://api.openai.com/v1";

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

  const tools = [
    {
      type: "function",
      function: {
        name: "navigate_to_url",
        description: "Navigate the active tab to a URL.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The absolute URL to navigate to."
            }
          },
          required: ["url"]
        }
      }
    }
  ];

  const systemMessage = {
    role: "system",
    content:
      "You are a browser automation agent. For now, only navigate to URLs. " +
      "Always use the navigate_to_url tool when the user asks to open a link. " +
      "After navigation succeeds, reply with a short success message."
  };

  const model = openaiModel || "gpt-4o-mini";
  const initialResponse = await callOpenAI(openaiApiKey, model, [systemMessage, ...history], tools);

  const toolCall = initialResponse?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return {
      assistantMessage: initialResponse?.choices?.[0]?.message?.content || "No tool call."
    };
  }

  if (toolCall.function?.name !== "navigate_to_url") {
    throw new Error(`Unsupported tool: ${toolCall.function?.name}`);
  }

  const args = safeParseJson(toolCall.function.arguments);
  if (!args?.url || typeof args.url !== "string") {
    throw new Error("Missing URL for navigation.");
  }

  if (typeof tabId !== "number") {
    throw new Error("Missing tab id for navigation.");
  }

  await chrome.tabs.update(tabId, { url: args.url });

  const toolResultMessage = {
    role: "tool",
    tool_call_id: toolCall.id,
    content: `Navigation to ${args.url} succeeded.`
  };

  const followUpResponse = await callOpenAI(
    openaiApiKey,
    model,
    [systemMessage, ...history, initialResponse.choices[0].message, toolResultMessage],
    tools
  );

  return {
    assistantMessage: followUpResponse?.choices?.[0]?.message?.content || "Navigation complete."
  };
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
