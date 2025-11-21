# Building ChatUCY Desktop Installers

## Current Platform: Linux

You are currently on a **Linux machine**. Here's what you can build and how to build Windows installers.

## 🐧 What You Can Build on This Linux Machine

When you run `npm run tauri build` on Linux, you'll get:

- **AppImage** - Universal Linux installer (`.AppImage`)
- **Debian Package** - For Debian/Ubuntu (`.deb`)

These are located in: `src-tauri/target/release/bundle/`

### Build Linux Installers Now:

```bash
cd /home/konstantinkrasovitskiy/chatucy_app/student-agent
npm install  # (already done)
npm run tauri build
```

This takes 5-15 minutes on first build.

## 🪟 Building Windows Installers (MSI & EXE)

To build Windows installers, you have **3 options**:

### Option 1: Use a Windows Machine (Recommended)

**On a Windows PC:**

1. Install prerequisites:
   - Node.js: https://nodejs.org/
   - Rust: https://rustup.rs/
   - Visual Studio Build Tools: https://visualstudio.microsoft.com/downloads/
     (Select "Desktop development with C++")

2. Clone the repository or copy the `student-agent` folder

3. Build:
   ```powershell
   cd student-agent
   npm install
   cd mcp-bridge
   npm install
   cd ..
   npm run tauri build
   ```

4. Find installers in:
   ```
   src-tauri\target\release\bundle\msi\ChatUCY Desktop_1.0.0_x64_en-US.msi
   src-tauri\target\release\bundle\nsis\ChatUCY Desktop_1.0.0_x64-setup.exe
   ```

### Option 2: GitHub Actions (CI/CD) - Best for Automation

Create `.github/workflows/release.yml` in your repository:

```yaml
name: Release Builds

on:
  push:
    tags:
      - 'v*'

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
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
      
      - name: Build Windows installers
        run: |
          cd student-agent
          npm run tauri build
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: windows-installers
          path: |
            student-agent/src-tauri/target/release/bundle/msi/*.msi
            student-agent/src-tauri/target/release/bundle/nsis/*.exe

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      
      - name: Install system dependencies
        run: |
          sudo apt update
          sudo apt install -y libwebkit2gtk-4.1-dev build-essential wget \
            libssl-dev libayatana-appindicator3-dev librsvg2-dev
      
      - name: Install dependencies
        run: |
          cd student-agent
          npm install
          cd mcp-bridge
          npm install
      
      - name: Build Linux installers
        run: |
          cd student-agent
          npm run tauri build
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: linux-installers
          path: |
            student-agent/src-tauri/target/release/bundle/appimage/*.AppImage
            student-agent/src-tauri/target/release/bundle/deb/*.deb
```

**To use:**
1. Push this file to your GitHub repo
2. Create a git tag: `git tag v1.0.0 && git push --tags`
3. GitHub Actions will automatically build all installers
4. Download from the Actions tab

### Option 3: Windows VM on Linux (Advanced)

Use VirtualBox or QEMU to run Windows:

```bash
# Install VirtualBox
sudo apt install virtualbox

# Create Windows 10/11 VM
# Install prerequisites in VM
# Build inside VM
```

## 🍎 Building macOS Installers

To build macOS `.dmg` installers, you need a Mac:

```bash
# On macOS
brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

cd student-agent
npm install
cd mcp-bridge && npm install && cd ..
npm run tauri build
```

Output: `src-tauri/target/release/bundle/dmg/ChatUCY Desktop_1.0.0_x64.dmg`

## 📦 What Gets Built on Each Platform

| Platform | When you run `npm run tauri build` you get: |
|----------|---------------------------------------------|
| **Windows** | `.msi` (Windows Installer) + `.exe` (NSIS installer) |
| **Linux** | `.AppImage` (universal) + `.deb` (Debian/Ubuntu) |
| **macOS** | `.dmg` (disk image) + `.app` (application bundle) |

## 🚀 Quick Commands Reference

```bash
# Install dependencies (run once)
npm install
cd mcp-bridge && npm install && cd ..

# Development mode (hot reload)
npm run tauri dev

# Build release installers for current platform
npm run tauri build

# Check build info
npm run tauri info

# Clean build cache (if needed)
cargo clean --manifest-path src-tauri/Cargo.toml
```

## 📝 Current Setup

- ✅ Tauri CLI installed
- ✅ Package dependencies configured
- ✅ MCP bridge dependencies configured
- ✅ Build configuration updated
- 🔧 Ready to build Linux installers now
- 🪟 Need Windows machine for Windows installers
- 🍎 Need macOS machine for macOS installers

## 🎯 Recommended Workflow

**For University Deployment:**

1. **Build on Linux** (this machine) for Linux students
2. **Setup GitHub Actions** for automated Windows/macOS builds
3. **Or:** Use a dedicated Windows VM for Windows builds

**Quick Start Now:**

```bash
# Build Linux installers right now
cd /home/konstantinkrasovitskiy/chatucy_app/student-agent
npm run tauri build
```

This will create `.AppImage` and `.deb` files you can distribute to Linux users immediately.

## 💡 Tips

- First build takes 10-20 minutes (downloads and compiles dependencies)
- Subsequent builds are much faster (~2-5 minutes)
- Use GitHub Actions for production releases
- Test installers on clean VMs before distribution
- Sign installers for production (prevents security warnings)

## 📧 Need Help?

See `WINDOWS_INSTALLER_GUIDE.md` for detailed Windows-specific instructions.
