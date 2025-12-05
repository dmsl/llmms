# ChatUCY Desktop - Copilot Instructions

## Project Overview

**ChatUCY Desktop** is an Electron application wrapping the LLM-MS (Large Language Model Meta Search) web interface with agentic AI capabilities via Model Context Protocol (MCP). The app bridges desktop tools with a university-hosted LLM backend.

### Architecture Layers

1. **Electron Main Process** (`main.js`) - MCP server orchestration, tool registry, update management
2. **Agent Engine** (`agent.js`) - Agentic loop with tool calling, schema validation, multi-format LLM output normalization
3. **Frontend** (`frontend/`) - Alpine.js UI with two chat interfaces (standard + LLM-MS)
4. **IPC Bridge** (`preload.js`) - Context-isolated communication between renderer and main process
5. **MCP Integration** (`mcp-client.js`, `mcp-local-server.js`, `tool-registry-bridge.js`) - Tool discovery and execution

---

## Critical Patterns & Conventions

### 1. **Tool Calling & Schema Validation**

The agent normalizes tool calls from multiple LLM formats (OpenAI, Claude, Ollama, etc.) via `normalizeToolCalls()` in `agent.js`:

```javascript
// Handles: message.tool_calls[], message.function_call, message.tool_call, message.actions, etc.
// Automatically repairs malformed JSON in arguments
const toolCalls = normalizeToolCalls(message);
```

**Key Pattern**: Always validate tool args against schema using Ajv before execution. Failed validations send corrective feedback to the LLM, not an error:

```javascript
const validation = validateToolSchema(name, args, inputSchema);
if (!validation.valid) {
  messages.push({
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify({ error: `Invalid arguments. Expected: ${validation.errors}` })
  });
}
```

### 2. **MCP Server Lifecycle**

Two MCP server types coexist:

- **Remote (WebSocket)**: `mcp-client.js` connects to external servers; auto-ingest tools on connection
- **Local (stdio)**: `mcp-local-server.js` spawns child processes; configured in `mcp.json`

**Config Location**: `app.getPath('userData')/mcp.json` (Windows: `%APPDATA%/chatucy-desktop/mcp.json`)

```json
{
  "servers": [
    { "name": "fs-tools", "type": "local", "autoConnect": true, "config": { "command": "node", "args": ["server.js"] } },
    { "name": "remote-api", "type": "remote", "url": "ws://api.example.com", "autoConnect": true }
  ],
  "enabledTools": { "tool.name": true }
}
```

### 3. **Tool Execution Path** (Critical)

```
Frontend askAgent() 
  → IPC calls desktop.runAgent()
  → main.js agent:run handler
  → runAgent() in agent.js (agentic loop)
  → toolRunner() executes tools via toolRegistryBridge.callMCPTool()
  → Results added to messages, loop continues until LLM stops tool calling
```

**Important**: The agentic loop runs in the **main process** (not frontend), but tool calls come from LLM responses. Schema validation happens before execution.

### 4. **Cross-Format LLM Output Handling**

Different models output tool calls differently. Always check multiple fields:

```javascript
// Try in order:
- message.tool_calls (OpenAI standard)
- message.function_call (legacy)
- message.tool_call (single call)
- message.tool / message.tools / message.actions (alternative formats)
```

The `repairJSON()` function auto-fixes common argument formatting issues (trailing commas, unquoted keys, etc.).

### 5. **Frontend-Backend Communication**

Two modes:

- **Electron**: Calls `desktop.runAgent()` IPC → agent runs in main process with full tool access
- **Web**: Calls `callLLM()` directly → agent runs on frontend (privacy-first, limited tools)

**File Handling**:
- **Images**: Converted to base64 for Ollama vision API
- **Documents**: Use RAG endpoint `/api/rag_chain` for semantic search

See `agent-integration.js` for unified `askAgent()` that handles both modes.

### 6. **UI Components (Alpine.js)**

All UI components return a single object from a factory function:

