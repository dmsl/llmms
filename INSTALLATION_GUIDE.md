# LLM-MS Installation Guide

**Simple step-by-step installation for Ubuntu 22.04/24.04**

This guide will help you install LLM-MS (LLM Meta Search) on a fresh Ubuntu server.

---

## Quick Installation (Recommended)

**For a fully automated installation, use our installation script:**

```bash
# Clone the repository
cd ~
git clone https://github.com/dmsl/llmms.git
cd llmms

# Make the installer executable
chmod +x install.sh

# Run the installer
./install.sh
```

The script will automatically:
- ✅ Check system requirements
- ✅ Install all dependencies (Ollama, ChromaDB, Python, Apache)
- ✅ Download AI models
- ✅ Configure all services
- ✅ Verify the installation

**Installation takes 20-30 minutes.**

After installation completes, access LLM-MS at: `http://your-server-ip`

---

## Manual Installation

If you prefer to install manually or the automated script doesn't work, follow these steps:

---
## What You'll Install

- **Ollama** - Runs AI models locally
- **ChromaDB** - Stores document embeddings for search
- **Python & FastAPI** - Backend server
- **Apache2** - Web server

---

## Prerequisites

- Ubuntu 22.04 or 24.04 LTS
- At least 16GB RAM (32GB recommended)
- 50GB free disk space
- Internet connection
- sudo privileges

---

## Step 1: Update System

```bash
sudo apt update && sudo apt upgrade -y
```

---

## Step 2: Install Ollama

Install Ollama using the official script:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify installation:

```bash
ollama --version
```

Start Ollama and enable it to run at startup:

```bash
sudo systemctl start ollama
sudo systemctl enable ollama
sudo systemctl status ollama
```

Download required AI models (this will take 10-15 minutes):

```bash
# Embedding model (required for search)
ollama pull nomic-embed-text

# AI models
ollama pull llama3.1:8b
ollama pull mistral:7b
ollama pull qwen2.5:7b
```

---

## Step 3: Install Python and Dependencies

Install Python 3:

```bash
sudo apt install -y python3 python3-pip python3-venv
```

---

## Step 4: Install ChromaDB

Install ChromaDB:

```bash
pip3 install chromadb
```

Create a directory for ChromaDB data:

```bash
mkdir -p ~/chromadb_data
```

Create a systemd service to run ChromaDB automatically:

```bash
sudo tee /etc/systemd/system/chromadb.service > /dev/null <<EOF
[Unit]
Description=ChromaDB Service
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME
ExecStart=/usr/local/bin/chroma run --path $HOME/chromadb_data --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

Start ChromaDB:

```bash
sudo systemctl daemon-reload
sudo systemctl start chromadb
sudo systemctl enable chromadb
sudo systemctl status chromadb
```

---

## Step 5: Setup LLM-MS Application

**Download the LLM-MS application from GitHub:**

```bash
cd ~
git clone https://github.com/dmsl/llmms.git
cd llmms/backend
```

Create a Python virtual environment:

```bash
python3 -m venv venv
```

Activate the virtual environment:

```bash
source venv/bin/activate
```

Install Python packages:

```bash
pip install --upgrade pip

# Core packages
pip install fastapi uvicorn[standard]
pip install ollama chromadb
pip install python-multipart werkzeug

# Additional packages
pip install numpy pandas pydantic
pip install pypdf PyPDF2 python-docx pillow openpyxl
```

Create the uploads directory:

```bash
mkdir -p /tmp/uploads
```

---

## Step 6: Create FastAPI Service

Create a systemd service to run the FastAPI backend:

```bash
sudo tee /etc/systemd/system/llmms-api.service > /dev/null <<EOF
[Unit]
Description=LLM-MS FastAPI Service
After=network.target ollama.service chromadb.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/llmms/backend
Environment="PYTHONPATH=$HOME/llmms/backend"
ExecStart=$HOME/llmms/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 62828
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

Start the API service:

```bash
sudo systemctl daemon-reload
sudo systemctl start llmms-api
sudo systemctl enable llmms-api
sudo systemctl status llmms-api
```

---

## Step 7: Install and Configure Apache2

Install Apache2:

```bash
sudo apt install -y apache2
```

Enable required Apache modules:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
```

Create Apache configuration for LLM-MS:

```bash
sudo tee /etc/apache2/sites-available/llmms.conf > /dev/null <<EOF
<VirtualHost *:80>
    ServerName localhost
    
    DocumentRoot $HOME/llmms/frontend
    
    <Directory $HOME/llmms/frontend>
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
```

Enable the site and restart Apache:

```bash
sudo a2dissite 000-default.conf
sudo a2ensite llmms.conf
sudo apache2ctl configtest
sudo systemctl restart apache2
```

---

## Step 8: Verify Installation

Check that all services are running:

```bash
# Check Ollama
systemctl status ollama

