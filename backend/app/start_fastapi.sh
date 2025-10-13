#!/bin/bash
# FastAPI launcher for LLM-MS backend (portable, dynamic version)
set -e  # Exit on error

# --- Detect dynamic paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESIRED_PROJECT_ROOT="$SCRIPT_DIR"
DESIRED_VIRTUAL_ENV="$DESIRED_PROJECT_ROOT/venv"

# --- Basic config ---
LOG_LEVEL="info"
HOST="127.0.0.1"
PORT="62828"

echo "=========================================================="
echo "🚀 Starting FastAPI application (LLM-MS)"
echo "=========================================================="

# --- Check venv existence ---
if [ ! -d "$DESIRED_VIRTUAL_ENV" ]; then
    echo "❌ Virtual environment not found at: $DESIRED_VIRTUAL_ENV"
    echo "Run the installer first to create it."
    exit 1
fi

echo "✅ Activating virtual environment..."
export VIRTUAL_ENV="$DESIRED_VIRTUAL_ENV"
export PATH="$VIRTUAL_ENV/bin:$PATH"

# --- Set Python path dynamically ---
export PYTHONPATH="$DESIRED_PROJECT_ROOT"
echo "✅ PYTHONPATH set to: $PYTHONPATH"

# --- Move to backend directory ---
cd "$DESIRED_PROJECT_ROOT"
echo "📂 Working directory: $(pwd)"

# --- Verify app structure ---
if [ ! -f "app/main.py" ]; then
    echo "❌ app/main.py not found in $DESIRED_PROJECT_ROOT"
    exit 1
fi

# --- Verify uvicorn ---
if ! command -v uvicorn &>/dev/null; then
    echo "❌ uvicorn not installed in venv!"
    echo "Try: source venv/bin/activate && pip install fastapi uvicorn"
    exit 1
fi

# --- Launch FastAPI ---
echo "✅ Launching Uvicorn..."
echo "----------------------------------------------------------"
exec uvicorn app.main:app --host "$HOST" --port "$PORT" --log-level "$LOG_LEVEL"
