"""
Input Validation Utilities - Non-breaking, optional validators for input sanitization

Provides optional validators that can be applied to endpoints without breaking
existing valid requests. Validators only reject extreme or malformed cases.

Usage:
    from app.core.validation import validate_message_length, validate_string_field
    
    @router.post("/send_message")
    async def send_message(request: Request):
        data = await request.json()
        validate_message_length(data.get('message', ''), max_length=50000)
        # ... continue processing
"""

from typing import Optional, Any, Dict, List
from fastapi import HTTPException, status


class ValidationError(HTTPException):
    """Custom validation error that returns 400 Bad Request"""
    def __init__(self, detail: str):
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail
        )


def validate_string_field(value: Any, field_name: str, min_length: int = 0, 
                         max_length: Optional[int] = None, required: bool = False) -> str:
    """
    Validate a string field
    
    Args:
        value: Value to validate
        field_name: Name of field for error messages
        min_length: Minimum string length (default: 0)
        max_length: Maximum string length (default: None, no limit)
        required: If True, value cannot be empty
    
    Returns:
        Validated string value
        
    Raises:
        ValidationError: If validation fails
    """
    # Handle missing/None values
    if value is None:
        if required:
            raise ValidationError(f"{field_name} is required")
        return ""
    
    # Convert to string
    if not isinstance(value, str):
        try:
            value = str(value)
        except Exception as e:
            raise ValidationError(f"{field_name} must be a string: {str(e)}")
    
    # Check length
    if len(value) < min_length:
        raise ValidationError(
            f"{field_name} must be at least {min_length} characters"
        )
    
    if max_length is not None and len(value) > max_length:
        raise ValidationError(
            f"{field_name} must not exceed {max_length} characters (got {len(value)})"
        )
    
    # Check required non-empty
    if required and not value.strip():
        raise ValidationError(f"{field_name} cannot be empty")
    
    return value


def validate_message_length(message: Any, max_length: int = 50000) -> str:
    """
    Validate message length before sending to LLM
    
    Args:
        message: Message text
        max_length: Maximum allowed length in characters
        
    Returns:
        Validated message
        
    Raises:
        ValidationError: If message too long
    """
    return validate_string_field(
        message,
        "Message",
        min_length=1,
        max_length=max_length,
        required=True
    )


def validate_workspace_name(name: Any, max_length: int = 100) -> str:
    """
    Validate workspace name
    
    Args:
        name: Workspace name
        max_length: Maximum allowed length
        
    Returns:
        Validated name
        
    Raises:
        ValidationError: If invalid
    """
    return validate_string_field(
        name,
        "Workspace name",
        min_length=1,
        max_length=max_length,
        required=True
    )


def validate_session_name(name: Any, max_length: int = 100) -> str:
    """
    Validate chat session name
    
    Args:
        name: Session name
        max_length: Maximum allowed length
        
    Returns:
        Validated name
        
    Raises:
        ValidationError: If invalid
    """
    return validate_string_field(
        name,
        "Session name",
        min_length=1,
        max_length=max_length,
        required=True
    )


def validate_list_not_empty(value: Any, field_name: str = "List") -> List:
    """
    Validate that a list is not empty
    
    Args:
        value: Value to validate
        field_name: Name for error messages
        
    Returns:
        Validated list
        
    Raises:
        ValidationError: If invalid
    """
    if not isinstance(value, list):
        raise ValidationError(f"{field_name} must be a list")
    
    if len(value) == 0:
        raise ValidationError(f"{field_name} cannot be empty")
    
    return value


def validate_dict_keys(data: Any, required_keys: List[str], 
                      field_name: str = "Data") -> Dict:
    """
    Validate that a dict contains all required keys
    
    Args:
        data: Dictionary to validate
        required_keys: List of required key names
        field_name: Name for error messages
        
    Returns:
        Validated dict
        
    Raises:
        ValidationError: If missing keys
    """
    if not isinstance(data, dict):
        raise ValidationError(f"{field_name} must be a dictionary")
    
    missing = [k for k in required_keys if k not in data]
    if missing:
        raise ValidationError(
            f"{field_name} missing required keys: {', '.join(missing)}"
        )
    
    return data


def validate_request_body(data: Any, required_keys: Optional[List[str]] = None,
                         max_size: Optional[int] = None) -> Dict:
    """
    Validate API request body
    
    Args:
        data: Request body data
        required_keys: List of required top-level keys
        max_size: Maximum size in bytes (approximate, based on str length)
        
    Returns:
        Validated data
        
    Raises:
        ValidationError: If invalid
    """
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object")
    
    if required_keys:
        validate_dict_keys(data, required_keys, "Request body")
    
    if max_size is not None:
        # Approximate size as string length
        data_str = str(data)
        if len(data_str) > max_size:
            raise ValidationError(
                f"Request too large (max {max_size} bytes, got ~{len(data_str)})"
            )
    
    return data


def validate_algorithm_type(algo_type: Any, allowed: Optional[List[str]] = None) -> str:
    """
    Validate algorithm type parameter
    
    Args:
        algo_type: Algorithm type value
        allowed: List of allowed values (default: ['stepwise', 'mab', 'default'])
        
    Returns:
        Validated algorithm type
        
    Raises:
        ValidationError: If invalid
    """
    if allowed is None:
        allowed = ['stepwise', 'mab', 'default']
    
    algo_type = str(algo_type).lower().strip()
    
    if algo_type not in allowed:
        raise ValidationError(
            f"Invalid algorithm type '{algo_type}'. Allowed: {', '.join(allowed)}"
        )
    
    return algo_type


def validate_file_size(file_size: int, max_bytes: int) -> int:
    """
    Validate file size
    
    Args:
        file_size: File size in bytes
        max_bytes: Maximum allowed size in bytes
        
    Returns:
        Validated file size
        
    Raises:
        ValidationError: If too large
    """
    if file_size > max_bytes:
        max_mb = max_bytes / (1024 * 1024)
        actual_mb = file_size / (1024 * 1024)
        raise ValidationError(
            f"File too large: {actual_mb:.1f}MB exceeds limit of {max_mb:.1f}MB"
        )
    
    return file_size


# Optional middleware-like function to validate common request patterns
def validate_chat_request(data: Dict) -> Dict:
    """
    Validate a chat completion request
    
    Applies optional validation to messages without breaking existing payloads.
    Only rejects extreme cases (empty messages, >50KB messages).
    
    Args:
        data: Request data
        
    Returns:
        Validated data (unchanged if valid)
        
    Raises:
        ValidationError: If validation fails
    """
    # Validate messages if present
    if 'messages' in data:
        messages = data['messages']
        if not isinstance(messages, list):
            raise ValidationError("'messages' must be a list")
        
        if len(messages) == 0:
            raise ValidationError("'messages' cannot be empty")
        
        # Validate each message
        for i, msg in enumerate(messages):
            if not isinstance(msg, dict):
                raise ValidationError(f"Message {i} must be a dict")
            
            if 'content' in msg and isinstance(msg['content'], str):
                if len(msg['content']) == 0:
                    raise ValidationError(f"Message {i} content cannot be empty")
                if len(msg['content']) > 50000:
                    raise ValidationError(
                        f"Message {i} content too long: {len(msg['content'])} chars (max 50000)"
                    )
    
    # Validate model if present
    if 'model' in data:
        model = data['model']
        if isinstance(model, str) and len(model) == 0:
            raise ValidationError("'model' cannot be empty")
    
    return data
