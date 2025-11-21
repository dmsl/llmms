use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::sync::Mutex;
use tauri::{Manager, State};
use uuid::Uuid;

// MCP Bridge process state
struct McpBridgeState {
    tools: Mutex<Vec<McpTool>>,
    connected: Mutex<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpTool {
    name: String,
    description: Option<String>,
    parameters: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionInfo {
    session_id: String,
    student_id: String,
    device_id: String,
}

#[derive(Debug, Serialize)]
struct McpConnectResult {
    success: bool,
    tools: Vec<McpTool>,
    error: Option<String>,
}

/// Initialize MCP config on first run
#[tauri::command]
fn init_config(app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;

    let user_cfg = config_dir.join("mcp").join("config.json");

    // Only copy default config if it doesn't exist
    if !user_cfg.exists() {
        let default_cfg = app
            .path()
            .resolve("resources/default-mcp-config.json", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("Default config not found: {}", e))?;

        fs::create_dir_all(user_cfg.parent().unwrap())
            .map_err(|e| format!("Failed to create config directory: {}", e))?;

        fs::copy(default_cfg, &user_cfg)
            .map_err(|e| format!("Failed to copy default config: {}", e))?;
    }

    Ok(())
}

/// Connect to MCP server via Node bridge
#[tauri::command]
async fn mcp_connect(_url: String, state: State<'_, McpBridgeState>) -> Result<McpConnectResult, String> {
    // For now, we'll return mock data
    // In production, this would spawn the Node.js bridge process
    
    let tools = vec![
        McpTool {
            name: "filesystem.readFile".to_string(),
            description: Some("Read a file from the local filesystem".to_string()),
            parameters: Some(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to read" }
                },
                "required": ["path"]
            })),
        },
        McpTool {
            name: "filesystem.writeFile".to_string(),
            description: Some("Write content to a file".to_string()),
            parameters: Some(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to write" },
                    "content": { "type": "string", "description": "Content to write" }
                },
                "required": ["path", "content"]
            })),
        },
        McpTool {
            name: "filesystem.listDirectory".to_string(),
            description: Some("List files in a directory".to_string()),
            parameters: Some(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path" }
                },
                "required": ["path"]
            })),
        },
    ];

    *state.tools.lock().unwrap() = tools.clone();
    *state.connected.lock().unwrap() = true;

    Ok(McpConnectResult {
        success: true,
        tools,
        error: None,
    })
}

/// Call an MCP tool
#[tauri::command]
async fn mcp_call_tool(
    tool_name: String,
    args: Value,
    state: State<'_, McpBridgeState>,
) -> Result<Value, String> {
    // Validate connection
    if !*state.connected.lock().unwrap() {
        return Err("MCP not connected".to_string());
    }

    // For now, return mock results
    // In production, this would communicate with the Node bridge
    
    match tool_name.as_str() {
        "filesystem.readFile" => {
            let path = args.get("path").and_then(|p| p.as_str())
                .ok_or("Missing path parameter")?;
            
            // Actual file read (with safety checks)
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed to read file: {}", e))?;
            
            Ok(json!({ "content": content }))
        },
        "filesystem.listDirectory" => {
            let path = args.get("path").and_then(|p| p.as_str())
                .ok_or("Missing path parameter")?;
            
            let entries: Vec<String> = fs::read_dir(path)
                .map_err(|e| format!("Failed to read directory: {}", e))?
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect();
            
            Ok(json!({ "entries": entries }))
        },
        _ => Ok(json!({ "result": "Mock tool execution successful" })),
    }
}

/// Get session info for registration with server
#[tauri::command]
fn get_session_info() -> SessionInfo {
    SessionInfo {
        session_id: Uuid::new_v4().to_string(),
        student_id: whoami::username(),
        device_id: whoami::devicename(),
    }
}

/// Get saved session configuration
#[tauri::command]
fn get_saved_session(app: tauri::AppHandle) -> Result<Value, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;

    let session_file = config_dir.join("mcp").join("last_session.json");

    if session_file.exists() {
        let content = fs::read_to_string(session_file)
            .map_err(|e| format!("Failed to read session file: {}", e))?;
        let session: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse session file: {}", e))?;
        Ok(session)
    } else {
        Err("No saved session".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(McpBridgeState {
            tools: Mutex::new(Vec::new()),
            connected: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            init_config,
            mcp_connect,
            mcp_call_tool,
            get_session_info,
            get_saved_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
