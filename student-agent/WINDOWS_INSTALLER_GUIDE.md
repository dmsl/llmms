# Building Windows Installers for ChatUCY Desktop

This guide explains how to build MSI and EXE installers for distribution to students.

## 📦 What You'll Get

After building, you'll have two installer types:

1. **MSI Installer** (Windows Installer)
   - Professional, enterprise-friendly
   - Better for IT departments
   - Silent install support
   - File: `ChatUCY Desktop_1.0.0_x64_en-US.msi`

2. **NSIS Installer** (EXE)
   - Modern, user-friendly wizard
   - Customizable branding
   - Better for end users
   - File: `ChatUCY Desktop_1.0.0_x64-setup.exe`

## 🔧 Prerequisites for Building

### On Windows:

1. **Install Rust**
   ```powershell
   # Download and run: https://rustup.rs/
   ```

2. **Install Node.js 18+**
   ```powershell
   # Download from: https://nodejs.org/
   ```

3. **Install Visual Studio Build Tools**
   - Download: https://visualstudio.microsoft.com/downloads/
   - Install "Desktop development with C++" workload

4. **Install WebView2** (usually pre-installed on Windows 10/11)
   - Download if needed: https://developer.microsoft.com/microsoft-edge/webview2/

### On Linux (Cross-compile):

Cross-compiling Windows installers from Linux is complex. Instead:
- Use a Windows VM or dedicated Windows build machine
- Or use GitHub Actions (see CI/CD section below)

## 🏗️ Building the Installers

### Step 1: Install Dependencies

```bash
cd student-agent
npm install
cd mcp-bridge
npm install
cd ..
```

### Step 2: Build the App

```bash
# Build both MSI and NSIS installers
npm run tauri build

# Or build specific target
npm run tauri build -- --target msi
npm run tauri build -- --target nsis
```

### Step 3: Find Your Installers

Windows installers are created in:

```
src-tauri/target/release/bundle/
├── msi/
│   └── ChatUCY Desktop_1.0.0_x64_en-US.msi    (~15-20 MB)
└── nsis/
    └── ChatUCY Desktop_1.0.0_x64-setup.exe    (~15-20 MB)
```

## 📝 Installer Details

### MSI Installer Features

- **Installation Path**: `C:\Program Files\ChatUCY Desktop\`
- **Start Menu**: Creates shortcuts
- **Uninstaller**: Available in Windows Settings
- **Per-Machine Install**: Available to all users
- **Upgrade Support**: Can upgrade from previous versions

### NSIS Installer Features

- **Custom Wizard**: Modern installation experience
- **Installation Path**: User selectable (default: Program Files)
- **Desktop Shortcut**: Optional
- **Start Menu**: Creates shortcuts
- **Uninstaller**: Creates uninstall.exe

## 🎨 Customizing the Installers

### 1. Change App Icon

Replace these files in `src-tauri/icons/`:
- `icon.ico` - Windows icon (256x256 recommended)
- `icon.png` - Source icon (512x512 or larger)

Regenerate icons:
```bash
npm run tauri icon path/to/your/icon.png
```

### 2. Add License Agreement

Create `src-tauri/LICENSE.rtf` with your license text:

Update `tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "license": "LICENSE.rtf"
      }
    }
  }
}
```

### 3. Customize Installer Images

Add branding images:

**Header Image** (NSIS):
- Size: 150x57 pixels
- Format: BMP
- Path: `src-tauri/installer-header.bmp`

**Sidebar Image** (NSIS):
- Size: 164x314 pixels  
- Format: BMP
- Path: `src-tauri/installer-sidebar.bmp`

Update `tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "headerImage": "installer-header.bmp",
        "sidebarImage": "installer-sidebar.bmp"
      }
    }
  }
}
```

### 4. Change Install Mode

**Per-User Install** (no admin required):
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

**Per-Machine Install** (admin required, default):
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "perMachine"
      }
    }
  }
}
```

## 🔐 Code Signing (Recommended for Production)

Signing prevents Windows SmartScreen warnings.

### Get a Code Signing Certificate

1. Purchase from: DigiCert, Sectigo, or SSL.com
2. Cost: ~$100-400/year
3. Requires company verification

### Sign the Installers

```powershell
# Sign with signtool (Windows SDK)
signtool sign /f "cert.pfx" /p "password" /tr http://timestamp.digicert.com /td sha256 /fd sha256 "ChatUCY Desktop_1.0.0_x64-setup.exe"
```

