// MCP Desktop Integration for ChatUCY
// This bridges Tauri's Rust backend with the web UI

const { invoke } = window.__TAURI__.core;

let mcpConnected = false;
let availableTools = [];
let currentSession = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    console.log('MCP Desktop Integration loaded');
    
    // Initialize config
    try {
        await invoke('init_config');
        console.log('MCP config initialized');
    } catch (error) {
        console.error('Failed to initialize MCP config:', error);
    }
    
    // Setup event listeners
    setupEventListeners();
    
    // Check for saved session
    await restoreSession();
});

function setupEventListeners() {
    // Connect button
    document.getElementById('mcp-connect-btn').addEventListener('click', () => {
        const modal = new bootstrap.Modal(document.getElementById('mcpConnectModal'));
        modal.show();
    });
    
    // Connect confirm
    document.getElementById('mcp-connect-confirm').addEventListener('click', async () => {
        const url = document.getElementById('mcp-url-input').value;
        await connectMCP(url);
        bootstrap.Modal.getInstance(document.getElementById('mcpConnectModal')).hide();
    });
    
    // Tools button
    document.getElementById('mcp-tools-btn').addEventListener('click', () => {
        showToolsList();
    });
}

async function connectMCP(url) {
    try {
        updateStatus('connecting', 'Connecting...');
        
        // Call Rust backend to connect to MCP server
        const result = await invoke('mcp_connect', { url });
        
        if (result.success) {
            mcpConnected = true;
            availableTools = result.tools || [];
            updateStatus('connected', `Connected (${availableTools.length} tools)`);
            
            // Enable tools button
            document.getElementById('mcp-tools-btn').disabled = false;
            document.getElementById('tool-count').textContent = availableTools.length;
            
            // Register session with server
            await registerSession();
        } else {
            throw new Error(result.error || 'Connection failed');
        }
    } catch (error) {
        console.error('MCP connection error:', error);
        updateStatus('disconnected', 'Connection failed');
        alert(`Failed to connect to MCP server: ${error.message}`);
    }
}

async function registerSession() {
    try {
        // Get device/student info
        const sessionInfo = await invoke('get_session_info');
        currentSession = sessionInfo;
        
        // Update UI
        document.getElementById('mcp-session-info').textContent = 
            `Session: ${sessionInfo.student_id} | Device: ${sessionInfo.device_id}`;
        
        // Register with backend server
        const response = await fetch('/api/mcp/register_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionInfo.session_id,
                student_id: sessionInfo.student_id,
                device_id: sessionInfo.device_id,
                tools: availableTools
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to register session with server');
        }
        
        // Start listening for tool requests from server
        await startToolRequestListener();
        
    } catch (error) {
        console.error('Session registration error:', error);
    }
}

async function startToolRequestListener() {
    // Setup WebSocket connection to receive tool requests from server
    const ws = new WebSocket(`ws://${window.location.host}/api/mcp/tool_requests`);
    
    ws.onmessage = async (event) => {
        const toolRequest = JSON.parse(event.data);
        await handleToolRequest(toolRequest);
    };
    
    ws.onerror = (error) => {
        console.error('Tool request listener error:', error);
    };
}

async function handleToolRequest(request) {
    const { tool_name, arguments: args, request_id } = request;
    
    try {
        // Check if tool requires write permission
        const requiresPermission = await checkToolPermission(tool_name, args);
        
        if (requiresPermission) {
            // Show permission dialog
            const approved = await requestUserPermission(tool_name, args);
            if (!approved) {
                // Send rejection back to server
                await sendToolResult(request_id, { error: 'Permission denied by user' });
                return;
            }
        }
        
        // Execute tool via Rust backend
        const result = await invoke('mcp_call_tool', { 
            toolName: tool_name, 
            args 
        });
        
        // Send result back to server
        await sendToolResult(request_id, result);
        
    } catch (error) {
        console.error('Tool execution error:', error);
        await sendToolResult(request_id, { error: error.message });
    }
}