```javascript
// frontend/js/alpine-components/chat-app.js
export function chatApp() {
  return {
    messages: [],
    userInput: '',
    isLoading: false,
    selectedModel: 'llama3.2',
    async sendMessage() { ... },
    newChat() { ... }
  };
}
```

Used as: `<body x-data="chatApp()">` in HTML.

**Two Chat Interfaces**:
- `frontend/html/chat.html` - Standard chat with RAG
- `frontend/html/llmms.html` - LLM-MS with multi-model coordination + algorithm settings

---

## Developer Workflows

### Run Development Server

```powershell
# Terminal in desktop/
npm run dev
# Launches Electron with: __dirname = desktop/, frontend path = ./frontend/html/chat.html
```

### Build Desktop Installer

```powershell
npm run build
# Outputs: nsis installer (Windows only)
# electron-builder reads from package.json [build] config
```

### Check Tool Registry

Debug connected MCP tools via IPC handler in main.js:

```javascript
// In frontend DevTools console (Electron only):
window.desktop.getToolsByServer().then(console.log);
window.desktop.getEnabledTools().then(console.log);
```

### Modify Backend LLM Endpoint

All LLM calls go to: `https://chatucy.cs.ucy.ac.cy/openapi/v1/chat/completions`

Change in:
- `agent.js` line ~10: `BACKEND_URL` constant
- `agent-integration.js` line ~16: `BACKEND_API` constant

---

## Key Decision Points

### **When Adding New Tools**
1. Register in MCP server (local or remote)
2. Tool schema must be complete with `type`, `properties`, `required`
3. Update `enabledTools` in `mcp.json` or via UI toggle
4. Frontend will display in advanced settings panel

### **When Modifying Agentic Loop**
- Change max iterations: `agent.js` line ~330 `const maxIterations = ...`
- Change model behavior (LLaMA vs Mistral): `getModelBehavior()` function
- Validation rules: Edit `validateToolSchema()` or disable with schema-less tools

### **When Updating Frontend**
- Alpine.js 3.x required (CDN-only, no build)
- Tailwind utility classes (config in `tailwind.config.js`)
- All styling purged/minified at build time
- Avoid Bootstrap/jQuery (legacy not included in modern stack)

---

## Integration Points & Dependencies

| Component | Purpose | External Dependency |
|-----------|---------|---------------------|
| Backend LLM | Inference & tool definitions | POST to university Ollama API |
| MCP Servers | Tool providers | stdio or WebSocket protocols |
| Frontend | UI/UX | Alpine.js, Tailwind CSS, Marked.js |
| Electron | Desktop integration | Node.js runtime, IPC communication |
| electron-updater | Auto-updates | GitHub releases (AppImage/nsis) |

---

## Common Pitfalls

1. **Schema validation too strict**: LLMs often miss required fields → Use `validateToolSchema()` with helpful feedback, not rejection
2. **Serialization issues**: Tool execute() functions can't cross IPC → Store in `toolRegistryBridge`, call via `callMCPTool()`
3. **Path handling**: Electron dev vs packaged use different `__dirname` → Use the relative path logic in `main.js` createWindow()
4. **Tool registration timing**: MCP tools arrive async → Tools emit `mcp:tools-registered` event, frontend must listen
5. **Model-specific formats**: Some models output `null` for unused fields → Use `getModelBehavior()` for model-specific tuning

---

## File Reference

| File | Purpose |
|------|---------|
| `main.js` | Electron entry point, MCP orchestration, IPC handlers |
| `agent.js` | Agentic loop engine with tool validation & LLM normalization |
| `mcp-client.js` | WebSocket MCP client for remote servers |
| `mcp-local-server.js` | Child process spawner for local stdio MCP servers |
| `tool-registry-bridge.js` | Unified tool registry with enable/disable toggles |
| `preload.js` | Context-isolated IPC bridge for frontend |
| `frontend/js/agent-integration.js` | Frontend agentic loop, handles web & Electron modes |
| `frontend/js/alpine-components/chat-app.js` | Standard chat UI component |
| `package.json` | Dependencies, build config, Electron builder settings |

---

**Last Updated**: November 2025 | **Branch**: kkdev
