# Native MCP Host (Node)

This folder contains a minimal native messaging host that implements MCP
`tools/list` and `tools/call` and forwards tool execution to the extension.

## Setup (Windows)

1) Copy `host-manifest.example.json` to a real manifest location, update:
- `path` to the absolute path of `host.js`
- `allowed_origins` with your extension ID

Example location for native messaging host manifest:
- `HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.vamshi.prompt_navigator`
  with the default value pointing to the manifest file path.

2) Make sure Node is installed and `host.js` is executable by Node.

3) Reload the extension. The service worker will connect to:
`com.vamshi.prompt_navigator`.
