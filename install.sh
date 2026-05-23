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
GPU_REBOOT_REQUIRED=0
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

# Prompt helper that works with both direct execution and `curl | bash`.
# If no TTY is available, require AUTO_CONFIRM=true to continue.
confirm_or_exit() {
    local prompt="$1"
    local reply=""

    if [ "${AUTO_CONFIRM:-false}" = "true" ]; then
        log_info "AUTO_CONFIRM=true -> accepting prompt: $prompt"
        return 0
    fi

    if [ -t 0 ] || [ -r /dev/tty ]; then
        read -r -p "$prompt (y/n) " reply </dev/tty
        if [[ "$reply" =~ ^[Yy]$ ]]; then
            return 0
        fi
    fi

    log_info "Installation cancelled by user"
    exit 0
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    log_error "Please do not run this script as root. Run as normal user with sudo privileges."
    exit 1
fi

# Check if user has sudo privileges
if ! sudo -v; then
    log_error "This script requires sudo privileges."
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
        confirm_or_exit "Continue anyway?"
    else
        log_success "RAM: ${TOTAL_RAM}GB"
    fi
    
    # Check disk space
    AVAILABLE_SPACE=$(df -BG ~ | tail -1 | awk '{print $4}' | sed 's/G//')
    if [ "$AVAILABLE_SPACE" -lt 50 ]; then
        log_warning "Only ${AVAILABLE_SPACE}GB free space available. 50GB+ recommended."
        confirm_or_exit "Continue anyway?"
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

    # Detect where the repo root is
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # If the script is being executed from inside backend/app, go up twice
    if [[ "$SCRIPT_DIR" == *"/backend/app"* ]]; then
        PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
    else
        PROJECT_ROOT="$SCRIPT_DIR"
    fi

    BACKEND_DIR="$PROJECT_ROOT/backend"
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

    # --- Create systemd service ---
    sudo tee /etc/systemd/system/llmms-api.service > /dev/null <<EOF
[Unit]
Description=LLM-MS FastAPI Service
After=network.target ollama.service

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

    sudo chmod +x "$LAUNCHER"
    sudo systemctl daemon-reload
    sudo systemctl enable llmms-api
    sudo systemctl restart llmms-api

    sleep 2

    if systemctl is-active --quiet llmms-api; then
        log_success "FastAPI service is running successfully!"
    else
        log_error "FastAPI service failed to start. Check with: sudo journalctl -u llmms-api -n 50"
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
    
    # Proxy API requests to FastAPI and Ollama OpenAI-compatible API
    ProxyPreserveHost On
    ProxyPass /api/v1/ http://127.0.0.1:11434/v1/
    ProxyPassReverse /api/v1/ http://127.0.0.1:11434/v1/
    ProxyPass /api/ws/ ws://127.0.0.1:62828/ws/
    ProxyPassReverse /api/ws/ ws://127.0.0.1:62828/ws/
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

# Patch existing Apache vhost configs to expose /api/v1 and FastAPI websocket routes
patch_apache_openai_v1_proxy() {
    log_info "Patching Apache vhost config(s) for /api/v1 and websocket proxy paths..."

    local conf_files
    conf_files=$(grep -Rsl "ProxyPass /api/" /etc/apache2/sites-available /etc/apache2/sites-enabled 2>/dev/null || true)

    if [ -z "$conf_files" ]; then
        log_warning "No Apache vhost with /api proxy found to patch."
        return 0
    fi

    while IFS= read -r conf; do
        [ -z "$conf" ] && continue
        if grep -q "ProxyPass /api/v1/" "$conf" && grep -q "ProxyPass /api/ws/" "$conf"; then
            log_info "Already patched: $conf"
            continue
        fi

        log_info "Patching: $conf"
        sudo awk '
            /ProxyPass[[:space:]]+\/api\// && !inserted {
                print "    ProxyPass /api/v1/ http://127.0.0.1:11434/v1/"
                print "    ProxyPassReverse /api/v1/ http://127.0.0.1:11434/v1/"
                print "    ProxyPass /api/ws/ ws://127.0.0.1:62828/ws/"
                print "    ProxyPassReverse /api/ws/ ws://127.0.0.1:62828/ws/"
                inserted=1
            }
            { print }
        ' "$conf" | sudo tee "$conf.tmp" > /dev/null
        sudo mv "$conf.tmp" "$conf"
    done <<< "$conf_files"

    if sudo apache2ctl configtest; then
        sudo systemctl reload apache2
        log_success "Apache patched and reloaded with /api/v1 and /api/ws proxy paths."
    else
        log_error "Apache config test failed after patch."
        exit 1
    fi
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."
    
    # Check all services
    services=("ollama" "llmms-api" "apache2")
    
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
    echo "  • Check services: sudo systemctl status ollama llmms-api apache2"
    echo "  • View API logs: sudo journalctl -u llmms-api -f"
    echo "  • Restart all: sudo systemctl restart ollama llmms-api apache2"
    echo "  • Pull new model: ollama pull model-name"
    echo ""
    
    if [ "$GPU_REBOOT_REQUIRED" -eq 1 ]; then
        log_warning "Reboot is required to activate the newly installed NVIDIA driver."
        echo "  • Reboot now: sudo reboot"
        echo "  • Verify after reboot: nvidia-smi"
    elif [ -n "$GPU_DETECTED" ]; then
        log_info "GPU detected and NVIDIA driver appears available."
    fi
}
#############################################################
# GPU Driver Setup (Tesla V100 - Ubuntu package installation)
#############################################################

