import os
import secrets
import logging
import traceback
import uvicorn
import sys

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse  # Removed: HTMLResponse

# Configure root logger to use standard output/error streams
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],  # Log to stdout/stderr only
)

logger = logging.getLogger("fastapi_app")
logger.info("Starting FastAPI application")

# Try importing configuration, or create default if not exists
try:
    from .config import MAX_CONTENT_LENGTH, ALLOWED_EXTENSIONS

    logger.info("Configuration loaded successfully")
except ImportError:
    logger.warning("Configuration not found, creating default config")
    # Create default config without upload folder
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.py")
    if not os.path.exists(config_path):
        with open(config_path, "w") as f:
            f.write(
                """
# Default configuration values
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB max upload size
ALLOWED_EXTENSIONS = {'pdf', 'txt', 'docx', 'md', 'jpg', 'jpeg', 'png'}
"""
            )
        logger.info(f"Created default config at {config_path}")

    # Import the newly created config
    from .config import MAX_CONTENT_LENGTH, ALLOWED_EXTENSIONS

    logger.info("Default configuration loaded")

# Create FastAPI instance
app = FastAPI(title="ChatUCY API")

# Set up CORS middleware (adjust origins as needed)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Store settings in app.state (optional)
app.state.SECRET_KEY = secrets.token_hex(32)
app.state.MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH


# Create a basic new_chat router if it doesn't exist
try:
    from app.api.endpoints import new_chat

    logger.info("Successfully imported new_chat router")
except ImportError:
    logger.warning("Creating a basic new_chat router")

    # Create the endpoints directory if it doesn't exist
    endpoints_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "api", "endpoints"
    )
    os.makedirs(endpoints_dir, exist_ok=True)

    # Create a basic new_chat.py file
    new_chat_path = os.path.join(endpoints_dir, "new_chat.py")
    if not os.path.exists(new_chat_path):
        with open(new_chat_path, "w") as f:
            f.write(
                """
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse # Changed from Jinja2Templates
import os

router = APIRouter()
# Removed: templates = Jinja2Templates(directory="app/templates")

@router.get("/new_chat")
async def chat_api(request: Request): # Renamed function for clarity
    # Return a simple JSON response instead of a template
    return JSONResponse(content={"message": "New chat session API endpoint"})
"""
            )
        logger.info(f"Created basic API new_chat.py at {new_chat_path}")

    # Now try importing again
    from app.api.endpoints import new_chat


# Import routers with error handling
try:
    # These imports should now succeed due to the dynamic creation blocks above
    from app.api.endpoints import new_chat

    app.include_router(new_chat.router)

    logger.info("Successfully included new_chat router")

    # Try to import other routers but don't fail if they're not available
    try:
        from app.api.endpoints import (
            chat,
            rag_chain,
            manage_history,
            model,
            llmms,
           
        )

        app.include_router(chat.router)
        app.include_router(rag_chain.router)
        app.include_router(manage_history.router)
        app.include_router(model.router)
   

    

        app.include_router(llmms.router)
        logger.info("Successfully included all additional API routers")
    except ImportError as e:
        logger.warning(f"Some additional API routers could not be imported: {str(e)}")
except ImportError as e:
    logger.error(f"Failed to import essential API routers (new_chat): {str(e)}")


# Add global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {str(exc)}")
    logger.error(traceback.format_exc())
    return JSONResponse(
        status_code=500, content={"error": "Internal server error", "message": str(exc)}
    )


# Run the app with an ASGI server such as uvicorn
if __name__ == "__main__":

    # Get port from environment variable with fallback to default
    port = int(os.environ.get("PORT", 62828))

    # Get host from environment variable with fallback to default
    host = os.environ.get("HOST", "0.0.0.0")

    logger.info(f"Starting API server on {host}:{port}")
    uvicorn.run("app.main:app", host=host, port=port, reload=True)
