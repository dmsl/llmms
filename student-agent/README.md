# ChatUCY Desktop - Claude-Style AI Coding Agent

A native desktop application that connects students' local MCP (Model Context Protocol) servers with your university's remote Ollama server, enabling secure local file access while leveraging powerful remote AI models.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────┐
│  Student Desktop (Tauri App)    │
│  ┌──────────────────────────┐  │
│  │  Web UI (HTML/JS)        │  │
│  │  Bootstrap + Chat UI     │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │  MCP Host Runtime (Rust) │  │
│  │  - Tool permissions      │  │
│  │  - Config management     │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │  Node.js MCP Bridge      │  │
│  │  - WebSocket client      │  │
│  │  - Stdio client          │  │
│  └──────────┬───────────────┘  │
└─────────────┼───────────────────┘
              │ MCP Protocol
              ▼
┌─────────────────────────────────┐
│  Local MCP Servers              │
│  - filesystem (ws://8765)       │
│  - git (ws://8766)              │
│  - python (ws://8767)           │
└─────────────┬───────────────────┘
              │ Tool Results
              ▼
┌─────────────────────────────────┐
│  University Ollama Server       │
│  - Agent loop                   │
│  - Tool-calling model           │
│  - FastAPI endpoints            │
└─────────────────────────────────┘
```

## 🚀 Quick Start

### For Developers

**Prerequisites:**
- Rust (https://rustup.rs/)
- Node.js 18+ (https://nodejs.org/)
- Visual Studio Build Tools (Windows) or webkit2gtk (Linux)

**Build:**
```bash
cd student-agent
npm install
cd mcp-bridge && npm install && cd ..

# Development mode
npm run tauri dev

# Production build (creates installers)
npm run tauri build
```

### For Students (End Users)

**Download and Install:**
1. Download the installer for your platform:
   - **Windows**: `ChatUCY Desktop_1.0.0_x64-setup.exe` (EXE) or `.msi`
   - **macOS**: `ChatUCY Desktop_1.0.0_x64.dmg`
   - **Linux**: `ChatUCY Desktop_1.0.0_amd64.AppImage`

2. Run the installer and follow the prompts

3. Launch ChatUCY Desktop from your Start Menu/Applications

**No manual dependency installation required!**

### Windows Installer Creation

See `WINDOWS_INSTALLER_GUIDE.md` for detailed instructions on:
- Building MSI and EXE installers
- Code signing
- Customization
- Distribution

### Start Server

```bash
cd ../backend
pip install fastapi uvicorn websockets httpx python-multipart
python -m app.main
```

Server runs on: `http://0.0.0.0:62828`

## 📖 Full Documentation

See the comprehensive guide above for:
- Architecture details
- Security model
- API reference
- Configuration options
- Troubleshooting

## 🎯 Key Features

✅ **Secure Local Tool Access** - Files never leave student's machine  
✅ **Permission System** - Approve/deny each write operation  
✅ **Multiple MCP Servers** - Filesystem, Git, Python, and custom tools  
✅ **Real-time Streaming** - See agent's reasoning as it works  
✅ **Cross-platform** - Windows, macOS, Linux installers  

## 🔧 Development

- **Frontend**: HTML/CSS/JS (Bootstrap) - `src/`
- **Backend**: Rust (Tauri) - `src-tauri/src/lib.rs`
- **MCP Bridge**: Node.js - `mcp-bridge/bridge.js`
- **Server**: Python (FastAPI) - `../backend/app/api/endpoints/mcp_agent.py`

## 📝 License

MIT License

---

**Built by DMSL @ University of Cyprus**
