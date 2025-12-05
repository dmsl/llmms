// Alpine.js Component for chat.html
// Handles chat functionality for both web and Electron modes
// Uses agent-integration.js for consistent LLM interactions across platforms

// Import agent integration (handles both web and Electron modes)
import { askAgent } from '../agent-integration.js';
import { basicToolSchemas } from '../tools.js';
window.askAgent = askAgent;

// API Base URL for model loading (Electron will use this to get available models)
const API_BASE_URL = 'https://chatucy.cs.ucy.ac.cy/api';

function chatApp() {
    return {
        sidebarOpen: typeof window !== 'undefined' && window.innerWidth >= 1024, // Open on desktop (lg breakpoint)
        userInput: '',
        messages: [],
        sessions: [],
        currentSession: null,
        isLoading: false,
        selectedModel: 'Select Model',
        availableModels: [],
        localRagEnabled: false,
        uploadedFile: null,
        uploadedFileName: '',
        uploadedFilePreview: null, // Base64 preview for images
        modal: {
            show: false,
            type: '', // 'edit' or 'delete'
            value: '',
            sessionId: null
        },
        mcpConfigModal: {
            show: false,
            activeTab: 'servers',
            servers: [],
            tools: [], // Flat list of all tools
            toolsByServer: {}, // Organized by server
            newServerForm: {
                show: false,
                name: '',
                url: '',
                autoConnect: true,
                error: ''
            },
            async loadServers() {
                if (window.desktop?.isElectron && window.desktop?.getMCPConfig) {
                    // Desktop mode: Load from Electron config
                    const config = await window.desktop.getMCPConfig();
                    this.servers = config.servers || [];
                } else if (window.mcpConfigManager) {
                    // Web mode: Load from localStorage
                    this.servers = window.mcpConfigManager.getServers();
                }
            },
            async loadTools() {
                if (window.desktop?.isElectron && window.desktop?.getToolsByServer) {
                    // Desktop mode: Get tools from Electron
                    this.toolsByServer = await window.desktop.getToolsByServer() || {};
                    
                    // Also build a flat list for compatibility
                    this.tools = [];
                    for (const serverName in this.toolsByServer) {
                        const server = this.toolsByServer[serverName];
                        if (server.tools) {
                            this.tools.push(...server.tools.map(t => ({
                                ...t,
                                serverName: serverName,
                                serverType: server.type
                            })));
                        }
                    }
                    
                    console.log('[ChatApp] Loaded tools from', Object.keys(this.toolsByServer).length, 'servers');
                } else if (window.mcpBrowserClient) {
                    // Web mode: Get tools from browser client
                    this.tools = window.mcpBrowserClient.getAllTools();
                    
                    // Organize by server
                    this.toolsByServer = {};
                    for (const tool of this.tools) {
                        if (!this.toolsByServer[tool.serverName]) {
                            this.toolsByServer[tool.serverName] = {
                                type: 'remote-web',
                                tools: []
                            };
                        }
                        this.toolsByServer[tool.serverName].tools.push(tool);
                    }
                }
            },
            openConfigFile() {
                if (window.desktop?.isElectron && window.desktop?.openMCPConfig) {
                    window.desktop.openMCPConfig();
                }
            },
            onToolToggle(tool) {
                if (window.desktop?.isElectron && window.desktop?.toggleTool) {
                    window.desktop.toggleTool(tool.name, tool.enabled);
                }
            },
            async addWebServer() {
                // Web-only: Add new remote MCP server
                if (window.desktop?.isElectron) {
                    alert('Use the config file editor for Electron mode');
                    return;
                }
                
                this.newServerForm.error = '';
                
                // Validate
                if (!this.newServerForm.name || !this.newServerForm.url) {
                    this.newServerForm.error = 'Name and URL are required';
                    return;
                }
                
                if (!window.MCPConfigManager.isValidWebSocketUrl(this.newServerForm.url)) {
                    this.newServerForm.error = 'Invalid WebSocket URL (must start with ws:// or wss://)';
                    return;
                }
                
                try {
                    // Save to config
                    window.mcpConfigManager.saveServer({
                        name: this.newServerForm.name,
                        url: this.newServerForm.url,
                        autoConnect: this.newServerForm.autoConnect
                    });
                    
                    // Connect if autoConnect is enabled
                    if (this.newServerForm.autoConnect) {
                        await window.mcpBrowserClient.connect(
                            this.newServerForm.name,
                            this.newServerForm.url
                        );
                    }
                    
                    // Reload servers and tools
                    await this.loadServers();
                    await this.loadTools();
                    
                    // Reset form
                    this.newServerForm.show = false;
                    this.newServerForm.name = '';
                    this.newServerForm.url = '';
                    this.newServerForm.autoConnect = true;
                    
                    console.log('[ChatApp Web] Server added successfully');
                } catch (error) {
                    this.newServerForm.error = error.message;
                    console.error('[ChatApp Web] Failed to add server:', error);
                }
            },
            async removeWebServer(serverName) {
                // Web-only: Remove remote MCP server
                if (window.desktop?.isElectron) {
                    alert('Use the config file editor for Electron mode');
                    return;
                }
                
                try {
                    // Disconnect if connected
                    if (window.mcpBrowserClient.isConnected(serverName)) {
                        window.mcpBrowserClient.disconnect(serverName);
                    }
                    
                    // Remove from config
                    window.mcpConfigManager.removeServer(serverName);
                    
                    // Reload servers and tools
                    await this.loadServers();
                    await this.loadTools();
                    
                    console.log('[ChatApp Web] Server removed successfully');
                } catch (error) {
                    alert('Failed to remove server: ' + error.message);
                    console.error('[ChatApp Web] Failed to remove server:', error);
                }
            }
        },
        
        async init() {
            // Handle window resize to adjust sidebar visibility
            window.addEventListener('resize', () => {
                if (window.innerWidth >= 1024) {
                    this.sidebarOpen = true; // Keep sidebar open on desktop
                }
            });
            
            // Load sessions from sessionStorage
            const savedSessions = sessionStorage.getItem('chat_sessions');
            if (savedSessions) {
                this.sessions = JSON.parse(savedSessions);
                if (this.sessions.length > 0) {
                    this.selectSession(this.sessions[0].id);
                } else {
                    this.newChat();
                }
            } else {
                this.newChat();
            }
            
            // Load available models
            await this.loadModels();
            
            // Scroll to bottom after loading session
            this.$nextTick(() => {
                this.scrollToBottom();
            });
            
            // Auto-resize textarea
            this.$watch('userInput', () => {
                const textarea = document.querySelector('textarea');
                if (textarea) {
                    textarea.style.height = 'auto';
                    textarea.style.height = Math.min(textarea.scrollHeight, 128) + 'px';
                }
            });
            
            // Set up MCP config modal and initialize MCP clients
            if (window.desktop?.isElectron) {
                // Electron mode: Load MCP config from desktop API
                await this.mcpConfigModal.loadServers();
                await this.mcpConfigModal.loadTools();
                
                // Listen for tools registered event
                window.addEventListener('mcp-tools-registered', async (e) => {
                    console.log('[ChatApp] Tools registered:', e.detail);
                    await this.mcpConfigModal.loadTools();
                    await this.mcpConfigModal.loadServers();
                });
            } else {
                // Web mode: Initialize browser MCP client and auto-connect
                await this.initBrowserMCP();
            }
        },
        
        // Initialize browser MCP client for web mode
        async initBrowserMCP() {
            if (!window.MCPBrowserClient || !window.MCPConfigManager) {
                console.warn('[ChatApp] MCP browser client not available');
                return;
            }
            
            console.log('[ChatApp Web] Initializing browser MCP client');
            
            // Create client and config manager
            window.mcpBrowserClient = new window.MCPBrowserClient();
            window.mcpConfigManager = new window.MCPConfigManager();
            
            // Set up callback for when tools are received
            window.mcpBrowserClient.setToolsCallback((serverName, tools) => {
                console.log(`[ChatApp Web] Received ${tools.length} tools from ${serverName}`);
                this.mcpConfigModal.tools = window.mcpBrowserClient.getAllTools();
            });
            
            // Auto-connect to configured servers
            const servers = window.mcpConfigManager.getAutoConnectServers();
            console.log(`[ChatApp Web] Found ${servers.length} auto-connect servers`);
            
            for (const server of servers) {
                try {
                    console.log(`[ChatApp Web] Connecting to ${server.name} (${server.url})`);
                    await window.mcpBrowserClient.connect(server.name, server.url);
                    console.log(`[ChatApp Web] Connected to ${server.name}`);
                } catch (error) {
                    console.error(`[ChatApp Web] Failed to connect to ${server.name}:`, error);
                }
            }
            
            // Update tools list
            this.mcpConfigModal.tools = window.mcpBrowserClient.getAllTools();
            this.mcpConfigModal.servers = servers;
            
            console.log(`[ChatApp Web] MCP initialization complete. Total tools: ${this.mcpConfigModal.tools.length}`);
        },
        
        scrollToBottom() {
            const chatHistory = document.getElementById('chat-history');
            if (chatHistory) {
                chatHistory.scrollTop = chatHistory.scrollHeight;
            }
        },
        
        async loadModels() {
            try {
                // Use regular fetch - will work with proper CORS (app://localhost origin)
                console.log('[ChatApp] Fetching models from:', `${API_BASE_URL}/get_models`);
                const response = await fetch(`${API_BASE_URL}/get_models`);
                console.log('[ChatApp] Response status:', response.status);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const data = await response.json();
                console.log('[ChatApp] Loaded models:', data);
                if (data.models && Array.isArray(data.models)) {
                    this.availableModels = data.models.map(m => ({
                        id: m.id || m.name || m,
                        displayName: this.formatModelName(m.id || m.name || m),
                        context_length: m.context_length || -1
                    }));
                    if (this.availableModels.length > 0) {
                        this.selectedModel = this.availableModels[0].id;
                    }
                    console.log('[ChatApp] Successfully loaded models');
                }
            } catch (error) {
                console.error('[ChatApp] Failed to load models from backend:', error);
                // Fallback to common models if backend is not available
                this.availableModels = [
                    { id: 'llama2', displayName: 'Llama2', context_length: -1 },
                    { id: 'mistral', displayName: 'Mistral', context_length: -1 },
                    { id: 'neural-chat', displayName: 'Neural Chat', context_length: -1 },
                    { id: 'dolphin-mixtral', displayName: 'Dolphin Mixtral', context_length: -1 }
                ];
                this.selectedModel = this.availableModels[0].id;
            }
        },
        
        newChat() {
            const newSession = {
                id: Date.now(),
                name: `Chat ${this.sessions.length + 1}`,
                messages: []
            };
            this.sessions.unshift(newSession); // Add to the beginning of the array
            this.currentSession = newSession.id;
            this.messages = [];
            this.saveSessions();
        },
        
        selectSession(sessionId) {
            this.currentSession = sessionId;
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                this.messages = session.messages;
            }
            // Close sidebar only on mobile (below lg breakpoint)
            if (window.innerWidth < 1024) {
                this.sidebarOpen = false;
            }
            
            // Scroll to bottom when session is loaded
            this.$nextTick(() => {
                this.scrollToBottom();
            });
        },
        
        editSessionName(sessionId) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                this.modal = {
                    show: true,
                    type: 'edit',
                    value: session.name,
                    sessionId: sessionId
                };
            }
        },
        
        deleteSession(sessionId) {
            this.modal = {
                show: true,
                type: 'delete',
                value: '',
                sessionId: sessionId
            };
        },
        
        confirmModal() {
            if (this.modal.type === 'edit') {
                const session = this.sessions.find(s => s.id === this.modal.sessionId);
                if (session && this.modal.value.trim()) {
                    session.name = this.modal.value.trim();
                    this.saveSessions();
                }
            } else if (this.modal.type === 'delete') {
                const index = this.sessions.findIndex(s => s.id === this.modal.sessionId);
                if (index !== -1) {
                    this.sessions.splice(index, 1);
                    
                    // If we deleted the current session, switch to another or create new
                    if (this.currentSession === this.modal.sessionId) {
                        if (this.sessions.length > 0) {
                            this.selectSession(this.sessions[0].id);
                        } else {
                            this.newChat();
                        }
                    }
                    
                    this.saveSessions();
                }
            }
            
            this.modal.show = false;
        },
        
        clearAllSessions() {
            if (confirm('Are you sure you want to clear all sessions?')) {
                this.sessions = [];
                this.messages = [];
                this.currentSession = null;
                sessionStorage.removeItem('chat_sessions');
                this.newChat();
            }
        },
        
        selectModel(modelId) {
            this.selectedModel = modelId;
        },
        
        getSelectedModelName() {
            const model = this.availableModels.find(m => m.id === this.selectedModel);
            return model ? model.displayName : this.formatModelName(this.selectedModel) || 'Select Model';
        },
        
        formatModelName(modelId) {
            if (!modelId) return 'Select Model';
            
            // Remove version tag (e.g., "phi3:latest" -> "phi3")
            let name = modelId.split(':')[0];
            
            // Split by hyphens and underscores
            name = name.replace(/[-_]/g, ' ');
            
            // Capitalize each word
            name = name.split(' ').map(word => 
                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            ).join(' ');
            
            // Add version if it exists
            if (modelId.includes(':')) {
                const version = modelId.split(':')[1];
                if (version !== 'latest') {
                    name += ` (${version})`;
                }
            }
            
            return name;
        },
        
        handleEnter(event) {
            if (!event.shiftKey) {
                this.sendMessage();
            }
        },
        
        async handleFileUpload(event) {
            const file = event.target.files[0];
            if (file) {
                this.uploadedFile = file;
                this.uploadedFileName = file.name;
                console.log('[ChatApp] File selected:', file.name, 'Type:', file.type);
                
                // If it's an image, create preview for vision models
                if (file.type.startsWith('image/')) {
                    try {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            this.uploadedFilePreview = e.target.result;
                            console.log('[ChatApp] Image preview created');
                        };
                        reader.readAsDataURL(file);
                    } catch (error) {
                        console.error('[ChatApp] Error creating image preview:', error);
                    }
                }
                
                // If Local RAG is enabled, process the file
                if (this.localRagEnabled && window.processFileForRAG) {
                    try {
                        await window.processFileForRAG(file);
                        console.log('[ChatApp] File processed for Local RAG');
                    } catch (error) {
                        console.error('[ChatApp] Error processing file for RAG:', error);
                    }
                }
            }
        },
        
        clearFile() {
            this.uploadedFile = null;
            this.uploadedFileName = '';
            this.uploadedFilePreview = null;
            if (this.$refs.fileInput) {
                this.$refs.fileInput.value = '';
            }
        },
        
        async sendMessage() {
            if (!this.userInput.trim() || this.isLoading) return;
            
            const userMessage = {
                id: Date.now(),
                role: 'user',
                content: this.userInput.trim()
            };
            
            this.messages.push(userMessage);
            const query = this.userInput.trim();
            this.userInput = '';
            this.isLoading = true;
            
            // Save user message immediately
            this.saveSessions();
            
            // Scroll to bottom
            this.$nextTick(() => {
                this.scrollToBottom();
            });
            
            try {
                let assistantMessage = {
                    id: Date.now() + 1,
                    role: 'assistant',
                    content: '',
                    model: this.selectedModel,
                    isStreaming: true
                };
                this.messages.push(assistantMessage);
                const messageIndex = this.messages.length - 1;
                
                // Build conversation history (all messages except the assistant message being built)
                const conversationHistory = this.messages.slice(0, -1).map(m => ({
                    role: m.role,
                    content: m.content
                }));
                
                // Get MCP tools and merge with basic schemas
                let toolSchemas = [...basicToolSchemas];
                
                if (window.desktop?.isElectron && window.desktop?.getMCPToolSchemas) {
                    try {
                        const mcpSchemas = await window.desktop.getMCPToolSchemas();
                        if (mcpSchemas && Array.isArray(mcpSchemas)) {
                            toolSchemas = [...toolSchemas, ...mcpSchemas];
                            console.log(`[ChatApp] Loaded ${mcpSchemas.length} MCP tool schemas`);
                        }
                    } catch (error) {
                        console.warn('[ChatApp] Failed to load MCP tool schemas:', error);
                    }
                }
                
                // Call agent integration (supports file uploads and conversation context)
                const result = await window.askAgent(query, toolSchemas, this.selectedModel, conversationHistory, this.uploadedFile, this.currentSession);
                
                // Parse and stream the result
                await this.streamResponse(result, messageIndex);
                
                // Mark streaming as complete
                this.messages[messageIndex].isStreaming = false;
                
                // Save the complete message
                this.saveSessions();
                
                // Final scroll to bottom
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
                
            } catch (error) {
                console.error('Error sending message:', error);
                this.messages.push({
                    id: Date.now() + 2,
                    role: 'assistant',
                    content: `Error: ${error.message}. Please ensure the agent is accessible.`
                });
            } finally {
                this.isLoading = false;
                this.saveSessions();
                console.log('Message complete, isLoading:', this.isLoading);
            }
        },
        
        async streamResponse(response, messageIndex) {
            // Extract the text content from the response
            const textContent = this.parseAgentResponse(response);
            
            console.log('[ChatApp] Streaming extracted content:', textContent);
            
            // Stream the text character by character for visual continuity
            await this.streamTextToUI(textContent, messageIndex);
            
            // Parse markdown once at the end
            this.updateMessageMarkdown(messageIndex);
        },
        
        async streamTextToUI(text, messageIndex) {
            // Ensure text is a string
            if (typeof text !== 'string') {
                text = String(text || '');
            }
            
            // Stream text with a small delay between characters for visual effect
            const chunkSize = 10; // Characters per chunk
            const delayMs = 10; // Delay between chunks
            
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.substring(i, i + chunkSize);
                
                // Append chunk to message (raw text, not HTML)
                this.messages[messageIndex].content += chunk;
                
                // Scroll to keep up with streaming
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
                
                // Small delay to create streaming effect
                await this.delay(delayMs);
            }
        },
        
        updateMessageMarkdown(messageIndex) {
            // Parse markdown ONLY if marked.js is available and content is raw text
            if (window.marked && this.messages[messageIndex]) {
                try {
                    const rawContent = this.messages[messageIndex].content;
                    
                    // Check if content is already parsed HTML (contains HTML tags)
                    if (rawContent.includes('<') && rawContent.includes('>')) {
                        console.log('[ChatApp] Content already parsed, skipping markdown');
                        return;
                    }
                    
                    console.log('[ChatApp] Parsing markdown for message:', rawContent.substring(0, 50));
                    this.messages[messageIndex].content = window.marked.parse(rawContent);
                } catch (parseError) {
                    console.error('[ChatApp] Markdown parsing error:', parseError);
                    // Keep the raw content if parsing fails
                }
            }
        },
        
        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },
        
        parseAgentResponse(response) {
            console.log('[ChatApp] parseAgentResponse called with:', typeof response, response);
            
            // Handle string responses (streaming mode or stringified JSON)
            if (typeof response === 'string') {
                console.log('[ChatApp] Response is string');
                
                // Try to parse as JSON in case it's a stringified JSON object
                try {
                    const parsed = JSON.parse(response);
                    console.log('[ChatApp] Successfully parsed JSON from string');
                    return this.extractResponseContent(parsed);
                } catch (e) {
                    // Not JSON, return as-is
                    console.log('[ChatApp] String is not JSON, returning as-is');
                    return response;
                }
            }
            
            // Handle object responses (JSON mode from Electron/agent)
            if (typeof response === 'object' && response !== null) {
                console.log('[ChatApp] Response is object (JSON mode)');
                return this.extractResponseContent(response);
            }
            
            // Fallback for any other type
            console.log('[ChatApp] Response is other type:', typeof response);
            return String(response || '');
        },
        
        extractResponseContent(obj) {
            // Check for wrapped response format: {success: true, result: {...}}
            if (obj.success === true && obj.result) {
                console.log('[ChatApp] Found success.result structure');
                if (obj.result.response) {
                    console.log('[ChatApp] Extracted response from result.response');
                    return String(obj.result.response);
                }
                if (obj.result.message) {
                    console.log('[ChatApp] Extracted message from result.message');
                    return String(obj.result.message);
                }
                if (obj.result.content) {
                    console.log('[ChatApp] Extracted content from result.content');
                    return String(obj.result.content);
                }
            }
            
            // Direct response object with content/message/response field
            if (obj.response) {
                console.log('[ChatApp] Found direct response field');
                return String(obj.response);
            }
            if (obj.message) {
                console.log('[ChatApp] Found direct message field');
                return String(obj.message);
            }
            if (obj.content) {
                console.log('[ChatApp] Found direct content field');
                return String(obj.content);
            }
            
            // Fallback: stringify the entire object
            console.log('[ChatApp] No recognized field found, stringifying entire object');
            return JSON.stringify(obj, null, 2);
        },
        
        fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },
        
        saveSessions() {
            // Find the current session and sync messages
            const session = this.sessions.find(s => s.id === this.currentSession);
            if (session) {
                // Create a deep copy of messages, filtering out UI-only properties
                session.messages = this.messages.map(msg => ({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    model: msg.model
                }));
            }
            // Save to sessionStorage
            try {
                sessionStorage.setItem('chat_sessions', JSON.stringify(this.sessions));
                console.log('[ChatApp] Sessions saved to localStorage');
            } catch (error) {
                console.error('[ChatApp] Failed to save sessions:', error);
            }
        },
        
        getModelIcon(modelName) {
            if (!modelName) return '../img/chatucy_logo.png';
            
            const model = modelName.toLowerCase();
            
            // Map model names to icons
            if (model.includes('llama')) return '../img/llama.png';
            if (model.includes('mistral')) return '../img/mistral.jpg';
            if (model.includes('qwen')) return '../img/qwen.png';
            if (model.includes('gemma')) return '../img/gemma.png';
            if (model.includes('deepseek')) return '../img/deepseek.png';
            
            // Default icon
            return '../img/chatucy_logo.png';
        }
    }
}

// Register chatApp with window and Alpine.js
window.chatApp = chatApp;

// Wait for Alpine to be available and register the component
if (window.Alpine) {
    window.Alpine.data('chatApp', chatApp);
} else {
    // If Alpine hasn't loaded yet, register when it does
    window.addEventListener('alpine:initializing', () => {
        if (window.Alpine) {
            window.Alpine.data('chatApp', chatApp);
        }
    });
}

// Export for ES module import (required for Electron CDN loading)
export default chatApp;