# Check ChromaDB
systemctl status chromadb

# Check FastAPI
systemctl status llmms-api

# Check Apache
systemctl status apache2
```

Test connectivity:

```bash
# Test Ollama
curl http://localhost:11434

# Test ChromaDB
curl http://localhost:8000/api/v1/heartbeat

# Test FastAPI
curl http://localhost:62828/get_models
```

---

## Step 9: Access the Application

Open your web browser and go to:

```
http://your-server-ip
```

Replace `your-server-ip` with:
- `localhost` if accessing from the same machine
- Your server's IP address if accessing remotely

---

## GPU Acceleration (Optional - Recommended)

GPU acceleration makes AI models **10-50x faster**. Choose your GPU type:

### For NVIDIA GPUs

**Step 1: Install NVIDIA Driver**

```bash
sudo add-apt-repository ppa:graphics-drivers/ppa -y
sudo apt update
sudo ubuntu-drivers autoinstall
sudo reboot
```

**Step 2: Verify Installation**

After reboot:
```bash
nvidia-smi
```

You should see your GPU listed.

**Step 3: Configure Ollama for GPU**

```bash
sudo systemctl edit ollama.service
```

Add these lines:
```
[Service]
Environment="CUDA_VISIBLE_DEVICES=0"
```

Save and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Step 4: Test GPU**

```bash
# Run a model and watch GPU usage
nvidia-smi -l 1
```

In another terminal:
```bash
ollama run llama3.1:8b "Hello"
```

You should see GPU usage spike.

---

### For AMD GPUs

**Step 1: Install ROCm**

```bash
# Download installer
wget https://repo.radeon.com/amdgpu-install/6.2.4/ubuntu/jammy/amdgpu-install_6.2.60204-1_all.deb

# Install
sudo apt install ./amdgpu-install_6.2.60204-1_all.deb

# Install ROCm
sudo amdgpu-install --no-dkms --usecase=rocm

# Add user to groups
sudo usermod -a -G render,video $USER

sudo reboot
```

**Step 2: Install Ollama ROCm Version**

```bash
# Download ROCm version
curl -L https://ollama.com/download/ollama-linux-amd64-rocm.tgz -o ollama-rocm.tgz

# Extract
sudo tar -C /usr -xzf ollama-rocm.tgz
```

**Step 3: Configure for AMD GPU**

```bash
sudo systemctl edit ollama.service
```

Add these lines (adjust gfx version for your GPU):
```
[Service]
Environment="HSA_OVERRIDE_GFX_VERSION=10.3.0"
Environment="HIP_VISIBLE_DEVICES=0"
```

Common gfx versions:
- RX 6600/6700: `10.3.0`
- RX 7700/7900: `11.0.0`

Save and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Step 4: Test GPU**

```bash
# Monitor GPU
watch -n 1 rocm-smi
```

In another terminal:
```bash
ollama run llama3.1:8b "Hello"
```

---

## Troubleshooting

### Service won't start

Check logs:
```bash
sudo journalctl -u llmms-api -n 50
sudo journalctl -u chromadb -n 50
sudo journalctl -u ollama -n 50
```

### Can't access website

Check Apache logs:
```bash
sudo tail -f /var/log/apache2/llmms_error.log
```

Check if port 80 is open:
```bash
sudo netstat -tlnp | grep :80
```

### Models are slow (CPU only)

Install GPU acceleration (see Step 9 above)

### Port already in use

Check what's using the port:
```bash
sudo lsof -i :62828
sudo lsof -i :8000
sudo lsof -i :11434
```

---

## Quick Commands Reference

```bash
# Restart all services
sudo systemctl restart ollama chromadb llmms-api apache2

# Check all services
sudo systemctl status ollama chromadb llmms-api apache2

# View logs
sudo journalctl -u llmms-api -f

# Pull new AI model
ollama pull model-name

# List installed models
ollama list
```

---

## Next Steps

1. **Secure your installation** - Set up firewall and SSL certificate
2. **Add more models** - Use `ollama pull` to add more AI models
3. **Configure backups** - Back up your ChromaDB data regularly

---

## Getting Help

- Check logs: `sudo journalctl -u llmms-api -f`
- Ollama docs: https://ollama.com/docs
- FastAPI docs: https://fastapi.tiangolo.com

---

## Ports Used

- **11434** - Ollama
- **8000** - ChromaDB
- **62828** - FastAPI Backend
- **80** - Apache Web Server

---

**Installation Complete!** 🎉

Your LLM-MS system is now running at http://your-server-ip
