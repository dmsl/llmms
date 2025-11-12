# ===============================================
# 🚀 FastAPI launcher for LLM-MS (Windows PowerShell)
# ===============================================

$ErrorActionPreference = "Stop"

# --- Dynamic paths ---
# ScriptDir → backend/app/
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Project root is two levels up (../../)
$BackendDir = Split-Path $ScriptDir -Parent
$ProjectRoot = Split-Path $BackendDir -Parent

$VenvPath = Join-Path $ProjectRoot "venv"

# --- Config ---
$Host = "127.0.0.1"
$Port = 62828
$LogLevel = "info"

Write-Host "=========================================================="
Write-Host "🚀 Starting FastAPI application (LLM-MS)"
Write-Host "=========================================================="

# --- Check venv existence ---
if (!(Test-Path $VenvPath)) {
    Write-Host "❌ Virtual environment not found at: $VenvPath"
    Write-Host "Run the installer first to create it."
    exit 1
}

# --- Activate venv ---
$ActivateScript = Join-Path $VenvPath "Scripts\Activate.ps1"
if (!(Test-Path $ActivateScript)) {
    Write-Host "❌ Cannot find Activate.ps1 in venv!"
    exit 1
}

Write-Host "✅ Activating virtual environment..."
. $ActivateScript

# --- Set PYTHONPATH ---
$env:PYTHONPATH = $ProjectRoot
Write-Host "✅ PYTHONPATH set to $env:PYTHONPATH"

# --- Verify app/main.py exists ---
if (!(Test-Path (Join-Path $ScriptDir "main.py"))) {
    Write-Host "❌ main.py not found in $ScriptDir"
    exit 1
}

# --- Verify uvicorn ---
if (-not (Get-Command uvicorn -ErrorAction SilentlyContinue)) {
    Write-Host "❌ uvicorn not found! Installing..."
    pip install fastapi uvicorn
}

# --- Launch FastAPI ---
Write-Host "✅ Launching Uvicorn..."
Write-Host "----------------------------------------------------------"
cd $ScriptDir
uvicorn main:app --host $Host --port $Port --log-level $LogLevel
