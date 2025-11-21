#!/bin/bash

# ChatUCY Desktop Development Helper Script
# This script helps start all services needed for development

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== ChatUCY Desktop Development Helper ===${NC}\n"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo "Checking prerequisites..."

if ! command_exists node; then
    echo -e "${RED}✗ Node.js not found${NC}"
    echo "Install from: https://nodejs.org/"
    exit 1
fi
echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"

if ! command_exists npm; then
    echo -e "${RED}✗ npm not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm: $(npm --version)${NC}"

if ! command_exists cargo; then
    echo -e "${RED}✗ Rust/Cargo not found${NC}"
    echo "Install from: https://rustup.rs/"
    exit 1
fi
echo -e "${GREEN}✓ Rust: $(rustc --version)${NC}"

if ! command_exists python3; then
    echo -e "${RED}✗ Python 3 not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Python: $(python3 --version)${NC}"

echo ""

# Menu
echo "Select an option:"
echo "1) Install dependencies"
echo "2) Start backend server"
echo "3) Start desktop app (dev mode)"
echo "4) Start MCP filesystem server"
echo "5) Build desktop app (production)"
echo "6) Run all services (server + desktop + MCP)"
echo "7) Clean build artifacts"
echo "8) Exit"

read -p "Enter choice [1-8]: " choice

case $choice in
    1)
        echo -e "\n${YELLOW}Installing dependencies...${NC}"
        
        # Backend
        echo "Installing Python dependencies..."
        cd "$PROJECT_ROOT/backend"
        pip3 install -q fastapi uvicorn websockets httpx python-multipart pydantic || {
            echo -e "${RED}Failed to install Python dependencies${NC}"
            exit 1
        }
        echo -e "${GREEN}✓ Python dependencies installed${NC}"
        
        # Desktop app
        echo "Installing desktop app dependencies..."
        cd "$SCRIPT_DIR"
        npm install || {
            echo -e "${RED}Failed to install npm dependencies${NC}"
            exit 1
        }
        echo -e "${GREEN}✓ Desktop app dependencies installed${NC}"
        
        # MCP bridge
        echo "Installing MCP bridge dependencies..."
        cd "$SCRIPT_DIR/mcp-bridge"
        npm install || {
            echo -e "${RED}Failed to install MCP bridge dependencies${NC}"
            exit 1
        }
        echo -e "${GREEN}✓ MCP bridge dependencies installed${NC}"
        
        # MCP filesystem server
        echo "Installing MCP filesystem server..."
        npm install -g @modelcontextprotocol/server-filesystem 2>/dev/null || {
            echo -e "${YELLOW}Note: MCP filesystem server install may require sudo${NC}"
            sudo npm install -g @modelcontextprotocol/server-filesystem
        }
        echo -e "${GREEN}✓ MCP filesystem server installed${NC}"
        
        echo -e "\n${GREEN}All dependencies installed successfully!${NC}"
        ;;
        
    2)
        echo -e "\n${YELLOW}Starting backend server...${NC}"
        cd "$PROJECT_ROOT/backend"
        python3 -m app.main
        ;;
        
    3)
        echo -e "\n${YELLOW}Starting desktop app in development mode...${NC}"
        cd "$SCRIPT_DIR"
        npm run tauri dev
        ;;
        
    4)
        echo -e "\n${YELLOW}Starting MCP filesystem server...${NC}"
        read -p "Enter allowed directory path (default: $HOME/projects): " mcp_root
        mcp_root=${mcp_root:-$HOME/projects}
        
        if [ ! -d "$mcp_root" ]; then
            mkdir -p "$mcp_root"
            echo -e "${GREEN}Created directory: $mcp_root${NC}"
        fi
        
        echo "Starting MCP server on ws://localhost:8765"
        echo "Allowed directory: $mcp_root"
        npx @modelcontextprotocol/server-filesystem --port 8765 --root "$mcp_root"
        ;;
        
    5)
        echo -e "\n${YELLOW}Building desktop app for production...${NC}"
        cd "$SCRIPT_DIR"
        npm run tauri build
        
        echo -e "\n${GREEN}Build complete!${NC}"
        echo "Installers located in:"
        echo "  - Linux:   src-tauri/target/release/bundle/appimage/"
        echo "  - macOS:   src-tauri/target/release/bundle/dmg/"
        echo "  - Windows: src-tauri/target/release/bundle/msi/"
        ;;
        
    6)
        echo -e "\n${YELLOW}Starting all services...${NC}"
        
        # Check if tmux is available
        if command_exists tmux; then
            echo "Using tmux for multiple terminals..."
            
            # Create new tmux session
            tmux new-session -d -s chatucy
            
            # Window 1: Backend server
            tmux rename-window -t chatucy:0 'backend'
            tmux send-keys -t chatucy:0 "cd $PROJECT_ROOT/backend && python3 -m app.main" C-m
            
            # Window 2: MCP server
            tmux new-window -t chatucy:1 -n 'mcp-server'
            tmux send-keys -t chatucy:1 "npx @modelcontextprotocol/server-filesystem --port 8765 --root $HOME/projects" C-m
            
            # Window 3: Desktop app
            tmux new-window -t chatucy:2 -n 'desktop'
            tmux send-keys -t chatucy:2 "cd $SCRIPT_DIR && npm run tauri dev" C-m
            
            # Attach to session
            tmux select-window -t chatucy:0
            tmux attach-session -t chatucy
            
        else
            echo -e "${YELLOW}tmux not found. Please install tmux or run services manually:${NC}"
            echo ""
            echo "Terminal 1: cd $PROJECT_ROOT/backend && python3 -m app.main"
            echo "Terminal 2: npx @modelcontextprotocol/server-filesystem --port 8765 --root $HOME/projects"
            echo "Terminal 3: cd $SCRIPT_DIR && npm run tauri dev"
        fi
        ;;
        
    7)
        echo -e "\n${YELLOW}Cleaning build artifacts...${NC}"
        cd "$SCRIPT_DIR"
        
        # Clean Rust build
        cargo clean --manifest-path src-tauri/Cargo.toml
        
        # Clean npm artifacts
        rm -rf node_modules
        rm -rf mcp-bridge/node_modules
        
        # Clean Tauri build cache
        rm -rf src-tauri/target
        
        echo -e "${GREEN}Build artifacts cleaned${NC}"
        ;;
        
    8)
        echo "Goodbye!"
        exit 0
        ;;
        
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
