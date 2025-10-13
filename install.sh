#!/bin/bash

#############################################################
# LLM-MS Automated Installation Script
# For Ubuntu 22.04/24.04 LTS
# Repository: https://github.com/dmsl/llmms
#############################################################

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
HOME_DIR=$(eval echo ~$USER)
CHROMA_PATH=$(command -v chroma || echo "$HOME_DIR/.local/bin/chroma")
# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    log_error "Please do not run this script as root. Run as normal user with sudo privileges."
    exit 1
fi

# Check if user has sudo privileges
if ! sudo -n true 2>/dev/null; then
    log_error "This script requires sudo privileges. Please ensure your user has sudo access."
    exit 1
fi

# Check Ubuntu version
check_ubuntu_version() {
    log_info "Checking Ubuntu version..."
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        if [[ "$ID" != "ubuntu" ]]; then
            log_error "This script is designed for Ubuntu. Detected: $ID"
            exit 1
        fi
        
        VERSION_NUM=$(echo $VERSION_ID | cut -d. -f1)
        if [[ "$VERSION_NUM" -lt 22 ]]; then
            log_error "Ubuntu 22.04 or higher is required. Detected: $VERSION_ID"
            exit 1
        fi
        log_success "Ubuntu $VERSION_ID detected"
    else
        log_error "Cannot detect OS version"
        exit 1
    fi
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Check RAM
    TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
    if [ "$TOTAL_RAM" -lt 16 ]; then
        log_warning "System has ${TOTAL_RAM}GB RAM. 16GB+ recommended for optimal performance."
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        log_success "RAM: ${TOTAL_RAM}GB"
    fi
    
    # Check disk space
    AVAILABLE_SPACE=$(df -BG ~ | tail -1 | awk '{print $4}' | sed 's/G//')
    if [ "$AVAILABLE_SPACE" -lt 50 ]; then
        log_warning "Only ${AVAILABLE_SPACE}GB free space available. 50GB+ recommended."
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        log_success "Disk space: ${AVAILABLE_SPACE}GB available"
    fi
}

# Update system
update_system() {
    log_info "Updating system packages..."
    if sudo apt update && sudo apt upgrade -y; then
        log_success "System updated"
    else
        log_error "Failed to update system"
        exit 1
    fi
}

# Install Ollama
install_ollama() {
    log_info "Installing Ollama..."
    
    if command -v ollama &> /dev/null; then
        log_warning "Ollama already installed"
        ollama --version
    else
        if curl -fsSL https://ollama.com/install.sh | sh; then
            log_success "Ollama installed"
        else
            log_error "Failed to install Ollama"
            exit 1
        fi
    fi
    
    # Start and enable Ollama service
    log_info "Starting Ollama service..."
    sudo systemctl start ollama
    sudo systemctl enable ollama
    
    # Wait for Ollama to be ready
    sleep 3
    
    if systemctl is-active --quiet ollama; then
        log_success "Ollama service is running"
    else
        log_error "Ollama service failed to start"
        exit 1
    fi
}

# Download AI models
download_models() {
    log_info "Downloading AI models (this will take 10-15 minutes)..."
    
    models=("nomic-embed-text" "llama3.1:8b" "mistral:7b" )
    
    for model in "${models[@]}"; do
        log_info "Pulling model: $model"
        if ollama pull "$model"; then
            log_success "Model $model downloaded"
        else
            log_error "Failed to download model: $model"
            exit 1
        fi
    done
}

# Install Python dependencies
install_python() {
    log_info "Installing Python and dependencies..."
    
    if sudo apt install -y python3 python3-pip python3-venv git; then
        log_success "Python installed"
    else
        log_error "Failed to install Python"
        exit 1
    fi
}

# Install ChromaDB
install_chromadb() {
    log_info "Installing ChromaDB..."
    
    if pip3 install chromadb --break-system-packages; then
        log_success "ChromaDB installed"
    else
        log_error "Failed to install ChromaDB"
        exit 1
    fi
    
    # Create ChromaDB data directory
    mkdir -p ~/chromadb_data
    
    # Create ChromaDB systemd service
    log_info "Creating ChromaDB service..."
    sudo tee /etc/systemd/system/chromadb.service > /dev/null <<EOF
[Unit]
Description=ChromaDB Service
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME_DIR
ExecStart=$CHROMA_PATH run --path $HOME_DIR/chromadb_data --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    
    # Start ChromaDB
    sudo systemctl daemon-reload
    sudo systemctl start chromadb
    sudo systemctl enable chromadb
    
    sleep 2
    
    if systemctl is-active --quiet chromadb; then
        log_success "ChromaDB service is running"
    else
        log_error "ChromaDB service failed to start"
        exit 1
    fi
}