Or configure in `tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

## 🚀 Distribution

### 1. Create Checksums

```powershell
# SHA256 checksums for verification
certutil -hashfile "ChatUCY Desktop_1.0.0_x64-setup.exe" SHA256
certutil -hashfile "ChatUCY Desktop_1.0.0_x64_en-US.msi" SHA256
```

Save to `checksums.txt`:
```
SHA256 (ChatUCY Desktop_1.0.0_x64-setup.exe) = abc123...
SHA256 (ChatUCY Desktop_1.0.0_x64_en-US.msi) = def456...
```

### 2. Upload to Server

```bash
# Upload to university server
scp "ChatUCY Desktop_1.0.0_x64-setup.exe" user@server:/var/www/downloads/
scp checksums.txt user@server:/var/www/downloads/
```

### 3. Create Download Page

Example download page HTML:
```html
<h2>ChatUCY Desktop - Download</h2>

<div class="download-options">
  <div class="installer">
    <h3>Recommended: EXE Installer</h3>
    <a href="ChatUCY Desktop_1.0.0_x64-setup.exe">
      Download for Windows (15 MB)
    </a>
    <p>Modern installer with wizard interface</p>
  </div>
  
  <div class="installer">
    <h3>Alternative: MSI Installer</h3>
    <a href="ChatUCY Desktop_1.0.0_x64_en-US.msi">
      Download MSI (15 MB)
    </a>
    <p>For IT deployments and Group Policy</p>
  </div>
</div>

<h3>Verify Download</h3>
<pre>
SHA256: abc123...
</pre>
```

### 4. Silent Installation (IT Departments)

**MSI Silent Install:**
```cmd
msiexec /i "ChatUCY Desktop_1.0.0_x64_en-US.msi" /quiet /norestart
```

**NSIS Silent Install:**
```cmd
"ChatUCY Desktop_1.0.0_x64-setup.exe" /S
```

**Group Policy Deployment:**
1. Copy MSI to network share
2. Create GPO: Computer Configuration → Software Installation
3. Add the MSI package
4. Deploy to target computers

## 🔄 Auto-Updates (Optional)

Enable auto-updates in `tauri.conf.json`:

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

Generate update keys:
```bash
npm run tauri signer generate
```

## 🤖 CI/CD with GitHub Actions

Create `.github/workflows/build-windows.yml`:

```yaml
name: Build Windows Installers

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: windows-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      
      - name: Install dependencies
        run: |
          cd student-agent
          npm install
          cd mcp-bridge
          npm install
      
      - name: Build installers
        run: |
          cd student-agent
          npm run tauri build
      
      - name: Upload installers
        uses: actions/upload-artifact@v3
        with:
          name: windows-installers
          path: |
            student-agent/src-tauri/target/release/bundle/msi/*.msi
            student-agent/src-tauri/target/release/bundle/nsis/*.exe
```

## 📊 Testing Installers

### Before Distribution:

1. **Test on Clean Windows VM**
   - Windows 10 (fresh install)
   - Windows 11 (fresh install)

2. **Test Both Install Modes**
   - Install as Administrator (per-machine)
   - Install as regular user (if supported)

3. **Test Upgrade Path**
   - Install version 0.9.0
   - Install version 1.0.0 over it
   - Verify settings preserved

4. **Test Uninstall**
   - Check all files removed
   - Check registry entries cleaned
   - Check Start Menu shortcuts removed

5. **Test on Different Architectures**
   - 64-bit Windows (most common)
   - 32-bit Windows (if needed)

## 🐛 Troubleshooting

### "Build failed: link.exe not found"

**Solution:** Install Visual Studio Build Tools with C++ workload

### "WebView2 installation failed"

**Solution:** Include WebView2 bootstrapper in installer or require manual install

### "Icon not showing correctly"

**Solution:** 
- Ensure icon.ico is 256x256
- Clear icon cache: delete `%localappdata%\IconCache.db`
- Restart explorer.exe

### Installer shows SmartScreen warning

**Solution:** 
- Code sign your installers (recommended)
- Or: Build reputation over time (Microsoft learns your installer is safe)

## 📋 Checklist for Release

- [ ] Version number updated in `tauri.conf.json`
- [ ] Change log updated
- [ ] Icons are correct size and format
- [ ] License agreement added (if required)
- [ ] Build on clean Windows machine
- [ ] Test both MSI and NSIS installers
- [ ] Test upgrade from previous version
- [ ] Generate checksums
- [ ] Code sign installers (if available)
- [ ] Test on Windows 10 and 11
- [ ] Upload to download server
- [ ] Update download page
- [ ] Announce release

## 📧 Support

- Build Issues: https://github.com/dmsl/llms/issues
- Email: support@dmsl.cs.ucy.ac.cy

---

**Last Updated:** November 2025  
**Tauri Version:** 2.x
