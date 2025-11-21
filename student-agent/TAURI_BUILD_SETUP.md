# Tauri Desktop App Build Setup Instructions

## Overview
This document describes how to configure and build a Windows desktop application (EXE/MSI installers) using Tauri for the ChatUCY project.

## Project Structure
```
llmms/
├── frontend/              # Web frontend (HTML, CSS, JS)
│   ├── index.html        # Main entry point (created)
│   ├── html/             # Page templates
│   ├── css/              # Stylesheets
│   ├── js/               # JavaScript files
│   └── img/              # Images
├── backend/              # FastAPI backend
│   └── app/
│       └── main.py       # CORS configured for desktop app
└── student-agent/        # Tauri desktop wrapper
    ├── src-tauri/
    │   ├── tauri.conf.json   # Tauri configuration
    │   └── src/
    │       └── lib.rs        # Rust backend code
    └── package.json

```

## Changes Made

### 1. Tauri Configuration (`student-agent/src-tauri/tauri.conf.json`)

**Modified:** `build.frontendDist` path
```json
{
  "build": {
    "frontendDist": "../../frontend"
  }
}
```

**Reason:** Point Tauri to use the complete ChatUCY web frontend instead of demo files.

### 2. Frontend Entry Point (`frontend/index.html`)

**Created:** Root-level `index.html` that loads the chat interface
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <!-- Meta tags and CSS links -->
</head>
<body>
    <div class="loading" id="loading">Loading...</div>
    <iframe id="main-frame" src="/html/new_chat.html"></iframe>
    <script>
        // Load main chat interface
        if (window.__TAURI__) {
            console.log('Running in Tauri desktop app');
        }
    </script>
</body>
</html>
```

**Reason:** Tauri requires `index.html` at the root of `frontendDist`. This file loads the actual chat interface (`/html/new_chat.html`).

### 3. Rust Code Fixes (`student-agent/src-tauri/src/lib.rs`)

**Fixed imports:**
```rust
// Added Manager trait import
use tauri::{Manager, State};

// Removed unused imports
// use std::collections::HashMap;
// use std::path::PathBuf;
// use std::process::{Child, Command, Stdio};
```

**Fixed method calls:**
```rust
// app.path() now works because Manager trait is in scope
let config_dir = app
    .path()
    .app_config_dir()
    .map_err(|e| format!("Failed to get config dir: {}", e))?;
```

**Removed unused fields:**
```rust
struct McpBridgeState {
    // Removed: process: Mutex<Option<Child>>,
    tools: Mutex<Vec<McpTool>>,
    connected: Mutex<bool>,
}
```

### 4. Backend CORS Configuration (`backend/app/main.py`)

**Modified:** CORS middleware to support environment-based origins
```python
# Before:
allow_origins=["*"]

# After:
allowed_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,  # Use env var for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**For production deployment:**
```bash
# Set environment variable:
export ALLOWED_ORIGINS="https://yourdomain.ucy.ac.cy,tauri://localhost"
```

### 5. Git Ignore Pattern Fix (`student-agent/.gitignore`)

**Fixed Python bytecode patterns:**
```gitignore
# Before:
**/**.pyc
__pycache__/

# After:
*.pyc
__pycache__/
```

## Build Prerequisites

### Windows Build Machine Requirements:

1. **Rust** (Required)
   - Install from: https://rustup.rs/
   - Verify: `cargo --version`

2. **Node.js 18+** (Required)
   - Install from: https://nodejs.org/
   - Verify: `node --version`

3. **Visual Studio Build Tools** (Required)
   - Download: https://visualstudio.microsoft.com/downloads/
   - Install: "Desktop development with C++" workload

4. **WebView2** (Usually pre-installed on Windows 10/11)
   - Download if needed: https://developer.microsoft.com/microsoft-edge/webview2/

## Build Commands

### Install Dependencies
```powershell
cd student-agent
npm install
cd mcp-bridge
npm install
cd ..
```

### Build Installers
```powershell
# Ensure Rust is in PATH
$env:PATH += ";$env:USERPROFILE\.cargo\bin"

# Build both MSI and NSIS (EXE) installers
npm run tauri build
```

### Output Location
```
student-agent/src-tauri/target/release/bundle/
├── msi/
│   └── ChatUCY Desktop_1.0.0_x64_en-US.msi
└── nsis/
    └── ChatUCY Desktop_1.0.0_x64-setup.exe
```