async function checkToolPermission(toolName, args) {
    // Define rules for which operations require permission
    const writeOperations = ['writeFile', 'deleteFile', 'executeCommand', 'gitCommit', 'gitPush'];
    
    // Check if this is a write operation
    if (writeOperations.some(op => toolName.includes(op))) {
        return true;
    }
    
    // Check for sensitive paths
    if (args.path) {
        const sensitivePaths = ['/etc', '/home', '~/.ssh', '~/.aws'];
        if (sensitivePaths.some(p => args.path.startsWith(p))) {
            return true;
        }
    }
    
    return false;
}

async function requestUserPermission(toolName, args) {
    return new Promise((resolve) => {
        // Create permission modal
        const modalHTML = `
            <div class="permission-modal-overlay" id="perm-overlay">
                <div class="permission-modal">
                    <h5><i class="fa fa-exclamation-triangle text-warning me-2"></i>Permission Required</h5>
                    <p class="mt-3">The AI agent wants to perform the following action:</p>
                    <div class="alert alert-info">
                        <strong>Tool:</strong> ${toolName}<br>
                        <strong>Arguments:</strong><br>
                        <pre style="max-height: 200px; overflow-y: auto; font-size: 0.875rem;">${JSON.stringify(args, null, 2)}</pre>
                    </div>
                    <p><strong>Do you want to allow this action?</strong></p>
                    <div class="d-flex gap-2 justify-content-end">
                        <button class="btn btn-secondary" id="perm-deny">Deny</button>
                        <button class="btn btn-primary" id="perm-approve">Approve</button>
                    </div>
                </div>
            </div>
        `;
        
        const container = document.getElementById('permission-modal-container');
        container.innerHTML = modalHTML;
        
        // Add event listeners
        document.getElementById('perm-approve').addEventListener('click', () => {
            container.innerHTML = '';
            resolve(true);
        });
        
        document.getElementById('perm-deny').addEventListener('click', () => {
            container.innerHTML = '';
            resolve(false);
        });
    });
}

async function sendToolResult(requestId, result) {
    try {
        await fetch('/api/mcp/tool_result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: currentSession?.session_id,
                request_id: requestId,
                result
            })
        });
    } catch (error) {
        console.error('Failed to send tool result:', error);
    }
}

function showToolsList() {
    const listContainer = document.getElementById('mcp-tool-list');
    
    if (availableTools.length === 0) {
        listContainer.innerHTML = '<p class="text-muted">No tools available</p>';
    } else {
        listContainer.innerHTML = availableTools.map(tool => `
            <div class="tool-item">
                <div>
                    <strong>${tool.name}</strong>
                    <br><small class="text-muted">${tool.description || 'No description'}</small>
                </div>
                <span class="badge bg-success">Available</span>
            </div>
        `).join('');
    }
    
    const modal = new bootstrap.Modal(document.getElementById('mcpToolsModal'));
    modal.show();
}

function updateStatus(status, text) {
    const statusEl = document.getElementById('mcp-status');
    const textEl = document.getElementById('mcp-status-text');
    
    statusEl.className = 'mcp-status';
    
    if (status === 'connected') {
        statusEl.classList.add('connected');
        textEl.textContent = `MCP: ${text}`;
    } else if (status === 'connecting') {
        statusEl.classList.add('disconnected');
        textEl.textContent = `MCP: ${text}`;
    } else {
        statusEl.classList.add('disconnected');
        textEl.textContent = `MCP: ${text}`;
    }
}

async function restoreSession() {
    try {
        const savedSession = await invoke('get_saved_session');
        if (savedSession && savedSession.url) {
            await connectMCP(savedSession.url);
        }
    } catch (error) {
        console.log('No saved session to restore');
    }
}

// Export for use in iframe
window.mcpDesktopAPI = {
    isConnected: () => mcpConnected,
    getTools: () => availableTools,
    callTool: async (toolName, args) => {
        if (!mcpConnected) {
            throw new Error('MCP not connected');
        }
        return await invoke('mcp_call_tool', { toolName, args });
    }
};
