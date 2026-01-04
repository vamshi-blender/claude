#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const toolsPath = path.join(__dirname, "tools.json");
const tools = JSON.parse(fs.readFileSync(toolsPath, "utf8"));
const pendingToolCalls = new Map();
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) {
      return;
    }
    const messageBuffer = buffer.slice(4, 4 + length);
    buffer = buffer.slice(4 + length);
    try {
      const message = JSON.parse(messageBuffer.toString("utf8"));
      handleMessage(message);
    } catch (error) {
      sendMessage({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Invalid JSON payload." }
      });
    }
  }
});

function sendMessage(message) {
  const json = JSON.stringify(message);
  const buffer = Buffer.alloc(4 + Buffer.byteLength(json));
  buffer.writeUInt32LE(Buffer.byteLength(json), 0);
  buffer.write(json, 4);
  process.stdout.write(buffer);
}

function handleMessage(message) {
  if (message?.type === "ping") {
    return sendMessage({ type: "pong" });
  }
  if (message?.type === "TOOL_RESULT") {
    const pending = pendingToolCalls.get(message.requestId);
    if (pending) {
      pendingToolCalls.delete(message.requestId);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }
  if (message?.jsonrpc === "2.0" && message.method) {
    return handleMcp(message);
  }
}

async function handleMcp(message) {
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      return sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "prompt-navigator", version: "0.1.0" }
        }
      });
    }
    if (method === "tools/list") {
      return sendMessage({
        jsonrpc: "2.0",
        id,
        result: { tools }
      });
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const requestId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await requestToolExecution(requestId, name, args);
      return sendMessage({
        jsonrpc: "2.0",
        id,
        result
      });
    }
    return sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` }
    });
  } catch (error) {
    return sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: error.message || String(error) }
    });
  }
}

function requestToolExecution(requestId, toolName, args) {
  return new Promise((resolve, reject) => {
    pendingToolCalls.set(requestId, { resolve, reject });
    sendMessage({
      type: "EXECUTE_TOOL",
      requestId,
      toolName,
      args
    });
    setTimeout(() => {
      if (pendingToolCalls.has(requestId)) {
        pendingToolCalls.delete(requestId);
        reject(new Error("Tool execution timed out."));
      }
    }, 30000);
  });
}