setup_llmms() {
    log_info "Setting up LLM-MS application (using existing repo)..."

    # Detect current directory (this script lives in repo root)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$SCRIPT_DIR"
    BACKEND_DIR="$PROJECT_ROOT/backend"
    APP_DIR="$BACKEND_DIR/app"
    VENV_PATH="$APP_DIR/venv"

    # Verify that backend/app exists
    if [ ! -d "$APP_DIR" ]; then
        log_error "Application directory not found at: $APP_DIR"
        exit 1
    fi

    cd "$APP_DIR"

    # Create virtual environment inside backend/app/
    log_info "Creating Python virtual environment at: $VENV_PATH"
    if [ ! -d "$VENV_PATH" ]; then
        python3 -m venv "$VENV_PATH"
        log_success "Virtual environment created in app/"
    else
        log_warning "Virtual environment already exists — reusing it"
    fi

    # Activate and install dependencies
    log_info "Installing Python packages..."
    source "$VENV_PATH/bin/activate"

    pip install --upgrade pip

    packages=(
        "fastapi"
        "uvicorn[standard]"
        "ollama"
        "chromadb"
        "python-multipart"
        "werkzeug"
        "numpy"
        "pandas"
        "pydantic"
        "pypdf"
        "PyPDF2"
        "python-docx"
        "pillow"
        "openpyxl"
        "scikit-learn"
    )

    for package in "${packages[@]}"; do
        if pip install "$package"; then
            log_success "Installed: $package"
        else
            log_warning "Failed to install: $package (continuing...)"
        fi
    done

    deactivate

    # Create uploads directory
    mkdir -p /tmp/uploads

    log_success "LLM-MS setup complete (venv located in backend/app/)."
}

create_fastapi_service() {
    log_info "Creating FastAPI service..."

    # This script lives in the repo root (~/llmms)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    BACKEND_DIR="$SCRIPT_DIR/backend"
    APP_DIR="$BACKEND_DIR/app"
    VENV_PATH="$APP_DIR/venv"
    LAUNCHER="$APP_DIR/start_fastapi.sh"

    # --- Validation ---
    if [ ! -d "$APP_DIR" ]; then
        log_error "App directory not found at: $APP_DIR"
        exit 1
    fi

    if [ ! -f "$LAUNCHER" ]; then
        log_error "Launcher script not found at: $LAUNCHER"
        exit 1
    fi

    # --- Create systemd unit file ---
    sudo tee /etc/systemd/system/llmms-api.service > /dev/null <<EOF
[Unit]
Description=LLM-MS FastAPI Service
After=network.target ollama.service chromadb.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$LAUNCHER
Restart=always
RestartSec=3
Environment="PYTHONPATH=$BACKEND_DIR"
Environment="PATH=$VENV_PATH/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
EOF

    # --- Permissions & reload ---
    sudo chmod +x "$LAUNCHER"
    sudo systemctl daemon-reload
    sudo systemctl enable llmms-api
    sudo systemctl restart llmms-api

    sleep 2

    # --- Verify service ---
    if systemctl is-active --quiet llmms-api; then
        log_success "FastAPI service is running successfully!"
    else
        log_error "FastAPI service failed to start. Check logs:"
        echo "sudo journalctl -u llmms-api -n 50"
        exit 1
    fi
}