## Common Build Issues & Solutions

### Issue 1: `cargo: command not found`
**Solution:** Add Rust to PATH:
```powershell
$env:PATH += ";$env:USERPROFILE\.cargo\bin"
```

### Issue 2: `link.exe not found`
**Solution:** Install Visual Studio Build Tools with C++ workload

### Issue 3: Compilation errors about missing `Manager` trait
**Solution:** Ensure `lib.rs` imports:
```rust
use tauri::{Manager, State};
```

### Issue 4: Frontend shows Tauri demo instead of ChatUCY
**Solution:** Check `tauri.conf.json`:
```json
"frontendDist": "../../frontend"  // NOT "../src"
```

## Production Deployment Checklist

- [ ] Update version in `src-tauri/tauri.conf.json`
- [ ] Configure HTTPS backend with Let's Encrypt certificate
- [ ] Set `ALLOWED_ORIGINS` environment variable on server
- [ ] Update API URLs in frontend JS files to use HTTPS
- [ ] Code sign installers (optional but recommended)
- [ ] Test on clean Windows 10 and Windows 11 VMs
- [ ] Generate SHA256 checksums for installers
- [ ] Upload to distribution server

## HTTPS/TLS Configuration Notes

### Backend (FastAPI with Let's Encrypt)

**Option A: Direct HTTPS (uvicorn)**
```python
uvicorn.run(
    "app.main:app",
    host="0.0.0.0",
    port=443,
    ssl_keyfile="/etc/letsencrypt/live/yourdomain.ucy.ac.cy/privkey.pem",
    ssl_certfile="/etc/letsencrypt/live/yourdomain.ucy.ac.cy/fullchain.pem"
)
```

**Option B: Nginx Reverse Proxy (Recommended)**
```nginx
server {
    listen 443 ssl;
    server_name api.ucy.ac.cy;
    
    ssl_certificate /etc/letsencrypt/live/yourdomain.ucy.ac.cy/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.ucy.ac.cy/privkey.pem;
    
    location / {
        proxy_pass http://localhost:62828;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Desktop App API Configuration

Update JavaScript files to use HTTPS endpoints:
```javascript
// development
const API_URL = "http://localhost:62828";

// production
const API_URL = "https://api.ucy.ac.cy";
```

## Key Files to Transfer to Other Projects

When applying this setup to another project, ensure these files are configured:

1. **`src-tauri/tauri.conf.json`** - Point to correct frontend
2. **`src-tauri/src/lib.rs`** - Fix Rust imports and unused code
3. **`frontend/index.html`** - Create root entry point
4. **`backend/app/main.py`** - Configure CORS
5. **`.gitignore`** - Fix Python patterns

## Architecture Diagram

```
┌─────────────────────────────────────┐
│   Student Desktop App (Tauri)       │
│   ┌─────────────────────────────┐   │
│   │  WebView (Chromium)         │   │
│   │  - HTML/CSS/JS from frontend│   │
│   │  - MCP Bridge Integration   │   │
│   └─────────────────────────────┘   │
│   ┌─────────────────────────────┐   │
│   │  Rust Backend               │   │
│   │  - MCP Server Connections   │   │
│   │  - File System Access       │   │
│   └─────────────────────────────┘   │
└─────────────────┬───────────────────┘
                  │ HTTPS
                  ▼
┌─────────────────────────────────────┐
│   University Backend Server         │
│   ┌─────────────────────────────┐   │
│   │  Nginx (SSL/TLS)            │   │
│   │  - Let's Encrypt Cert       │   │
│   └─────────────┬───────────────┘   │
│                 │                    │
│   ┌─────────────▼───────────────┐   │
│   │  FastAPI Backend            │   │
│   │  - Chat API                 │   │
│   │  - RAG Processing           │   │
│   │  - Model Management         │   │
│   └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Version Information

- **Tauri:** 2.x
- **Rust:** Latest stable
- **Node.js:** 18+
- **FastAPI:** Latest
- **Target OS:** Windows 10/11 (64-bit)

## Support & References

- Tauri Documentation: https://tauri.app/
- Windows Installer Guide: See `WINDOWS_INSTALLER_GUIDE.md`
- Build Guide: See `BUILD_GUIDE.md`

---

**Last Updated:** November 21, 2025  
**Author:** ChatUCY Development Team  
**Project:** ChatUCY Desktop - AI Coding Agent
