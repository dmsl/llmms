# Configuration settings for the FastAPI application

# Maximum allowed file size (in bytes) - set to 16MB
MAX_CONTENT_LENGTH = 16 * 1024 * 1024

# Allowed file extensions for uploads
ALLOWED_EXTENSIONS = {"txt", "pdf", "png", "jpg", "jpeg", "gif"}

# Upload folder path - you may want to adjust this path based on your project structure
UPLOAD_FOLDER = "uploads"

# You can add more configuration variables below as needed
# For example:
# API_VERSION = "v1"
# DEBUG = True
# BASE_URL = "http://localhost:8000"
