# ChatUCY Desktop - Complete Setup Guide

This guide walks through setting up the complete Claude-Desktop-style AI coding agent system from scratch.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Server Setup](#server-setup)
3. [Desktop App Setup](#desktop-app-setup)
4. [MCP Server Setup](#mcp-server-setup)
5. [Testing the Complete System](#testing-the-complete-system)
6. [Deployment](#deployment)
7. [Common Issues](#common-issues)

---

## System Requirements

### University Server
- **OS**: Linux (Ubuntu 20.04+ recommended)
- **RAM**: 16GB minimum (for Ollama models)
- **GPU**: NVIDIA GPU with 8GB+ VRAM (optional but recommended)
- **Storage**: 50GB for models
- **Ports**: 62828 (API), 11434 (Ollama)

### Student Desktop
- **OS**: Windows 10+, macOS 10.15+, or Linux
- **RAM**: 4GB minimum
- **Storage**: 500MB for app
- **Network**: Internet connection to university server

---

## Server Setup

### Step 1: Install Ollama

```bash
# Download and install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a tool-calling capable model
ollama pull llama3.2:latest
# or
ollama pull qwen2.5:latest
```

### Step 2: Install Python Dependencies

```bash
cd /path/to/chatucy_app/backend

# Create virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install fastapi uvicorn websockets httpx python-multipart pydantic
```

### Step 3: Configure the Server

Edit `backend/app/main.py` to set your host and port:

```python
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 62828))
    host = os.environ.get("HOST", "0.0.0.0")  # Listen on all interfaces
    
    uvicorn.run("app.main:app", host=host, port=port, reload=True)
```

### Step 4: Start the Server

```bash
cd backend
python -m app.main
```

You should see:
```
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:62828
```

### Step 5: Test the Server

```bash
# In another terminal
curl http://localhost:62828/api/mcp/sessions

# Expected response:
# {"sessions": []}
```

---

## Desktop App Setup

### Step 1: Install Prerequisites

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**macOS:**
```bash
# Install Xcode Command Line Tools
xcode-select --install
```

**Windows:**
- Install [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- Install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 10+)

### Step 2: Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Verify installation
rustc --version
cargo --version
```

### Step 3: Install Node.js

**Linux:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**macOS:**
```bash
brew install node@18
```

**Windows:**
Download from https://nodejs.org/

**Verify:**
```bash
node --version  # Should be v18+
npm --version
```

### Step 4: Build the Desktop App

```bash
cd /path/to/chatucy_app/student-agent

# Install frontend dependencies
npm install

# Install MCP bridge dependencies
cd mcp-bridge
npm install
cd ..

# Build Tauri app
npm run tauri build
```

**Build Output:**

- **Linux**: `src-tauri/target/release/bundle/appimage/student-agent_*.AppImage`
- **macOS**: `src-tauri/target/release/bundle/dmg/student-agent_*.dmg`
- **Windows**: `src-tauri/target/release/bundle/msi/student-agent_*.msi`

### Step 5: Install the App

**Linux:**
```bash
chmod +x src-tauri/target/release/bundle/appimage/student-agent_*.AppImage
./src-tauri/target/release/bundle/appimage/student-agent_*.AppImage
```

**macOS:**
```bash
open src-tauri/target/release/bundle/dmg/student-agent_*.dmg
# Drag to Applications folder
```

**Windows:**
Double-click the `.msi` file and follow the installer.

---

## MCP Server Setup

Students need to run local MCP servers to provide tools to the desktop app.

### Option 1: Filesystem MCP Server (WebSocket)

This is the easiest option for getting started.

```bash
# Install globally
npm install -g @modelcontextprotocol/server-filesystem

# Run the server (specify allowed directory)
npx @modelcontextprotocol/server-filesystem \
  --port 8765 \
  --root /home/student/projects

# Or with multiple allowed directories
npx @modelcontextprotocol/server-filesystem \
  --port 8765 \
  --root /home/student/projects \
  --root /home/student/documents
```

The server will start on `ws://localhost:8765`.

### Option 2: Filesystem MCP Server (stdio)

For better security and sandboxing:

```bash
# Install locally
cd /home/student/mcp-servers
npm install @modelcontextprotocol/server-filesystem

# The desktop app will launch this via stdio when needed
```

Configure in desktop app settings:
- **Command**: `node`
- **Args**: `/home/student/mcp-servers/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js`
- **Root**: `/home/student/projects`

### Option 3: Git MCP Server

```bash
npm install -g @modelcontextprotocol/server-git

# Run on different port
npx @modelcontextprotocol/server-git --port 8766
```

### Option 4: Python MCP Server (Custom)

For executing Python code in a sandbox:

```bash
cd /home/student/mcp-servers
npm install @modelcontextprotocol/sdk

# Create a custom Python execution server
# (Implementation provided separately)
```

---

## Testing the Complete System

### 1. Start All Services

**Terminal 1 (Server):**
```bash
cd backend
python -m app.main
```

**Terminal 2 (MCP Server):**
```bash
npx @modelcontextprotocol/server-filesystem \
  --port 8765 \
  --root ~/test-project
```

**Terminal 3 (Desktop App):**
```bash
cd student-agent
npm run tauri dev
```

### 2. Connect Desktop to MCP Server

1. Click "Connect MCP Server" in the desktop app
2. Enter `ws://localhost:8765`
3. Click "Connect"
4. You should see "MCP: Connected (3 tools)" in the status bar

### 3. Test File Reading

In the chat interface, type:
```
What files are in my test-project directory?
```

The AI should:
1. Request to call `filesystem.listDirectory`
2. Desktop app forwards to local MCP server
3. Result is sent back to Ollama
4. AI responds with the file list

### 4. Test File Writing (with permission)

```
Create a new file called hello.py with a simple Python script
```

The AI should:
1. Request to call `filesystem.writeFile`
2. Desktop app shows permission dialog
3. You approve the operation
4. File is created locally
5. AI confirms success

### 5. Test Multi-Step Workflow

```
Read the contents of app.py, analyze it, and suggest improvements.
Then create a new file with the improved version.
```

This tests:
- Multiple tool calls in sequence
- Read + write permissions
- Agent reasoning between tool calls

---

## Deployment

### Server Deployment

**Using systemd (Linux):**

1. Create service file: `/etc/systemd/system/chatucy-server.service`

```ini
[Unit]
Description=ChatUCY MCP Agent Server
After=network.target

[Service]
Type=simple
User=chatucy
WorkingDirectory=/opt/chatucy_app/backend
Environment="PATH=/opt/chatucy_app/backend/venv/bin"
ExecStart=/opt/chatucy_app/backend/venv/bin/python -m app.main
Restart=always

[Install]
WantedBy=multi-user.target
```

2. Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable chatucy-server
sudo systemctl start chatucy-server
sudo systemctl status chatucy-server
```

### Desktop App Distribution

1. **Build installers for all platforms**
```bash
# On Linux
npm run tauri build -- --target x86_64-unknown-linux-gnu

# On macOS
npm run tauri build -- --target x86_64-apple-darwin
npm run tauri build -- --target aarch64-apple-darwin

# On Windows
npm run tauri build -- --target x86_64-pc-windows-msvc
```

2. **Sign the installers** (recommended for production)

**macOS:**
```bash
codesign --force --deep --sign "Developer ID Application: YOUR NAME" \
  src-tauri/target/release/bundle/dmg/*.dmg
```

**Windows:**
Use `signtool.exe` with your code signing certificate.

3. **Distribute**
- Upload to university download portal
- Include SHA256 checksums
- Provide installation instructions

### Auto-Updater Setup

Edit `src-tauri/tauri.conf.json`:

```json
{
  "updater": {
    "active": true,
    "endpoints": [
      "https://releases.ucy.ac.cy/chatucy-desktop/{{target}}/{{current_version}}"
    ],
    "dialog": true,
    "pubkey": "YOUR_PUBLIC_KEY"
  }
}
```

---

## Common Issues

### Desktop App Won't Start

**Error: "webkit2gtk not found"**
```bash
sudo apt install libwebkit2gtk-4.1-dev
```

**Error: "Rust compiler not found"**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### MCP Connection Fails

**Error: "ECONNREFUSED"**
- Check if MCP server is running: `netstat -an | grep 8765`
- Try connecting manually: `wscat -c ws://localhost:8765`
- Check firewall settings

**Error: "Invalid session"**
- Restart the desktop app
- Check server logs for errors
- Verify session registration endpoint

### Tool Calls Timeout

**Increase timeout in `mcp_agent.py`:**
```python
result = await asyncio.wait_for(future, timeout=120.0)  # Increase from 60 to 120
```

**Check network latency:**
```bash
ping your-university-server.edu
```

### Permission Dialog Not Showing

**Check browser console in desktop app:**
- Press `Ctrl+Shift+I` (or `Cmd+Option+I` on Mac)
- Look for JavaScript errors
- Verify `mcp-desktop-integration.js` is loaded

**Test manually:**
```javascript
// In browser console
window.mcpDesktopAPI.isConnected()
// Should return: true
```

---

## Next Steps

1. **Configure permissions** for your use case
2. **Set up Git MCP server** for version control workflows
3. **Create custom MCP servers** for lab-specific tools
4. **Deploy to students** with installation guide
5. **Monitor usage** via `/api/mcp/sessions` endpoint

## Support

- GitHub Issues: https://github.com/dmsl/llms/issues
- Email: support@dmsl.cs.ucy.ac.cy
- Documentation: https://dmsl.cs.ucy.ac.cy/chatucy/docs

---

**Last Updated**: November 2025  
**Version**: 1.0.0-mvp