# Install and configure Apache
install_apache() {
    log_info "Installing Apache2..."
    
    if sudo apt install -y apache2; then
        log_success "Apache2 installed"
    else
        log_error "Failed to install Apache2"
        exit 1
    fi
    
    # Enable required modules
    log_info "Enabling Apache modules..."
    sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
    
    # Create Apache configuration
    log_info "Creating Apache configuration..."
    sudo tee /etc/apache2/sites-available/llmms.conf > /dev/null <<EOF
<VirtualHost *:80>
    ServerName localhost
    
    DocumentRoot $HOME_DIR/llmms/frontend
    
    <Directory $HOME_DIR/llmms/frontend>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
    
    # Proxy API requests to FastAPI
    ProxyPreserveHost On
    ProxyPass /api/ http://127.0.0.1:62828/
    ProxyPassReverse /api/ http://127.0.0.1:62828/
    
    ErrorLog \${APACHE_LOG_DIR}/llmms_error.log
    CustomLog \${APACHE_LOG_DIR}/llmms_access.log combined
</VirtualHost>
EOF
    
    # Enable site
    sudo a2dissite 000-default.conf 2>/dev/null || true
    sudo a2ensite llmms.conf
    
    # Test configuration
    if sudo apache2ctl configtest; then
        log_success "Apache configuration valid"
    else
        log_error "Apache configuration has errors"
        exit 1
    fi
    
    # Restart Apache
    sudo systemctl restart apache2
    
    if systemctl is-active --quiet apache2; then
        log_success "Apache2 is running"
    else
        log_error "Apache2 failed to start"
        exit 1
    fi
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."
    
    # Check all services
    services=("ollama" "chromadb" "llmms-api" "apache2")
    
    for service in "${services[@]}"; do
        if systemctl is-active --quiet "$service"; then
            log_success "$service is running"
        else
            log_error "$service is NOT running"
        fi
    done
    
    # Test endpoints
    log_info "Testing endpoints..."
    
    # Test Ollama
    if curl -s http://localhost:11434 > /dev/null; then
        log_success "Ollama endpoint responding"
    else
        log_warning "Ollama endpoint not responding"
    fi
    
    # Test ChromaDB
    if curl -s http://localhost:8000/api/v1/heartbeat > /dev/null; then
        log_success "ChromaDB endpoint responding"
    else
        log_warning "ChromaDB endpoint not responding"
    fi
    
    # Test FastAPI
    if curl -s http://localhost:62828/get_models > /dev/null; then
        log_success "FastAPI endpoint responding"
    else
        log_warning "FastAPI endpoint not responding"
    fi
}

# Detect GPU
detect_gpu() {
    GPU_DETECTED=""
    log_info "Detecting GPU..."
    
    if command -v nvidia-smi &> /dev/null; then
        GPU_DETECTED="NVIDIA"
        log_success "NVIDIA GPU detected"
        nvidia-smi --query-gpu=name --format=csv,noheader
        echo ""
        log_info "GPU acceleration is available but not configured."
        log_info "Run the GPU setup section manually from the installation guide."
    elif lspci | grep -i amd | grep -i vga &> /dev/null; then
        GPU_DETECTED="AMD"
        log_success "AMD GPU detected"
        lspci | grep -i amd | grep -i vga
        echo ""
        log_info "GPU acceleration is available but not configured."
        log_info "Run the GPU setup section manually from the installation guide."
    else
        log_warning "No GPU detected. System will run on CPU (slower performance)."
    fi
}

# Print completion message
print_completion() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                                                            ║"
    echo "║          LLM-MS Installation Complete! 🎉                 ║"
    echo "║                                                            ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    log_info "Access your LLM-MS installation at:"
    echo ""
    echo "    http://localhost        (on this machine)"
    echo "    http://$(hostname -I | awk '{print $1}')   (from other machines)"
    echo ""
    log_info "Installed models:"
    ollama list
    echo ""
    log_info "Useful commands:"
    echo "  • Check services: sudo systemctl status ollama chromadb llmms-api apache2"
    echo "  • View API logs: sudo journalctl -u llmms-api -f"
    echo "  • Restart all: sudo systemctl restart ollama chromadb llmms-api apache2"
    echo "  • Pull new model: ollama pull model-name"
    echo ""
    
    if [ -n "$GPU_DETECTED" ]; then
        log_info "GPU detected but not configured. See installation guide for GPU setup."
    fi
}
#############################################################
# GPU Driver Setup (Tesla V100 - VM Installation Only)
#############################################################

