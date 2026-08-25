#!/bin/bash

# Exit on error
set -e

# Resolve paths from this launcher so the service also works after the
# repository is moved or cloned under a different user/home directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESIRED_PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESIRED_VIRTUAL_ENV="$SCRIPT_DIR/venv"

echo "Starting FastAPI application..."

# Activate the virtual environment
echo "Activating virtual environment at: $DESIRED_VIRTUAL_ENV"
export VIRTUAL_ENV="$DESIRED_VIRTUAL_ENV"
if [ ! -d "$VIRTUAL_ENV" ]; then
    echo "Error: Virtual environment directory $VIRTUAL_ENV does not exist!"
    exit 1
fi
export PATH="$VIRTUAL_ENV/bin:$PATH"

# Set PYTHONPATH so your modules are discovered (project root)
export PYTHONPATH="$DESIRED_PROJECT_ROOT"
echo "PYTHONPATH set to: $PYTHONPATH"

# Configure logging to go to standard output (good for Apache capturing)
export LOG_LEVEL="info"

# Ensure the application directory exists within the desired project root
if [ ! -d "$DESIRED_PROJECT_ROOT/app" ]; then
    echo "Error: Application directory '$DESIRED_PROJECT_ROOT/app' does not exist!"
    exit 1
fi

# Change directory to the project root
cd "$DESIRED_PROJECT_ROOT"
echo "Changed directory to: $(pwd)"

# Check if the main.py file exists (relative to DESIRED_PROJECT_ROOT)
if [ ! -f "app/main.py" ]; then
    echo "Error: app/main.py not found in $(pwd)!"
    exit 1
fi

# Check if uvicorn is installed
if ! command -v uvicorn &> /dev/null; then
    echo "Error: uvicorn is not installed. Please install it with: pip install uvicorn"
    exit 1
fi

# Start Uvicorn with the proper module path, ensuring output is captured
echo "Starting uvicorn server..."
uvicorn app.main:app --host 127.0.0.1 --port 62828 --reload --log-level $LOG_LEVEL 