setup_gpu_driver_vm() {
    log_info "Initializing NVIDIA Tesla V100 driver setup using Ubuntu packages..."

    echo -e "\n=========================================================="
    echo "STEP 1: Detecting NVIDIA GPU"
    echo "=========================================================="

    if ! lspci | grep -i "NVIDIA" &>/dev/null; then
        log_warning "No NVIDIA GPU detected. Skipping NVIDIA driver setup."
        return 0
    fi

    log_success "NVIDIA GPU detected:"
    lspci | grep -i "NVIDIA" | awk '{$1=$1;print}'

    echo -e "\n=========================================================="
    echo "STEP 2: Showing available NVIDIA drivers"
    echo "=========================================================="
    sudo apt update

    log_info "Available NVIDIA server drivers:"
    apt-cache search '^nvidia-driver-[0-9]+-server$' | sort || true

    echo ""
    log_info "Ubuntu recommended driver:"
    ubuntu-drivers devices || true

    echo ""
    log_info "Checking nvidia-driver-580-server availability:"
    apt-cache policy nvidia-driver-580-server

    if command -v nvidia-smi &>/dev/null; then
        log_success "NVIDIA driver already appears installed:"
        nvidia-smi
        return 0
    fi

    echo -e "\n=========================================================="
    echo "STEP 3: Installing required packages"
    echo "=========================================================="
    sudo apt install -y linux-headers-$(uname -r) build-essential dkms ubuntu-drivers-common

    echo -e "\n=========================================================="
    echo "STEP 4: Installing NVIDIA server driver"
    echo "=========================================================="
    sudo apt install -y nvidia-driver-580-server

    echo -e "\n=========================================================="
    echo "STEP 5: Driver installed"
    echo "=========================================================="
    log_success "NVIDIA driver package installed."
    log_warning "A reboot is required before NVIDIA becomes active."
    GPU_REBOOT_REQUIRED=1
    echo ""
    echo "Installation will continue. Reboot after setup completes."
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
    check_ubuntu_version
    check_requirements
    
    echo ""
    log_warning "This script will install:"
    echo "  • Ollama (AI model runtime)"
    echo "  • Python packages (FastAPI, etc.)"
    echo "  • Apache2 web server"
    echo "  • LLM-MS application"
    echo "  • AI models (llama3.1:8b, mistral:7b, qwen2.5:7b)"
    echo ""
    log_warning "This will take approximately 20-30 minutes."
    echo ""
    
    confirm_or_exit "Continue with installation?"
    
    echo ""
    log_info "Starting installation..."
    echo ""
    
    setup_gpu_driver_vm

    # Run installation steps
    update_system
    install_ollama
    install_python
    setup_llmms
    create_fastapi_service
    install_apache
    patch_apache_openai_v1_proxy
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