setup_gpu_driver_vm() {
    log_info "Initializing NVIDIA Tesla V100 driver setup (VM mode)..."

    DRIVER_VER="550.54.14"
    DRIVER_FILE="NVIDIA-Linux-x86_64-${DRIVER_VER}.run"
    DRIVER_URL="https://us.download.nvidia.com/tesla/${DRIVER_VER}/${DRIVER_FILE}"
    DRIVER_CACHE_DIR="/opt/nvidia-drivers"

    echo -e "\n=========================================================="
    echo "STEP 1: Detecting NVIDIA GPU inside VM"
    echo "=========================================================="

    if ! lspci | grep -i "NVIDIA" &>/dev/null; then
        log_warning "No NVIDIA GPU detected inside this VM. Skipping driver setup."
        return 0
    fi

    log_success "NVIDIA GPU detected inside VM:"
    lspci | grep -i "NVIDIA" | awk '{$1=$1;print}'

    # --- Skip if driver version is already installed ---
    if command -v nvidia-smi &>/dev/null; then
        CURRENT_DRIVER_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1 || echo "unknown")
        if [[ "$CURRENT_DRIVER_VER" == "$DRIVER_VER" ]]; then
            log_success "NVIDIA driver ${DRIVER_VER} already installed — skipping download and installation."
            return 0
        else
            log_warning "Detected NVIDIA driver version $CURRENT_DRIVER_VER (expected $DRIVER_VER). Proceeding with reinstall..."
        fi
    fi

    echo -e "\n=========================================================="
    echo "STEP 2: Preparing system for driver installation"
    echo "=========================================================="
    sudo apt-get update -y
    sudo apt-get install -y linux-headers-$(uname -r) build-essential dkms wget

    echo -e "\n=========================================================="
    echo "STEP 3: Checking for existing driver installer"
    echo "=========================================================="

    # Ensure cache directory exists
    sudo mkdir -p "$DRIVER_CACHE_DIR"
    sudo chmod 777 "$DRIVER_CACHE_DIR"

    DRIVER_PATH="$DRIVER_CACHE_DIR/$DRIVER_FILE"

    if [ -f "$DRIVER_PATH" ]; then
        log_success "Using cached NVIDIA driver installer: $DRIVER_PATH"
    else
        log_info "Downloading NVIDIA Tesla driver ${DRIVER_VER}..."
        wget -O "$DRIVER_PATH" -c "$DRIVER_URL" || {
            log_error "Failed to download driver from $DRIVER_URL"
            exit 1
        }
        log_success "Driver downloaded and saved to cache."
    fi

    echo -e "\n=========================================================="
    echo "STEP 4: Removing any existing NVIDIA drivers"
    echo "=========================================================="
    sudo apt-get remove --purge -y '^nvidia-.*' || true
    sudo apt-get autoremove -y && sudo apt-get autoclean -y
    sudo rm -f /usr/bin/nvidia-smi || true

    echo -e "\n=========================================================="
    echo "STEP 5: Installing NVIDIA Tesla driver ${DRIVER_VER}"
    echo "=========================================================="
    chmod +x "$DRIVER_PATH"
    sudo bash "$DRIVER_PATH" --silent --no-cc-version-check

    echo -e "\n=========================================================="
    echo "STEP 6: Verifying NVIDIA driver installation"
    echo "=========================================================="
    if command -v nvidia-smi &>/dev/null; then
        nvidia-smi
        log_success "NVIDIA driver ${DRIVER_VER} installed successfully!"
    else
        log_error "NVIDIA driver installation failed!"
        exit 1
    fi
}



# Main installation flow
main() {
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                                                            ║"
    echo "║          LLM-MS Automated Installation Script             ║"
    echo "║          https://github.com/dmsl/llmms                    ║"
    echo "║                                                            ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    
    log_info "Starting installation process..."
    echo ""
    setup_gpu_driver_vm  
    check_ubuntu_version
    check_requirements
    
    echo ""
    log_warning "This script will install:"
    echo "  • Ollama (AI model runtime)"
    echo "  • ChromaDB (vector database)"
    echo "  • Python packages (FastAPI, etc.)"
    echo "  • Apache2 web server"
    echo "  • LLM-MS application"
    echo "  • AI models (llama3.1:8b, mistral:7b, qwen2.5:7b)"
    echo ""
    log_warning "This will take approximately 20-30 minutes."
    echo ""
    
    read -p "Continue with installation? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Installation cancelled by user"
        exit 0
    fi
    
    echo ""
    log_info "Starting installation..."
    echo ""
    
    # Run installation steps
    update_system
    install_ollama
    install_python
    install_chromadb
    setup_llmms
    create_fastapi_service
    install_apache
    download_models
    
    echo ""
    verify_installation
    
    echo ""
    detect_gpu
    
    echo ""
    print_completion
}

# Run main function
main "$@"
