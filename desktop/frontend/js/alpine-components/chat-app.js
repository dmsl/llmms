// Alpine.js Component for chat.html
// Handles chat functionality for both web and Electron modes
// Uses agent-integration.js for consistent LLM interactions across platforms

// --- RAG Lazy Loader (lightweight performance approach) ---
let ragLoaded = false;
let ragLoadingPromise = null;

const DEFAULT_RAG_LIMITS = {
    MAX_FILE_SIZE_BYTES: 15 * 1024 * 1024,
    MAX_FILES_PER_WORKSPACE: 15,
    MAX_CHUNKS_PER_FILE: 200,
    MAX_CHUNKS_PER_WORKSPACE: 1000,
    MAX_CHUNKS_GLOBAL: 3000,
    MAX_EXTRACTED_TEXT_BYTES_PER_FILE: 2 * 1024 * 1024,
    MAX_ESTIMATED_BYTES_PER_WORKSPACE: 10 * 1024 * 1024,
    MAX_ESTIMATED_BYTES_GLOBAL: 30 * 1024 * 1024,
    WARN_THRESHOLD_RATIO: 0.8,
    ESTIMATED_BYTES_PER_CHUNK: 4096,
    EMBEDDING_BATCH_SIZE: 8,
    RETRIEVAL_TOP_K: 5,
    RETRIEVAL_MAX_PER_FILE: 2,
    RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE: 20
};

function getRagLimits() {
    return {
        ...DEFAULT_RAG_LIMITS,
        ...(window.RAG_LIMITS || {})
    };
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureRagLoaded() {
  if (ragLoaded) return;
  if (ragLoadingPromise) return ragLoadingPromise;

  ragLoadingPromise = (async () => {
    console.log('[RAG Loader] Loading RAG dependencies...');
    
    // Load TFJS + USE only when needed
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs");
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/universal-sentence-encoder");

    // Load browser-rag implementation only when needed
    await loadScriptOnce("../js/browser-rag/rag-policy.js");
    await loadScriptOnce("../js/browser-rag/indexed-db-vector-store.js");
    await loadScriptOnce("../js/browser-rag/browser-retriever.js");

    // Initialize the USE model (downloads ~50MB model shards)
    console.log('[RAG Loader] Initializing Universal Sentence Encoder model...');
    if (window.use && !window.ragEmbeddingModel) {
      window.ragEmbeddingModel = await window.use.load();
      console.log('[RAG Loader] Model initialized successfully');
    }

    ragLoaded = true;
    console.log('[RAG Loader] All RAG dependencies loaded successfully');
  })();

  return ragLoadingPromise;
}

// Import agent integration (handles both web and Electron modes)
import { askAgent, supportsTools, refreshModelToolCapabilities, supportsToolsFromProvider } from '../agent-integration.js';
import { basicToolSchemas } from '../tools.js';
import { ConversationManager } from '../conversation-manager.js';
import { getEventManager, cleanupComponent } from '../utils/event-manager.js';
import { getTimerManager, cleanupTimers } from '../utils/timer-manager.js';
import { safeInnerHTML, safeText } from '../utils/html-safe.js';
import {
    createWorkspaceFileStorageKey,
    putWorkspaceFileBlob,
    getWorkspaceFileBlob,
    deleteWorkspaceFileBlob,
    clearWorkspaceFileBlobs,
    dataUrlToBlob,
    blobToDataUrl
} from '../workspace-file-store.js';

window.askAgent = askAgent;

// API Base URL for model loading (Electron will use this to get available models)
const API_BASE_URL = 'https://chatucy.cs.ucy.ac.cy/api';
const STORAGE_KEYS = {
    appState: 'chat_app_state_v2',
    appStateBackup: 'chat_app_state_v2_backup',
    legacySessions: 'chat_sessions',
    workspaceStoragePolicy: 'workspace_storage_policy_v1',
    localRagPrefs: 'local_rag_prefs_v1',
    llmBaseUrl: 'llm_base_url_v1'
};

const DEFAULT_LLM_BASE_URL = 'https://chatucy.cs.ucy.ac.cy/v1';

const WORKSPACE_STORAGE_LIMIT_DEFAULTS = {
    maxFileBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 200 * 1024 * 1024,
    maxGlobalBytes: 1024 * 1024 * 1024
};

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function deepCloneSerializable(value, fallback) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function stripTypingCursor(content) {
    if (typeof content !== 'string') return content;
    return content.replace(/<span class="typing-cursor"><\/span>/g, '');
}

function sanitizeMessageForPersistence(msg) {
    const safe = {
        ...deepCloneSerializable(msg, {})
    };

    if (!safe.id) {
        safe.id = Date.now() + Math.floor(Math.random() * 1000);
    }

    if (!safe.role) {
        safe.role = 'assistant';
    }

    // Persist completed content only; drop transient typing cursor artifacts.
    safe.content = stripTypingCursor(safe.content ?? '');

    // Remove transient UI flags that should not survive reloads.
    delete safe.isTyping;
    delete safe.isStreaming;
    delete safe.showModelInfo;

    return safe;
}

function hydrateMessageFromPersistence(msg) {
    const safe = sanitizeMessageForPersistence(msg || {});
    safe.isTyping = false;
    safe.isStreaming = false;
    return safe;
}

function chatApp() {
    // Initialize sidebar state from localStorage or based on screen size
    const getSavedSidebarState = () => {
        const saved = localStorage.getItem('sidebar_open');
        if (saved !== null) {
            return saved === 'true';
        }
        // Default: open on desktop, closed on mobile
        return typeof window !== 'undefined' && window.innerWidth >= 1024;
    };
    
    return {
        sidebarOpen: getSavedSidebarState(),
        browserViewOpen: false,
        browserPreviewEnabled: false,
        browserPreviewUrl: '/browser-view/vnc.html?autoconnect=1&resize=scale&view_only=1&path=browser-view/websockify',
        userInput: '',
        messages: [],
        sessions: [],
        workspaces: [],
        workspaceFiles: [],
        currentSession: null,
        currentWorkspaceFilter: 'all', // all | unassigned | workspace
        selectedWorkspaceId: null,
        sidebarSearchQuery: '',
        workspacesCollapsed: false,
        allChatsCollapsed: false,
        workspaceExpanded: {},
        workspaceDetailsOpen: false,
        draggedSessionId: null,
        storageInfo: {
            usedBytes: 0,
            quotaBytes: 0,
            loaded: false
        },
        storageSettingsOpen: false,
        workspaceStoragePolicy: {
            ...WORKSPACE_STORAGE_LIMIT_DEFAULTS
        },
        isLoading: false,
        selectedModel: 'Select Model',
        interactionMode: 'ask',
        availableModels: [],
        localRagEnabled: false,
        localRagMode: 'hybrid-fallback',
        localRagLastModeUsed: 'none',
        localRagStatusText: '',
        localRagFileStates: {},
        ragWorker: null,
        ragWorkerReady: false,
        ragWorkerJobs: {},
        ragWorkerJobSeq: 0,
        activeIndexJobId: null,
        activeRetrievalJobId: null,
        uploadedFile: null,
        uploadedFileName: '',
        uploadedFilePreview: null, // Base64 preview for images
        conversationManager: new ConversationManager(API_BASE_URL), // Conversation summarization manager
        modal: {
            show: false,
            type: '', // 'edit' or 'delete'
            value: '',
            sessionId: null
        },
        workspaceModal: {
            show: false,
            mode: 'create', // create | edit | delete
            workspaceId: null,
            name: '',
            icon: '',
            color: '#6a42c2',
            description: ''
        },
        jsonEditorModal: {
            show: false,
            jsonText: '',
            error: '',
            loadConfig() {
                // Load current config from localStorage for web users
                try {
                    const configStr = localStorage.getItem('mcp_browser_config');
                    if (configStr) {
                        const config = JSON.parse(configStr);
                        this.jsonText = JSON.stringify(config, null, 2);
                    } else {
                        // Default config structure
                        this.jsonText = JSON.stringify({
                            servers: [],
                            version: '1.0'
                        }, null, 2);
                    }
                    this.error = '';
                } catch (error) {
                    console.error('[JSON Editor] Failed to load config:', error);
                    this.jsonText = JSON.stringify({
                        servers: [],
                        version: '1.0'
                    }, null, 2);
                    this.error = 'Failed to load config: ' + error.message;
                }
            },
            saveConfig() {
                try {
                    // Parse and validate JSON
                    const config = JSON.parse(this.jsonText);
                    
                    // Validate structure
                    if (!config.servers || !Array.isArray(config.servers)) {
                        this.error = 'Config must have a "servers" array';
                        return;
                    }
                    
                    // Validate each server
                    for (const server of config.servers) {
                        if (!server.name || !server.url) {
                            this.error = 'Each server must have "name" and "url" properties';
                            return;
                        }
                        if (!window.MCPConfigManager.isValidWebSocketUrl(server.url)) {
                            this.error = `Invalid WebSocket URL for server "${server.name}": ${server.url}`;
                            return;
                        }
                    }
                    
                    // Save to localStorage
                    localStorage.setItem('mcp_browser_config', JSON.stringify(config));
                    
                    // Reload the page to apply changes
                    alert('MCP configuration saved! The page will reload to apply changes.');
                    window.location.reload();
                } catch (error) {
                    this.error = 'Invalid JSON: ' + error.message;
                    console.error('[JSON Editor] Save failed:', error);
                }
            },
            resetToDefault() {
                if (confirm('Reset to default configuration? This will clear all your MCP servers.')) {
                    this.jsonText = JSON.stringify({
                        servers: [
                            {
                                name: 'playwright',
                                url: 'https://chatucy.cs.ucy.ac.cy/mcp/playwright',
                                type: 'sse',
                                autoConnect: false,
                                enabled: false,
                                toolStates: {}
                            }
                        ],
                        version: '1.0'
                    }, null, 2);
                    this.error = '';
                }
            }
        },
        mcpConfigModal: {
            show: false,
            activeTab: 'llm',
            servers: [],
            tools: [], // Flat list of all tools
            toolsByServer: {}, // Organized by server
            llmBaseUrl: DEFAULT_LLM_BASE_URL,
            newServerForm: {
                show: false,
                name: '',
                url: '',
                autoConnect: false,
                error: ''
            },
            loadLLMSettings() {
                const saved = localStorage.getItem(STORAGE_KEYS.llmBaseUrl);
                const value = (saved || DEFAULT_LLM_BASE_URL).trim();
                this.llmBaseUrl = value || DEFAULT_LLM_BASE_URL;
                window.OLLAMA_BASE_URL = this.llmBaseUrl;
            },
            saveLLMSettings() {
                const value = (this.llmBaseUrl || '').trim() || DEFAULT_LLM_BASE_URL;
                this.llmBaseUrl = value;
                localStorage.setItem(STORAGE_KEYS.llmBaseUrl, value);
                window.OLLAMA_BASE_URL = value;
            },
            resetLLMSettings() {
                this.llmBaseUrl = DEFAULT_LLM_BASE_URL;
                this.saveLLMSettings();
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
                } else if (window.mcpConfigManager && window.mcpBrowserClient && tool?.serverName && tool?.name) {
                    window.mcpBrowserClient.setToolEnabled(tool.serverName, tool.name, tool.enabled);
                    window.mcpConfigManager.setToolState(tool.serverName, tool.name, !!tool.enabled);
                }
            },
            async toggleWebServerEnabled(server) {
                if (window.desktop?.isElectron || !server?.name || !window.mcpConfigManager || !window.mcpBrowserClient) {
                    return;
                }

                const isEnabled = !!server.enabled;
                window.mcpConfigManager.setServerEnabled(server.name, isEnabled);

                if (isEnabled) {
                    if (!window.mcpBrowserClient.isConnected(server.name)) {
                        await window.mcpBrowserClient.connect(server.name, server.url, server.connectionParams);
                    }

                    const tools = window.mcpBrowserClient.getAllTools().filter(t => t.serverName === server.name);
                    const toolNames = tools.map(t => t.name);
                    window.mcpBrowserClient.setAllToolsEnabled(server.name, true);
                    window.mcpConfigManager.enableAllTools(server.name, toolNames);
                } else {
                    if (window.mcpBrowserClient.isConnected(server.name)) {
                        window.mcpBrowserClient.disconnect(server.name);
                    }
                }

                await this.loadServers();
                await this.loadTools();
            },
            setWebServerAutoConnect(server) {
                if (window.desktop?.isElectron || !server?.name || !window.mcpConfigManager) {
                    return;
                }

                window.mcpConfigManager.saveServer({
                    ...server,
                    autoConnect: !!server.autoConnect
                });
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
                    this.newServerForm.error = 'Invalid URL (must start with ws://, wss://, http://, or https://)';
                    return;
                }
                
                try {
                    // Save to config
                    window.mcpConfigManager.saveServer({
                        name: this.newServerForm.name,
                        url: this.newServerForm.url,
                        autoConnect: this.newServerForm.autoConnect,
                        enabled: this.newServerForm.autoConnect,
                        toolStates: {}
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
                    this.newServerForm.autoConnect = false;
                    
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
            // Watch for sidebar state changes and persist to localStorage
            this.$watch('sidebarOpen', (value) => {
                localStorage.setItem('sidebar_open', value.toString());
            });

            this.mcpConfigModal.loadLLMSettings();
            this.browserPreviewEnabled = false;
            this.browserViewOpen = false;

            const browserPreviewEvents = getEventManager('chat-app-browser-preview');
            browserPreviewEvents.add(window, 'agent-browser-session-started', (event) => {
                this.enableBrowserPreview(event?.detail || {});
            });
            browserPreviewEvents.add(window, 'agent-browser-session-stopped', (event) => {
                this.disableBrowserPreview(event?.detail || {});
            });
            
            // No automatic resize handling - let user control sidebar state
            // The CSS responsive classes (lg:w-60, lg:w-0, etc.) handle the visual adaptation
            
            // Load state (with migration from legacy session storage)
            this.loadWorkspaceStoragePolicy();
            this.loadAppState();
            this.loadLocalRagPrefs();
            await this.refreshStorageEstimate();
            await this.migrateLegacyWorkspaceFilesToIndexedDb();
            if (this.sessions.length > 0) {
                const first = this.currentSession || this.sessions[0].id;
                this.selectSession(first);
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
            
            // Watch localRagEnabled and lazy-load RAG dependencies when enabled
            this.$watch('localRagEnabled', async (enabled) => {
                this.persistLocalRagPrefs();
                if (enabled) {
                    // Show loading indicator
                    const loadingMsg = {
                        id: Date.now(),
                        role: 'system',
                        content: '🔄 Loading Local RAG (downloading ~50MB model shards)...'
                    };
                    this.messages.push(loadingMsg);
                    const loadingIndex = this.messages.length - 1;
                    
                    try {
                        console.log('[ChatApp] Local RAG enabled, loading dependencies...');
                        await ensureRagLoaded();
                        await this.ensureLocalRetriever();
                        
                        // Update loading message to success
                        this.messages[loadingIndex].content = '✅ Local RAG ready! You can now upload documents for context-aware chat.';
                        console.log('[ChatApp] RAG dependencies loaded successfully');
                        
                        // Remove success message after 3 seconds
                        setTimeout(() => {
                            const idx = this.messages.findIndex(m => m.id === loadingMsg.id);
                            if (idx !== -1) this.messages.splice(idx, 1);
                        }, 3000);
                    } catch (error) {
                        console.error('[ChatApp] Failed to load RAG dependencies:', error);
                        this.localRagEnabled = false;
                        this.messages[loadingIndex].content = '❌ Failed to load Local RAG: ' + error.message;
                        
                        // Remove error message after 5 seconds
                        setTimeout(() => {
                            const idx = this.messages.findIndex(m => m.id === loadingMsg.id);
                            if (idx !== -1) this.messages.splice(idx, 1);
                        }, 5000);
                    }
                } else {
                    // Optional cleanup to reduce memory/storage usage
                    if (window.browserRetriever?.clearAllDocuments) {
                        window.browserRetriever.clearAllDocuments();
                        console.log('[ChatApp] RAG documents cleared');
                    }
                }
            });

            this.$watch('localRagFileStates', () => {
                this.persistLocalRagPrefs();
            });
            
            // Set up MCP config modal and initialize MCP clients
            if (window.desktop?.isElectron) {
                // Electron mode: Load MCP config from desktop API
                await this.mcpConfigModal.loadServers();
                await this.mcpConfigModal.loadTools();
                
                // Listen for tools registered event
                const eventMgr = getEventManager('chat-app-mcp');
                eventMgr.add(window, 'mcp-tools-registered', async (e) => {
                    console.log('[ChatApp] Tools registered:', e.detail);
                    await this.mcpConfigModal.loadTools();
                    await this.mcpConfigModal.loadServers();
                });
            } else {
                // Web mode: Initialize browser MCP client and auto-connect
                await this.initBrowserMCP();
            }
        },

        enableBrowserPreview(detail = {}) {
            this.browserPreviewEnabled = true;
            this.browserViewOpen = true;
            console.log('[ChatApp] Browser preview enabled after session start:', detail);
        },

        disableBrowserPreview(detail = {}) {
            this.browserViewOpen = false;
            this.browserPreviewEnabled = false;
            console.log('[ChatApp] Browser preview disabled after session stop:', detail);
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
                const serverConfig = window.mcpConfigManager.getServer(serverName);
                const toolStates = window.mcpConfigManager.getToolStates(serverName);

                if (serverConfig?.enabled) {
                    window.mcpBrowserClient.setAllToolsEnabled(serverName, true);
                    window.mcpConfigManager.enableAllTools(serverName, tools.map(tool => tool.name));
                    window.mcpBrowserClient.applyToolStates(serverName, toolStates);
                }

                console.log(`[ChatApp Web] Received ${tools.length} tools from ${serverName}`);
                this.mcpConfigModal.tools = window.mcpBrowserClient.getAllTools();
                this._rebuildToolsByServer();
            });
            
            // Auto-connect to configured servers
            const servers = window.mcpConfigManager.getAutoConnectServers();
            console.log(`[ChatApp Web] Found ${servers.length} auto-connect servers`);
            
            for (const server of servers) {
                try {
                    console.log(`[ChatApp Web] Connecting to ${server.name} (${server.url})`);
                    await window.mcpBrowserClient.connect(server.name, server.url, server.connectionParams);
                    console.log(`[ChatApp Web] Connected to ${server.name}`);
                } catch (error) {
                    console.error(`[ChatApp Web] Failed to connect to ${server.name}:`, error);
                }
            }
            
            // Update tools list
            this.mcpConfigModal.tools = window.mcpBrowserClient.getAllTools();
            this.mcpConfigModal.servers = window.mcpConfigManager.getServers();
            this._rebuildToolsByServer();
            
            console.log(`[ChatApp Web] MCP initialization complete. Total tools: ${this.mcpConfigModal.tools.length}`);
        },

        // Rebuild toolsByServer map from the flat tools list (used by Tools tab in modal)
        _rebuildToolsByServer() {
            const byServer = {};
            for (const tool of (this.mcpConfigModal.tools || [])) {
                if (!byServer[tool.serverName]) {
                    byServer[tool.serverName] = { type: 'remote-web', tools: [] };
                }
                byServer[tool.serverName].tools.push(tool);
            }
            this.mcpConfigModal.toolsByServer = byServer;
        },

        loadAppState() {
            let loaded = false;
            try {
                let raw = localStorage.getItem(STORAGE_KEYS.appState);
                if (!raw) {
                    raw = localStorage.getItem(STORAGE_KEYS.appStateBackup);
                }
                if (raw) {
                    const parsed = JSON.parse(raw);
                    this.sessions = this.normalizeSessions(parsed.sessions || []);
                    this.workspaces = this.normalizeWorkspaces(parsed.workspaces || []);
                    this.workspaceFiles = this.normalizeWorkspaceFiles(parsed.workspaceFiles || []);
                    this.currentSession = parsed.currentSession || null;
                    loaded = true;
                }
            } catch (error) {
                console.error('[ChatApp] Failed to load app state:', error);
            }

            if (!loaded) {
                this.migrateLegacySessions();
            }

            // Clean up invalid references after migration or load
            const workspaceIds = new Set(this.workspaces.map(w => w.id));
            this.sessions = this.sessions.map(s => ({
                ...s,
                workspaceId: s.workspaceId && workspaceIds.has(s.workspaceId) ? s.workspaceId : null
            }));
        },

        loadLocalRagPrefs() {
            try {
                const raw = localStorage.getItem(STORAGE_KEYS.localRagPrefs);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                this.localRagEnabled = !!parsed.localRagEnabled;
                this.localRagFileStates = parsed.localRagFileStates || {};
            } catch (error) {
                console.warn('[ChatApp] Failed to load local RAG preferences:', error);
            }
        },

        persistLocalRagPrefs() {
            try {
                localStorage.setItem(STORAGE_KEYS.localRagPrefs, JSON.stringify({
                    localRagEnabled: this.localRagEnabled,
                    localRagFileStates: this.localRagFileStates
                }));
            } catch (error) {
                console.warn('[ChatApp] Failed to persist local RAG preferences:', error);
            }
        },

        async ensureLocalRetriever() {
            await ensureRagLoaded();
            if (!window.browserRetriever) {
                const RetrieverClass = window.BrowserRetriever || (typeof BrowserRetriever !== 'undefined' ? BrowserRetriever : null);
                if (!RetrieverClass) {
                    throw new Error('Browser retriever is not available');
                }
                window.browserRetriever = new RetrieverClass();
            }
            return window.browserRetriever;
        },

        async ensureRagWorker() {
            await ensureRagLoaded();
            if (!window.Worker) {
                throw new Error('Web Workers are not supported in this browser');
            }

            if (this.ragWorker && this.ragWorkerReady) {
                return this.ragWorker;
            }

            if (!this.ragWorker) {
                this.ragWorker = new Worker('../js/browser-rag/rag-worker.js');
                this.ragWorker.onmessage = (event) => {
                    const data = event.data || {};
                    const job = this.ragWorkerJobs[data.jobId];
                    if (!job) return;

                    if (data.type === 'progress') {
                        if (typeof job.onProgress === 'function') {
                            job.onProgress(data.progress || {});
                        }
                        return;
                    }

                    if (data.type === 'result') {
                        job.resolve(data.result);
                    } else {
                        job.reject(new Error(data.error || 'RAG worker task failed'));
                    }

                    delete this.ragWorkerJobs[data.jobId];
                };

                this.ragWorker.onerror = (error) => {
                    console.error('[ChatApp] RAG worker error:', error);
                };
            }

            if (!this.ragWorkerReady) {
                this.ragWorkerJobSeq += 1;
                const initJobId = `init_${Date.now()}_${this.ragWorkerJobSeq}`;
                await new Promise((resolve, reject) => {
                    this.ragWorkerJobs[initJobId] = { resolve, reject, onProgress: null };
                    this.ragWorker.postMessage({ type: 'init', jobId: initJobId, payload: {} });
                });
                this.ragWorkerReady = true;
            }

            return this.ragWorker;
        },

        async postRagWorkerTask(type, payload, options = {}) {
            await this.ensureRagWorker();
            this.ragWorkerJobSeq += 1;
            const jobId = `${type}_${Date.now()}_${this.ragWorkerJobSeq}`;

            const promise = new Promise((resolve, reject) => {
                this.ragWorkerJobs[jobId] = {
                    resolve,
                    reject,
                    onProgress: options.onProgress || null
                };

                this.ragWorker.postMessage({
                    type,
                    jobId,
                    payload
                });
            });

            return { jobId, promise };
        },

        cancelRagWorkerTask(jobId) {
            if (!this.ragWorker || !jobId) return;
            this.ragWorker.postMessage({ type: 'cancel', jobId });
        },

        async extractTextForLocalRag(file) {
            const type = (file.type || '').toLowerCase();

            if (
                type.includes('text') ||
                type.includes('javascript') ||
                type.includes('json') ||
                type.includes('csv') ||
                type.includes('html') ||
                type === ''
            ) {
                return await file.text();
            }

            if (type.includes('officedocument.wordprocessingml.document') || type.includes('docx')) {
                if (!window.mammoth?.extractRawText) {
                    throw new Error('DOCX extraction runtime is not loaded');
                }
                const arrayBuffer = await file.arrayBuffer();
                const result = await window.mammoth.extractRawText({ arrayBuffer });
                return result.value || '';
            }

            if (type.includes('pdf')) {
                if (!window.pdfjsLib?.getDocument) {
                    throw new Error('PDF extraction is unavailable in local mode for this session');
                }
                const pdfData = new Uint8Array(await file.arrayBuffer());
                const pdf = await window.pdfjsLib.getDocument({ data: pdfData }).promise;
                let text = '';
                for (let i = 1; i <= pdf.numPages; i += 1) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    text += content.items.map(item => item.str).join(' ') + '\n';
                }
                return text;
            }

            throw new Error(`Unsupported local extraction type: ${file.type || 'unknown'}`);
        },

        getCurrentWorkspaceIdForSession(sessionId = this.currentSession) {
            const session = this.sessions.find(s => s.id === sessionId);
            return session?.workspaceId || null;
        },

        getWorkspaceScopeKey(workspaceId) {
            return workspaceId || 'unassigned';
        },

        buildLocalRagFileId(file, scope) {
            const workspacePart = scope.workspaceId || 'unassigned';
            const chatPart = scope.chatId || 'none';
            return `${workspacePart}::${chatPart}::${file.name}::${file.size || 0}::${file.lastModified || 0}`;
        },

        setLocalRagFileState(fileId, patch) {
            this.localRagFileStates = {
                ...this.localRagFileStates,
                [fileId]: {
                    ...(this.localRagFileStates[fileId] || {}),
                    ...patch,
                    updatedAt: new Date().toISOString()
                }
            };
        },

        getIndexedLocalRagRecords() {
            return Object.values(this.localRagFileStates || {}).filter(
                item => item?.status === 'indexed'
            );
        },

        getLocalRagWorkspaceUsage(workspaceId) {
            const scopeKey = this.getWorkspaceScopeKey(workspaceId);
            const records = this.getIndexedLocalRagRecords().filter(
                item => this.getWorkspaceScopeKey(item.workspaceId) === scopeKey
            );
            const uniqueFiles = new Set(records.map(item => item.fileId));
            const chunks = records.reduce((sum, item) => sum + (Number(item.chunkCount) || 0), 0);
            const estimatedBytes = records.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
            return {
                files: uniqueFiles.size,
                chunks,
                estimatedBytes
            };
        },

        getLocalRagGlobalUsage() {
            const records = this.getIndexedLocalRagRecords();
            const uniqueFiles = new Set(records.map(item => item.fileId));
            const chunks = records.reduce((sum, item) => sum + (Number(item.chunkCount) || 0), 0);
            const estimatedBytes = records.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
            return {
                files: uniqueFiles.size,
                chunks,
                estimatedBytes
            };
        },

        validateLocalRagFileSelection(file, workspaceId) {
            const limits = getRagLimits();
            if (file.size > limits.MAX_FILE_SIZE_BYTES) {
                return `File is too large for local indexing (${this.formatBytes(limits.MAX_FILE_SIZE_BYTES)} max).`;
            }

            const workspaceUsage = this.getLocalRagWorkspaceUsage(workspaceId);
            if (workspaceUsage.files >= limits.MAX_FILES_PER_WORKSPACE) {
                return `Workspace full. Remove indexed files or create a new workspace.`;
            }

            return null;
        },

        getUploadedFileLocalRagState() {
            if (!this.uploadedFile) return null;
            const scope = {
                workspaceId: this.getCurrentWorkspaceIdForSession(this.currentSession),
                chatId: this.currentSession
            };
            const fileId = this.buildLocalRagFileId(this.uploadedFile, scope);
            return this.localRagFileStates[fileId] || null;
        },

        getLocalRagStatusLabel() {
            const state = this.getUploadedFileLocalRagState();
            if (!state?.status) return this.localRagStatusText || '';
            const labels = {
                queued: 'Queued for local indexing',
                indexing: 'Indexing locally...',
                indexed: `Indexed locally (${state.chunkCount || 0} chunks)`,
                failed: `Local indexing failed${state.error ? `: ${state.error}` : ''}`
            };
            return labels[state.status] || this.localRagStatusText || '';
        },

        updateLocalRagWarnings(workspaceId) {
            const limits = getRagLimits();
            const workspaceUsage = this.getLocalRagWorkspaceUsage(workspaceId);
            const globalUsage = this.getLocalRagGlobalUsage();
            const warnRatio = limits.WARN_THRESHOLD_RATIO || 0.8;

            const workspaceChunkWarn = workspaceUsage.chunks >= Math.floor(limits.MAX_CHUNKS_PER_WORKSPACE * warnRatio);
            const workspaceByteWarn = workspaceUsage.estimatedBytes >= Math.floor(limits.MAX_ESTIMATED_BYTES_PER_WORKSPACE * warnRatio);
            const globalChunkWarn = globalUsage.chunks >= Math.floor(limits.MAX_CHUNKS_GLOBAL * warnRatio);
            const globalByteWarn = globalUsage.estimatedBytes >= Math.floor(limits.MAX_ESTIMATED_BYTES_GLOBAL * warnRatio);

            if (workspaceChunkWarn || workspaceByteWarn || globalChunkWarn || globalByteWarn) {
                this.localRagStatusText = 'Workspace nearing indexing limit.';
            }
        },

        buildRagContextBlock(query, context) {
            return [
                'Use only the context below when it is relevant. If context is insufficient, say so briefly.',
                '',
                'Context:',
                context,
                '',
                `User question: ${query}`
            ].join('\n');
        },

        async indexUploadedDocumentForLocalRag(file) {
            const limits = getRagLimits();
            const scope = {
                workspaceId: this.getCurrentWorkspaceIdForSession(this.currentSession),
                chatId: this.currentSession
            };

            const selectionError = this.validateLocalRagFileSelection(file, scope.workspaceId);
            if (selectionError) {
                return { ok: false, error: selectionError };
            }

            const fileId = this.buildLocalRagFileId(file, scope);
            const existingState = this.localRagFileStates[fileId];
            if (existingState?.status === 'indexed') {
                return { ok: true, fileId, chunkCount: existingState.chunkCount || 0 };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexing',
                name: file.name,
                sourceType: 'chatAttachment',
                workspaceId: scope.workspaceId,
                chatId: scope.chatId,
                chunkCount: 0,
                estimatedBytes: 0,
                error: ''
            });

            if (this.activeIndexJobId) {
                this.cancelRagWorkerTask(this.activeIndexJobId);
            }

            let extractedText = '';
            try {
                extractedText = await this.extractTextForLocalRag(file);
            } catch (extractionError) {
                this.setLocalRagFileState(fileId, {
                    status: 'failed',
                    error: extractionError.message || 'Extraction failed'
                });
                return { ok: false, fileId, error: extractionError.message || 'Extraction failed' };
            }

            const extractedTextBytes = new TextEncoder().encode(extractedText || '').length;

            const workerTask = await this.postRagWorkerTask(
                'indexText',
                {
                    text: extractedText,
                    descriptor: {
                        fileId,
                        source: file.name,
                        sourceName: file.name,
                        sourceType: 'chatAttachment',
                        workspaceId: scope.workspaceId,
                        chatId: scope.chatId,
                        replaceExisting: true,
                        extractedTextBytes
                    },
                    limits
                },
                {
                    onProgress: (progress) => {
                        const processed = Number(progress?.processedChunks || 0);
                        const total = Number(progress?.totalChunks || 0);
                        this.localRagStatusText = `Indexing locally... ${processed}/${total}`;
                    }
                }
            );
            this.activeIndexJobId = workerTask.jobId;
            let result;
            try {
                result = await workerTask.promise;
            } finally {
                this.activeIndexJobId = null;
            }

            if (!result?.success) {
                const errorMessage = result?.error || 'Unknown local indexing error';
                this.setLocalRagFileState(fileId, {
                    status: 'failed',
                    error: errorMessage
                });
                return { ok: false, fileId, error: errorMessage };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexed',
                chunkCount: result.chunkCount || 0,
                estimatedBytes: result.estimatedBytes || 0,
                extractedTextBytes: result.extractedTextBytes || 0,
                error: ''
            });
            this.updateLocalRagWarnings(scope.workspaceId);
            return { ok: true, fileId, chunkCount: result.chunkCount || 0 };
        },

        async buildLocalContextForMessage(query, uploadedDocumentFile) {
            const indexResult = await this.indexUploadedDocumentForLocalRag(uploadedDocumentFile);
            if (!indexResult.ok) {
                return { ok: false, reason: indexResult.error || 'index-failed' };
            }

            const scope = {
                workspaceId: this.getCurrentWorkspaceIdForSession(this.currentSession),
                chatId: this.currentSession
            };

            const limits = getRagLimits();
            if (this.activeRetrievalJobId) {
                this.cancelRagWorkerTask(this.activeRetrievalJobId);
            }

            const workerTask = await this.postRagWorkerTask('retrieve', {
                query,
                maxResults: limits.RETRIEVAL_TOP_K || 5,
                filters: {
                    sourceType: 'chatAttachment',
                    workspaceId: scope.workspaceId,
                    chatId: scope.chatId
                },
                options: {
                    candidateLimitPerSource: limits.RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE || 20,
                    maxPerFile: limits.RETRIEVAL_MAX_PER_FILE || 2
                }
            });
            this.activeRetrievalJobId = workerTask.jobId;
            let docs;
            try {
                docs = (await workerTask.promise) || [];
            } finally {
                this.activeRetrievalJobId = null;
            }

            if (!docs || docs.length === 0) {
                return { ok: false, reason: 'no-local-results' };
            }

            const context = docs
                .map((doc) => `[Source: ${doc.metadata?.source || 'document'}, Chunk: ${(doc.metadata?.chunkIndex ?? 0) + 1}]\n${doc.text}`)
                .join('\n\n');

            return {
                ok: true,
                context,
                usedChunks: docs.length
            };
        },

        migrateLegacySessions() {
            let legacy = [];
            try {
                const fromSessionStorage = sessionStorage.getItem(STORAGE_KEYS.legacySessions);
                const fromLocalStorage = localStorage.getItem(STORAGE_KEYS.legacySessions);
                const raw = fromSessionStorage || fromLocalStorage;
                if (raw) {
                    legacy = JSON.parse(raw);
                }
            } catch (error) {
                console.warn('[ChatApp] Legacy session migration failed:', error);
            }
            this.sessions = this.normalizeSessions(legacy || []);
            this.workspaces = [];
            this.workspaceFiles = [];
            this.currentSession = this.sessions[0]?.id || null;
            this.persistAppState();
        },

        normalizeSessions(sessions) {
            return (sessions || []).map((s, idx) => ({
                id: s.id || makeId('chat'),
                name: s.name || `Chat ${idx + 1}`,
                messages: Array.isArray(s.messages)
                    ? s.messages.map(m => hydrateMessageFromPersistence(m))
                    : [],
                workspaceId: s.workspaceId ?? null,
                createdAt: s.createdAt || new Date().toISOString(),
                updatedAt: s.updatedAt || new Date().toISOString(),
                modelOverride: s.modelOverride || null
            }));
        },

        normalizeWorkspaces(workspaces) {
            return (workspaces || []).map((w, idx) => ({
                id: w.id || makeId('ws'),
                name: (w.name || `Workspace ${idx + 1}`).trim(),
                icon: w.icon || '',
                color: w.color || '#6a42c2',
                description: w.description || '',
                pinnedNote: w.pinnedNote || '',
                defaultModel: w.defaultModel || '',
                defaultSettings: w.defaultSettings || {},
                createdAt: w.createdAt || new Date().toISOString(),
                updatedAt: w.updatedAt || new Date().toISOString()
            }));
        },

        normalizeWorkspaceFiles(files) {
            return (files || []).map(f => ({
                id: f.id || makeId('wfile'),
                workspaceId: f.workspaceId,
                name: f.name || 'file',
                mimeType: f.mimeType || 'application/octet-stream',
                size: f.size || 0,
                storageKey: f.storageKey || null,
                dataUrl: f.dataUrl || '',
                createdAt: f.createdAt || new Date().toISOString(),
                updatedAt: f.updatedAt || new Date().toISOString()
            }));
        },

        persistAppState() {
            try {
                const payload = {
                    version: 2,
                    sessions: this.sessions,
                    workspaces: this.workspaces,
                    workspaceFiles: this.workspaceFiles,
                    currentSession: this.currentSession
                };
                const serialized = JSON.stringify(payload);
                localStorage.setItem(STORAGE_KEYS.appState, serialized);
                localStorage.setItem(STORAGE_KEYS.appStateBackup, serialized);
            } catch (error) {
                console.error('[ChatApp] Failed to persist app state:', error);
            }
        },

        setWorkspaceFilter(scope, workspaceId = null) {
            this.currentWorkspaceFilter = scope;
            this.selectedWorkspaceId = scope === 'workspace' ? workspaceId : null;
            if (scope !== 'workspace') {
                this.workspaceDetailsOpen = false;
            }
        },

        selectWorkspace(workspaceId) {
            this.setWorkspaceFilter('workspace', workspaceId);
            this.workspaceExpanded = {
                ...this.workspaceExpanded,
                [workspaceId]: true
            };
            this.workspaceDetailsOpen = true;
        },

        closeWorkspaceDetails() {
            this.workspaceDetailsOpen = false;
        },

        getVisibleSessions() {
            const query = (this.sidebarSearchQuery || '').trim().toLowerCase();
            let items;
            if (this.currentWorkspaceFilter === 'workspace' && this.selectedWorkspaceId) {
                items = this.sessions.filter(s => s.workspaceId === this.selectedWorkspaceId);
            } else if (this.currentWorkspaceFilter === 'unassigned') {
                items = this.sessions.filter(s => !s.workspaceId);
            } else {
                items = this.sessions;
            }

            if (!query) return items;
            return items.filter(s => (s.name || '').toLowerCase().includes(query));
        },

        clearSidebarSearch() {
            this.sidebarSearchQuery = '';
        },

        toggleWorkspacesCollapsed() {
            this.workspacesCollapsed = !this.workspacesCollapsed;
        },

        toggleAllChatsCollapsed() {
            this.allChatsCollapsed = !this.allChatsCollapsed;
        },

        isWorkspaceExpanded(workspaceId) {
            return !!this.workspaceExpanded[workspaceId];
        },

        toggleWorkspaceExpanded(workspaceId) {
            this.workspaceExpanded = {
                ...this.workspaceExpanded,
                [workspaceId]: !this.workspaceExpanded[workspaceId]
            };
        },

        getSearchResultCount() {
            const query = (this.sidebarSearchQuery || '').trim();
            if (!query) return null;
            return this.getVisibleSessions().length;
        },

        getWorkspaceListForSidebar() {
            const query = (this.sidebarSearchQuery || '').trim().toLowerCase();
            if (!query) {
                return this.workspaces;
            }
            return this.workspaces.filter(w => (w.name || '').toLowerCase().includes(query));
        },

        getSessionsForWorkspace(workspaceId) {
            const query = (this.sidebarSearchQuery || '').trim().toLowerCase();
            const items = this.sessions.filter(s => s.workspaceId === workspaceId);
            if (!query) return items;
            return items.filter(s => (s.name || '').toLowerCase().includes(query));
        },

        getUnassignedSessions() {
            const query = (this.sidebarSearchQuery || '').trim().toLowerCase();
            const items = this.sessions.filter(s => !s.workspaceId);
            if (!query) return items;
            return items.filter(s => (s.name || '').toLowerCase().includes(query));
        },

        isWorkspaceActive(workspaceId) {
            return this.currentWorkspaceFilter === 'workspace' && this.selectedWorkspaceId === workspaceId;
        },

        getWorkspaceChatCount(workspaceId) {
            return this.sessions.filter(s => s.workspaceId === workspaceId).length;
        },

        getUnassignedCount() {
            return this.sessions.filter(s => !s.workspaceId).length;
        },

        getCurrentWorkspace() {
            if (!this.selectedWorkspaceId) return null;
            return this.workspaces.find(w => w.id === this.selectedWorkspaceId) || null;
        },

        getWorkspaceName(workspaceId) {
            const workspace = this.workspaces.find(w => w.id === workspaceId);
            return workspace ? workspace.name : 'Unassigned';
        },

        getWorkspaceFiles(workspaceId = this.selectedWorkspaceId) {
            if (!workspaceId) return [];
            return this.workspaceFiles.filter(f => f.workspaceId === workspaceId);
        },

        loadWorkspaceStoragePolicy() {
            try {
                const raw = localStorage.getItem(STORAGE_KEYS.workspaceStoragePolicy);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                this.workspaceStoragePolicy = {
                    maxFileBytes: Math.max(1 * 1024 * 1024, Number(parsed.maxFileBytes) || WORKSPACE_STORAGE_LIMIT_DEFAULTS.maxFileBytes),
                    maxWorkspaceBytes: Math.max(10 * 1024 * 1024, Number(parsed.maxWorkspaceBytes) || WORKSPACE_STORAGE_LIMIT_DEFAULTS.maxWorkspaceBytes),
                    maxGlobalBytes: Math.max(50 * 1024 * 1024, Number(parsed.maxGlobalBytes) || WORKSPACE_STORAGE_LIMIT_DEFAULTS.maxGlobalBytes)
                };
            } catch (error) {
                console.warn('[ChatApp] Failed to load workspace storage policy:', error);
            }
        },

        persistWorkspaceStoragePolicy() {
            try {
                localStorage.setItem(STORAGE_KEYS.workspaceStoragePolicy, JSON.stringify(this.workspaceStoragePolicy));
            } catch (error) {
                console.warn('[ChatApp] Failed to persist workspace storage policy:', error);
            }
        },

        bytesToMb(value) {
            const bytes = Number(value) || 0;
            return Math.max(1, Math.round(bytes / (1024 * 1024)));
        },

        setWorkspaceStoragePolicyFromMb(key, rawValueMb) {
            const valueMb = Number(rawValueMb);
            if (!Number.isFinite(valueMb) || valueMb <= 0) return;

            const bytes = Math.round(valueMb * 1024 * 1024);
            this.workspaceStoragePolicy = {
                ...this.workspaceStoragePolicy,
                [key]: bytes
            };
            this.persistWorkspaceStoragePolicy();
        },

        resetWorkspaceStoragePolicy() {
            this.workspaceStoragePolicy = {
                ...WORKSPACE_STORAGE_LIMIT_DEFAULTS
            };
            this.persistWorkspaceStoragePolicy();
        },

        formatBytes(value) {
            const bytes = Number(value) || 0;
            if (bytes < 1024) return `${bytes} B`;
            const units = ['KB', 'MB', 'GB', 'TB'];
            let size = bytes / 1024;
            let unitIndex = 0;
            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex += 1;
            }
            return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
        },

        async refreshStorageEstimate() {
            if (!navigator.storage?.estimate) {
                this.storageInfo = {
                    usedBytes: 0,
                    quotaBytes: 0,
                    loaded: true
                };
                return;
            }

            try {
                const estimate = await navigator.storage.estimate();
                this.storageInfo = {
                    usedBytes: estimate.usage || 0,
                    quotaBytes: estimate.quota || 0,
                    loaded: true
                };
            } catch (error) {
                console.warn('[ChatApp] Failed to estimate storage:', error);
            }
        },

        getWorkspaceStorageUsage(workspaceId = this.selectedWorkspaceId) {
            return this.getWorkspaceFiles(workspaceId).reduce((sum, file) => sum + (file.size || 0), 0);
        },

        getGlobalWorkspaceStorageUsage() {
            return this.workspaceFiles.reduce((sum, file) => sum + (file.size || 0), 0);
        },

        getWorkspaceStorageLimit() {
            return this.workspaceStoragePolicy.maxWorkspaceBytes;
        },

        getGlobalStorageLimit() {
            return this.workspaceStoragePolicy.maxGlobalBytes;
        },

        getPerFileStorageLimit() {
            return this.workspaceStoragePolicy.maxFileBytes;
        },

        getWorkspaceStorageUsagePercent(workspaceId = this.selectedWorkspaceId) {
            const limit = this.getWorkspaceStorageLimit();
            if (!limit) return 0;
            return Math.min(100, Math.round((this.getWorkspaceStorageUsage(workspaceId) / limit) * 100));
        },

        getGlobalStorageUsagePercent() {
            const limit = this.getGlobalStorageLimit();
            if (!limit) return 0;
            return Math.min(100, Math.round((this.getGlobalWorkspaceStorageUsage() / limit) * 100));
        },

        validateWorkspaceFileUpload(file, workspaceId) {
            if (!file) return 'No file selected.';

            if (file.size > this.getPerFileStorageLimit()) {
                return `File is too large. Max per file is ${this.formatBytes(this.getPerFileStorageLimit())}.`;
            }

            const workspaceUsage = this.getWorkspaceStorageUsage(workspaceId);
            if (workspaceUsage + file.size > this.getWorkspaceStorageLimit()) {
                return `Workspace storage limit reached (${this.formatBytes(this.getWorkspaceStorageLimit())}).`;
            }

            const globalUsage = this.getGlobalWorkspaceStorageUsage();
            if (globalUsage + file.size > this.getGlobalStorageLimit()) {
                return `Global storage limit reached (${this.formatBytes(this.getGlobalStorageLimit())}).`;
            }

            if (this.storageInfo?.loaded && this.storageInfo?.quotaBytes > 0) {
                const projected = (this.storageInfo.usedBytes || 0) + file.size;
                if (projected > this.storageInfo.quotaBytes) {
                    return 'Not enough browser storage quota available for this file.';
                }
            }

            return null;
        },

        async migrateLegacyWorkspaceFilesToIndexedDb() {
            const legacyFiles = this.workspaceFiles.filter(f => f.dataUrl && !f.storageKey);
            if (legacyFiles.length === 0) return;

            for (const file of legacyFiles) {
                try {
                    const storageKey = createWorkspaceFileStorageKey(file.workspaceId, file.id);
                    const blob = await dataUrlToBlob(file.dataUrl);
                    await putWorkspaceFileBlob(storageKey, blob);
                    file.storageKey = storageKey;
                    delete file.dataUrl;
                    file.updatedAt = new Date().toISOString();
                } catch (error) {
                    console.warn('[ChatApp] Failed to migrate workspace file to IndexedDB:', file.name, error);
                }
            }

            this.persistAppState();
            await this.refreshStorageEstimate();
        },
        
        scrollToBottom() {
            const chatHistory = document.getElementById('chat-history');
            const inputArea = document.getElementById('input-area');
            const messagesContainer = document.getElementById('messages-container');
            
            if (chatHistory && inputArea && messagesContainer) {
                // Dynamically calculate the input area height
                const inputAreaHeight = inputArea.offsetHeight;
                
                // Set dynamic padding on messages container to prevent overlap
                messagesContainer.style.paddingBottom = `${inputAreaHeight + 20}px`;
                
                // Scroll to bottom with smooth behavior
                chatHistory.scrollTo({
                    top: chatHistory.scrollHeight,
                    behavior: 'smooth'
                });
            }
        },
        
        detectModelCapabilities(modelName) {
            const name = modelName.toLowerCase();
            return {
                vision: name.includes('vision') || name.includes('llava') || name.includes('minicpm-v') || 
                        name.includes('moondream') || name.includes('bakllava') || name.includes('qwen') && name.includes('vl') ||
                        name.includes('gemma3') || name.includes('llama3.2-vision') || name.includes('llama4'),
                tools: false,
                thinking: name.includes('deepseek-r1') || name.includes('deepseek-v3') || name.includes('qwq') ||
                         name.includes('gpt-oss') || name.includes('magistral') || name.includes('qwen3') && !name.includes('coder')
            };
        },

        parseModelVersionTuple(modelId) {
            const id = String(modelId || '').toLowerCase();
            // Prefer semantic-like versions in names (e.g. llama3.3, qwen2.5, mistral-small3.2)
            const matches = [...id.matchAll(/(\d+(?:\.\d+){0,2})/g)].map(m => m[1]);
            if (!matches.length) return [0, 0, 0];

            // Use the highest tuple found in the id.
            const tuples = matches.map(v => {
                const parts = v.split('.').map(n => Number(n) || 0);
                return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
            });

            tuples.sort((a, b) => {
                if (b[0] !== a[0]) return b[0] - a[0];
                if (b[1] !== a[1]) return b[1] - a[1];
                return b[2] - a[2];
            });

            return tuples[0];
        },

        parseModelSizeScore(modelId) {
            const id = String(modelId || '').toLowerCase();

            // Common forms: :70b, :8b, -32b, _14b, 500m
            const m = id.match(/[:\-_](\d+(?:\.\d+)?)([bm])/i) || id.match(/\b(\d+(?:\.\d+)?)([bm])\b/i);
            if (!m) return 0;

            const value = Number(m[1]) || 0;
            const unit = (m[2] || 'b').toLowerCase();
            return unit === 'b' ? value * 1000 : value;
        },

        compareVersionTupleDesc(a, b) {
            if (a[0] !== b[0]) return b[0] - a[0];
            if (a[1] !== b[1]) return b[1] - a[1];
            return b[2] - a[2];
        },

        pickPreferredDefaultModel(models) {
            if (!Array.isArray(models) || models.length === 0) return null;

            const toolCapable = models.filter(m => supportsTools(m.id) || m.tools);
            const pool = toolCapable.length ? toolCapable : models;

            const ranked = [...pool].sort((a, b) => {
                const verCmp = this.compareVersionTupleDesc(
                    this.parseModelVersionTuple(a.id),
                    this.parseModelVersionTuple(b.id)
                );
                if (verCmp !== 0) return verCmp;

                const sizeCmp = this.parseModelSizeScore(b.id) - this.parseModelSizeScore(a.id);
                if (sizeCmp !== 0) return sizeCmp;

                // Stable tiebreaker
                return String(a.id).localeCompare(String(b.id));
            });

            return ranked[0]?.id || models[0]?.id || null;
        },
        
        async loadModels() {
            try {
                const providerToolsMap = await refreshModelToolCapabilities();

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
                    this.availableModels = data.models.map(m => {
                        const modelId = m.id || m.name || m;
                        const normalizedId = String(modelId || '').toLowerCase();
                        const baseId = normalizedId.split(':')[0];
                        const providerTools = providerToolsMap?.get?.(normalizedId);
                        const providerToolsBase = providerToolsMap?.get?.(baseId);
                        const toolSupport = typeof providerTools === 'boolean'
                            ? providerTools
                            : typeof providerToolsBase === 'boolean'
                                ? providerToolsBase
                                : typeof m.tools === 'boolean'
                                    ? m.tools
                                    : supportsTools(modelId);
                        const capabilities = this.detectModelCapabilities(modelId);
                        return {
                            id: modelId,
                            displayName: this.formatModelName(modelId),
                            context_length: m.context_length || -1,
                            ...capabilities,
                            tools: toolSupport
                        };
                    });
                    if (this.availableModels.length > 0) {
                        const preferred = this.pickPreferredDefaultModel(this.availableModels);
                        if (preferred) {
                            this.selectedModel = preferred;
                        }
                    }
                    console.log('[ChatApp] Successfully loaded models');
                }
            } catch (error) {
                console.error('[ChatApp] Failed to load models from backend:', error);
                // Fallback to common models if backend is not available
                this.availableModels = [
                    { id: 'llama2', displayName: 'Llama2', context_length: -1, vision: false, tools: false, thinking: false },
                    { id: 'mistral', displayName: 'Mistral', context_length: -1, vision: false, tools: true, thinking: false },
                    { id: 'neural-chat', displayName: 'Neural Chat', context_length: -1, vision: false, tools: false, thinking: false },
                    { id: 'dolphin-mixtral', displayName: 'Dolphin Mixtral', context_length: -1, vision: false, tools: true, thinking: false }
                ];
                const preferred = this.pickPreferredDefaultModel(this.availableModels);
                if (preferred) {
                    this.selectedModel = preferred;
                }
            }
        },
        
        newChat(targetWorkspaceId = undefined) {
            const workspaceId = targetWorkspaceId === undefined
                ? (this.currentWorkspaceFilter === 'workspace' ? this.selectedWorkspaceId : null)
                : targetWorkspaceId;
            const workspaceDefaults = workspaceId
                ? this.workspaces.find(w => w.id === workspaceId)
                : null;
            const newSession = {
                id: makeId('chat'),
                name: `Chat ${this.sessions.length + 1}`,
                messages: [],
                workspaceId: workspaceId || null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                modelOverride: workspaceDefaults?.defaultModel || null
            };
            this.sessions.unshift(newSession); // Add to the beginning of the array
            this.currentSession = newSession.id;
            this.messages = [];
            if (workspaceDefaults?.defaultModel) {
                this.selectedModel = workspaceDefaults.defaultModel;
            }
            this.saveSessions();
        },
        
        autoGenerateSessionName() {
            const session = this.sessions.find(s => s.id === this.currentSession);
            if (!session) return;
            
            // Only auto-generate if this is the first user message and name is default
            const userMessages = this.messages.filter(m => m.role === 'user');
            if (userMessages.length === 1 && session.name.startsWith('Chat ')) {
                const firstMessage = userMessages[0].content;
                
                // Generate a concise title from the first message
                let title = firstMessage.trim();
                
                // Truncate to first sentence or 50 characters, whichever is shorter
                const firstSentence = title.split(/[.!?]\s/)[0];
                title = firstSentence.length > 0 && firstSentence.length < title.length 
                    ? firstSentence 
                    : title.substring(0, 50);
                
                // Remove any remaining punctuation and trim
                title = title.replace(/[.!?,;:]$/, '').trim();
                
                // Add ellipsis if truncated
                if (title.length < firstMessage.trim().length) {
                    title += '...';
                }
                
                // Limit to 50 characters total
                if (title.length > 50) {
                    title = title.substring(0, 47) + '...';
                }
                
                session.name = title;
            }
        },
        
        selectSession(sessionId) {
            this.currentSession = sessionId;
            this.workspaceDetailsOpen = false;
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                this.messages = Array.isArray(session.messages)
                    ? session.messages.map(m => hydrateMessageFromPersistence(m))
                    : [];
                
                // Update showModelInfo for loaded messages
                // Show icon on first assistant message and when model changes
                let lastModel = null;
                for (let i = 0; i < this.messages.length; i++) {
                    const msg = this.messages[i];
                    if (msg.role === 'assistant') {
                        // Ensure model property exists (for older saved sessions)
                        if (!msg.model) {
                            msg.model = this.selectedModel || 'Unknown Model';
                        }
                        
                        // Show icon if it's the first assistant message or model changed
                        if (lastModel === null || lastModel !== msg.model) {
                            msg.showModelInfo = true;
                            lastModel = msg.model;
                        } else {
                            msg.showModelInfo = false;
                        }
                    }
                }
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

        assignSessionToWorkspace(sessionId, workspaceId) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            session.workspaceId = workspaceId || null;
            if (workspaceId) {
                this.workspaceExpanded = {
                    ...this.workspaceExpanded,
                    [workspaceId]: true
                };
            }
            session.updatedAt = new Date().toISOString();
            this.saveSessions();
        },

        startSessionDrag(event, sessionId) {
            this.draggedSessionId = sessionId;
            if (event?.dataTransfer) {
                event.dataTransfer.setData('text/plain', String(sessionId));
                event.dataTransfer.effectAllowed = 'move';
            }
        },

        allowWorkspaceDrop(event) {
            if (event?.preventDefault) event.preventDefault();
            if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
        },

        handleWorkspaceDrop(event, workspaceId) {
            if (event?.preventDefault) event.preventDefault();
            const droppedSessionId = event?.dataTransfer?.getData('text/plain') || this.draggedSessionId;
            if (droppedSessionId) {
                this.assignSessionToWorkspace(droppedSessionId, workspaceId);
            }
            this.draggedSessionId = null;
        },

        openCreateWorkspace() {
            this.workspaceModal = {
                show: true,
                mode: 'create',
                workspaceId: null,
                name: '',
                icon: '',
                color: '#6a42c2',
                description: ''
            };
        },

        openEditWorkspace(workspaceId) {
            const workspace = this.workspaces.find(w => w.id === workspaceId);
            if (!workspace) return;
            this.workspaceModal = {
                show: true,
                mode: 'edit',
                workspaceId,
                name: workspace.name,
                icon: workspace.icon || '',
                color: workspace.color || '#6a42c2',
                description: workspace.description || ''
            };
        },

        openDeleteWorkspace(workspaceId) {
            const workspace = this.workspaces.find(w => w.id === workspaceId);
            if (!workspace) return;
            this.workspaceModal = {
                show: true,
                mode: 'delete',
                workspaceId,
                name: workspace.name,
                icon: workspace.icon || '',
                color: workspace.color || '#6a42c2',
                description: workspace.description || ''
            };
        },

        async confirmWorkspaceModal() {
            const mode = this.workspaceModal.mode;
            const name = (this.workspaceModal.name || '').trim();
            if (mode !== 'delete' && !name) {
                return;
            }

            if (mode === 'create') {
                const newWorkspaceId = makeId('ws');
                this.workspaces.unshift({
                    id: newWorkspaceId,
                    name: name.slice(0, 60),
                    icon: (this.workspaceModal.icon || '').slice(0, 4),
                    color: this.workspaceModal.color || '#6a42c2',
                    description: (this.workspaceModal.description || '').slice(0, 200),
                    pinnedNote: '',
                    defaultModel: '',
                    defaultSettings: {},
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                this.workspaceExpanded = {
                    ...this.workspaceExpanded,
                    [newWorkspaceId]: true
                };
            }

            if (mode === 'edit') {
                const workspace = this.workspaces.find(w => w.id === this.workspaceModal.workspaceId);
                if (workspace) {
                    workspace.name = name.slice(0, 60);
                    workspace.icon = (this.workspaceModal.icon || '').slice(0, 4);
                    workspace.color = this.workspaceModal.color || '#6a42c2';
                    workspace.description = (this.workspaceModal.description || '').slice(0, 200);
                    workspace.updatedAt = new Date().toISOString();
                }
            }

            if (mode === 'delete') {
                const workspaceId = this.workspaceModal.workspaceId;
                const storageKeys = this.workspaceFiles
                    .filter(f => f.workspaceId === workspaceId)
                    .map(f => f.storageKey)
                    .filter(Boolean);

                await clearWorkspaceFileBlobs(storageKeys);
                this.workspaces = this.workspaces.filter(w => w.id !== workspaceId);
                this.workspaceFiles = this.workspaceFiles.filter(f => f.workspaceId !== workspaceId);
                const { [workspaceId]: _removed, ...restExpanded } = this.workspaceExpanded;
                this.workspaceExpanded = restExpanded;
                this.sessions = this.sessions.map(s => {
                    if (s.workspaceId === workspaceId) {
                        return { ...s, workspaceId: null, updatedAt: new Date().toISOString() };
                    }
                    return s;
                });
                if (this.selectedWorkspaceId === workspaceId) {
                    this.setWorkspaceFilter('all');
                    this.workspaceDetailsOpen = false;
                }
            }

            this.workspaceModal.show = false;
            this.persistAppState();
            await this.refreshStorageEstimate();
        },

        updateCurrentWorkspacePinnedNote(note) {
            const workspace = this.getCurrentWorkspace();
            if (!workspace) return;
            workspace.pinnedNote = note;
            workspace.updatedAt = new Date().toISOString();
            this.persistAppState();
        },

        setCurrentWorkspaceDefaultModel(modelId) {
            const workspace = this.getCurrentWorkspace();
            if (!workspace) return;
            workspace.defaultModel = modelId || '';
            workspace.updatedAt = new Date().toISOString();
            this.persistAppState();
        },

        async handleWorkspaceFileUpload(event) {
            const workspace = this.getCurrentWorkspace();
            if (!workspace) return;
            const files = Array.from(event.target.files || []);
            for (const file of files) {
                const validationError = this.validateWorkspaceFileUpload(file, workspace.id);
                if (validationError) {
                    alert(validationError);
                    continue;
                }

                const fileId = makeId('wfile');
                const storageKey = createWorkspaceFileStorageKey(workspace.id, fileId);
                await putWorkspaceFileBlob(storageKey, file);
                this.workspaceFiles.unshift({
                    id: fileId,
                    workspaceId: workspace.id,
                    name: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    size: file.size || 0,
                    storageKey,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }
            event.target.value = '';
            this.persistAppState();
            await this.refreshStorageEstimate();
        },

        async removeWorkspaceFile(fileId) {
            const file = this.workspaceFiles.find(f => f.id === fileId);
            if (!file) return;

            if (file.storageKey) {
                await deleteWorkspaceFileBlob(file.storageKey);
            }

            this.workspaceFiles = this.workspaceFiles.filter(f => f.id !== fileId);
            this.persistAppState();
            await this.refreshStorageEstimate();
        },

        async downloadWorkspaceFile(fileId) {
            const file = this.workspaceFiles.find(f => f.id === fileId);
            if (!file) return;

            let href = file.dataUrl || '';
            let objectUrl = null;

            if (!href && file.storageKey) {
                const blob = await getWorkspaceFileBlob(file.storageKey);
                if (!blob) return;
                objectUrl = URL.createObjectURL(blob);
                href = objectUrl;
            }

            if (!href) return;

            const a = document.createElement('a');
            a.href = href;
            a.download = file.name || 'workspace-file';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        },

        async exportCurrentWorkspace() {
            const workspace = this.getCurrentWorkspace();
            if (!workspace) return;

            const scopedFiles = this.workspaceFiles.filter(f => f.workspaceId === workspace.id);
            const exportFiles = [];

            for (const file of scopedFiles) {
                let dataUrl = file.dataUrl || null;
                if (!dataUrl && file.storageKey) {
                    const blob = await getWorkspaceFileBlob(file.storageKey);
                    if (blob) {
                        dataUrl = await blobToDataUrl(blob);
                    }
                }

                exportFiles.push({
                    ...file,
                    dataUrl,
                    storageKey: undefined
                });
            }

            const payload = {
                version: 1,
                exportedAt: new Date().toISOString(),
                workspace,
                chats: this.sessions.filter(s => s.workspaceId === workspace.id),
                workspaceFiles: exportFiles
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${workspace.name.replace(/\s+/g, '_').toLowerCase() || 'workspace'}.workspace.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        async importWorkspaceFromFile(event) {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.workspace) {
                    throw new Error('Invalid workspace export format.');
                }
                const importedWorkspaceId = makeId('ws');
                const baseName = (data.workspace.name || 'Imported Workspace').trim();
                const existingNames = new Set(this.workspaces.map(w => w.name));
                const name = existingNames.has(baseName) ? `${baseName} (Imported)` : baseName;

                const workspace = {
                    ...data.workspace,
                    id: importedWorkspaceId,
                    name,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                const chats = (data.chats || []).map((chat, idx) => ({
                    ...chat,
                    id: makeId(`chati${idx}`),
                    workspaceId: importedWorkspaceId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                }));

                const files = [];
                for (let idx = 0; idx < (data.workspaceFiles || []).length; idx += 1) {
                    const wf = data.workspaceFiles[idx];
                    const fileId = makeId(`wfilei${idx}`);
                    const storageKey = createWorkspaceFileStorageKey(importedWorkspaceId, fileId);

                    if (wf.dataUrl) {
                        const blob = await dataUrlToBlob(wf.dataUrl);
                        const validationError = this.validateWorkspaceFileUpload(
                            { size: blob.size || wf.size || 0 },
                            importedWorkspaceId
                        );
                        if (validationError) {
                            throw new Error(`Cannot import ${wf.name || 'workspace file'}: ${validationError}`);
                        }
                        await putWorkspaceFileBlob(storageKey, blob);
                    }

                    files.push({
                        ...wf,
                        id: fileId,
                        workspaceId: importedWorkspaceId,
                        storageKey,
                        dataUrl: undefined,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }

                this.workspaces.unshift(workspace);
                this.sessions = [...chats, ...this.sessions];
                this.workspaceFiles = [...files, ...this.workspaceFiles];
                this.setWorkspaceFilter('workspace', importedWorkspaceId);
                if (chats.length > 0) {
                    this.selectSession(chats[0].id);
                }
                this.persistAppState();
                await this.refreshStorageEstimate();
            } catch (error) {
                alert(`Workspace import failed: ${error.message}`);
            } finally {
                event.target.value = '';
            }
        },

        readFileAsDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },
        
        clearAllSessions() {
            if (confirm('Are you sure you want to clear all sessions?')) {
                this.sessions = [];
                this.messages = [];
                this.currentSession = null;
                this.persistAppState();
                this.newChat();
            }
        },
        
        selectModel(modelId) {
            this.selectedModel = modelId;
            // Refresh provider-backed capability for newly selected model.
            supportsToolsFromProvider(modelId).then((isToolCapable) => {
                const model = this.availableModels.find(m => m.id === modelId);
                if (model) {
                    model.tools = !!isToolCapable;
                }

                if (!isToolCapable && this.interactionMode === 'agent' && this.selectedModel === modelId) {
                    this.interactionMode = 'ask';
                }
            }).catch(() => {
                if (!this.modelSupportsAgent(modelId) && this.interactionMode === 'agent') {
                    this.interactionMode = 'ask';
                }
            });

            if (!this.modelSupportsAgent(modelId) && this.interactionMode === 'agent') {
                this.interactionMode = 'ask';
            }
        },

        selectInteractionMode(mode) {
            if (mode === 'agent' && !this.modelSupportsAgent(this.selectedModel)) {
                this.interactionMode = 'ask';
                return;
            }
            this.interactionMode = mode;
        },

        modelSupportsAgent(modelId = this.selectedModel) {
            const model = this.availableModels.find(m => m.id === modelId);
            if (model && typeof model.tools === 'boolean') {
                return model.tools;
            }
            return supportsTools(modelId);
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
                this.localRagStatusText = '';
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
                
                // If Local RAG is enabled, queue local indexing for document files
                if (this.localRagEnabled && !file.type.startsWith('image/')) {
                    try {
                        const workspaceId = this.getCurrentWorkspaceIdForSession(this.currentSession);
                        const selectionError = this.validateLocalRagFileSelection(file, workspaceId);
                        if (selectionError) {
                            this.localRagStatusText = selectionError;
                            return;
                        }
                        this.localRagStatusText = 'Queued for local indexing';
                        await this.indexUploadedDocumentForLocalRag(file);
                        this.localRagStatusText = this.getLocalRagStatusLabel();
                        console.log('[ChatApp] File indexed for Local RAG');
                    } catch (error) {
                        console.error('[ChatApp] Error processing file for RAG:', error);
                        this.localRagStatusText = `Local indexing failed: ${error.message}`;
                    }
                }
            }
        },
        
        clearFile() {
            this.uploadedFile = null;
            this.uploadedFileName = '';
            this.uploadedFilePreview = null;
            this.localRagStatusText = '';
            if (this.$refs.fileInput) {
                this.$refs.fileInput.value = '';
            }
        },
        
        async sendMessage() {
            if (!this.userInput.trim() || this.isLoading) return;

            // Sending a message should return to normal chat view.
            this.workspaceDetailsOpen = false;
            
            // If Local RAG is enabled, ensure scripts are loaded
            if (this.localRagEnabled) {
                try {
                    await ensureRagLoaded();
                } catch (error) {
                    console.error('[ChatApp] Failed to load RAG dependencies:', error);
                    alert('Could not load Local RAG components. Please try again.');
                    return;
                }
            }
            
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
                // Check if this is the first assistant message or if model changed
                const previousAssistantMessages = this.messages.filter(m => m.role === 'assistant');
                const lastAssistantModel = previousAssistantMessages.length > 0 
                    ? previousAssistantMessages[previousAssistantMessages.length - 1].model 
                    : null;
                const showModelInfo = previousAssistantMessages.length === 0 || lastAssistantModel !== this.selectedModel;
                
                let assistantMessage = {
                    id: Date.now() + 1,
                    role: 'assistant',
                    content: '<div class="typing-indicator"><span></span><span></span><span></span></div>',
                    model: this.selectedModel,
                    showModelInfo: showModelInfo,
                    isStreaming: true,
                    isTyping: true
                };
                this.messages.push(assistantMessage);
                const messageIndex = this.messages.length - 1;
                
                // Build conversation history (all messages except the assistant message being built)
                const conversationHistory = this.messages.slice(0, -1).map(m => ({
                    role: m.role,
                    content: m.content
                }));
                
                const canUseAgent = this.interactionMode === 'agent' && this.modelSupportsAgent(this.selectedModel);

                // Get MCP tools only for Agent mode (don't start with basicToolSchemas in web mode)
                let toolSchemas = [];
                
                if (canUseAgent && window.desktop?.isElectron && window.desktop?.getMCPToolSchemas) {
                    // Electron mode: Get desktop MCP tools + basic filesystem tools
                    toolSchemas = [...basicToolSchemas];
                    try {
                        const mcpSchemas = await window.desktop.getMCPToolSchemas();
                        if (mcpSchemas && Array.isArray(mcpSchemas)) {
                            toolSchemas = [...toolSchemas, ...mcpSchemas];
                            console.log(`[ChatApp] Loaded ${mcpSchemas.length} MCP tool schemas`);
                        }
                    } catch (error) {
                        console.warn('[ChatApp] Failed to load MCP tool schemas:', error);
                    }
                } else if (canUseAgent && window.mcpBrowserClient) {
                    // Web mode: Get browser MCP tools (no filesystem tools)
                    const browserTools = window.mcpBrowserClient.getAllTools();
                    const enabledBrowserTools = browserTools.filter(tool => tool.enabled !== false);
                    if (enabledBrowserTools && Array.isArray(enabledBrowserTools)) {
                        toolSchemas = enabledBrowserTools.map(tool => ({
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.schema || tool.inputSchema || tool.parameters
                        }));
                        console.log(`[ChatApp] Loaded ${toolSchemas.length} browser MCP tool schemas`);
                    }
                }
                
                let finalQuery = query;
                let fileForAgent = this.uploadedFile;
                this.localRagLastModeUsed = 'none';

                const isDocumentUpload = !!(this.uploadedFile && !this.uploadedFile.type.startsWith('image/'));
                if (isDocumentUpload && this.localRagEnabled) {
                    try {
                        const localResult = await this.buildLocalContextForMessage(query, this.uploadedFile);
                        if (localResult.ok) {
                            finalQuery = this.buildRagContextBlock(query, localResult.context);
                            fileForAgent = null; // Prevent backend rag_chain route when local context is available
                            this.localRagLastModeUsed = 'local';
                            this.localRagStatusText = `Using local retrieval (${localResult.usedChunks} chunks)`;
                        } else {
                            this.localRagLastModeUsed = 'backend';
                            this.localRagStatusText = 'Local retrieval unavailable. Using backend document processing.';
                        }
                    } catch (localError) {
                        console.warn('[ChatApp] Local retrieval failed, falling back to backend:', localError);
                        this.localRagLastModeUsed = 'backend';
                        this.localRagStatusText = 'Local retrieval unavailable. Using backend document processing.';
                    }
                }

                // Call agent integration (supports file uploads and conversation context)
                const result = await window.askAgent(
                    finalQuery,
                    toolSchemas,
                    this.selectedModel,
                    conversationHistory,
                    fileForAgent,
                    this.currentSession,
                    canUseAgent ? 'agent' : 'ask'
                );
                
                // Parse and stream the result
                await this.streamResponse(result, messageIndex);
                
                // Mark streaming as complete and remove any typing indicators
                this.messages[messageIndex].isStreaming = false;
                this.messages[messageIndex].isTyping = false;
                
                // Auto-generate session name from first message
                this.autoGenerateSessionName();
                
                // Save the complete message
                this.saveSessions();
                
                // Final scroll to bottom
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
                
            } catch (error) {
                console.error('Error sending message:', error);
                const canUseAgent = this.interactionMode === 'agent' && this.modelSupportsAgent(this.selectedModel);
                const suffix = canUseAgent
                    ? 'Please ensure the model server and MCP tools are accessible.'
                    : 'Please ensure the model server is accessible.';
                // Update the existing assistant message with the error
                const messageIndex = this.messages.length - 1;
                if (this.messages[messageIndex] && this.messages[messageIndex].role === 'assistant') {
                    this.messages[messageIndex].content = `Error: ${error.message}. ${suffix}`;
                    this.messages[messageIndex].isStreaming = false;
                    this.messages[messageIndex].isTyping = false;
                } else {
                    // Fallback: add new error message if something went wrong
                    this.messages.push({
                        id: Date.now() + 2,
                        role: 'assistant',
                        content: `Error: ${error.message}. ${suffix}`
                    });
                }
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
            
            // Clear typing indicator and start with empty content
            if (this.messages[messageIndex].isTyping) {
                this.messages[messageIndex].content = '';
                this.messages[messageIndex].isTyping = false;
            }
            
            // Stream text with a small delay between characters for visual effect
            const chunkSize = 10; // Characters per chunk
            const delayMs = 10; // Delay between chunks
            
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.substring(i, i + chunkSize);
                
                // Append chunk to message with typing cursor (raw text, not HTML)
                const isLastChunk = i + chunkSize >= text.length;
                this.messages[messageIndex].content = text.substring(0, i + chunk.length) + (isLastChunk ? '' : '<span class="typing-cursor"></span>');
                
                // Scroll to keep up with streaming
                this.$nextTick(() => {
                    this.scrollToBottom();
                });
                
                // Small delay to create streaming effect
                await this.delay(delayMs);
            }
            
            // Remove cursor after streaming is complete
            this.messages[messageIndex].content = text;
        },
        
        updateMessageMarkdown(messageIndex) {
            // Parse markdown ONLY if marked.js is available and content is raw text
            if (window.marked && this.messages[messageIndex]) {
                try {
                    const rawContent = this.messages[messageIndex].content;
                    
                    // Check if content is already parsed HTML (contains real HTML block tags)
                    const htmlTagPattern = /<(p|div|h[1-6]|ul|ol|li|pre|code|blockquote|strong|em|a|table|thead|tbody|tr|td|th|br|hr)\b/i;
                    if (htmlTagPattern.test(rawContent)) {
                        console.log('[ChatApp] Content already parsed, skipping markdown');
                        return;
                    }
                    
                    console.log('[ChatApp] Parsing markdown for message:', rawContent.substring(0, 50));
                    this.messages[messageIndex].content = window.marked.parse(rawContent);
                    // Inject copy buttons into code blocks after DOM updates
                    this.$nextTick(() => {
                        const container = document.getElementById('messages-container');
                        if (!container) return;
                        container.querySelectorAll('pre:not([data-copy-added])').forEach(pre => {
                            pre.setAttribute('data-copy-added', '1');
                            const btn = document.createElement('button');
                            btn.className = 'md-copy-btn';
                            btn.title = 'Copy code';
                            safeInnerHTML(btn, '<i class="fas fa-copy"></i>');
                            btn.addEventListener('click', () => {
                                const code = pre.querySelector('code');
                                navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => {
                                    safeInnerHTML(btn, '<i class="fas fa-check"></i>');
                                    btn.style.background = 'var(--accent)';
                                    btn.style.color = '#fff';
                                    const timerMgr = getTimerManager('chat-app-copy-btn');
                                    timerMgr.schedule(() => {
                                        safeInnerHTML(btn, '<i class="fas fa-copy"></i>');
                                        btn.style.background = '';
                                        btn.style.color = '';
                                    }, 1800);
                                });
                            });
                            pre.appendChild(btn);
                        });
                    });
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
                    return this.coerceContentToText(obj.result.response);
                }
                if (obj.result.message) {
                    console.log('[ChatApp] Extracted message from result.message');
                    return this.coerceContentToText(obj.result.message);
                }
                if (obj.result.content) {
                    console.log('[ChatApp] Extracted content from result.content');
                    return this.coerceContentToText(obj.result.content);
                }
            }
            
            // Direct response object with content/message/response field
            if (obj.response) {
                console.log('[ChatApp] Found direct response field');
                return this.coerceContentToText(obj.response);
            }
            if (obj.message) {
                console.log('[ChatApp] Found direct message field');
                return this.coerceContentToText(obj.message);
            }
            if (obj.content) {
                console.log('[ChatApp] Found direct content field');
                return this.coerceContentToText(obj.content);
            }
            
            // Fallback: stringify the entire object
            console.log('[ChatApp] No recognized field found, stringifying entire object');
            return JSON.stringify(obj, null, 2);
        },

        coerceContentToText(value) {
            if (value == null) return '';

            if (typeof value === 'string') {
                return value;
            }

            // OpenAI-style message object
            if (typeof value === 'object' && value.content !== undefined) {
                return this.coerceContentToText(value.content);
            }

            // Multimodal content arrays
            if (Array.isArray(value)) {
                return value
                    .map(part => {
                        if (typeof part === 'string') return part;
                        if (part && typeof part === 'object') {
                            if (typeof part.text === 'string') return part.text;
                            if (part.type === 'text' && typeof part.text === 'string') return part.text;
                        }
                        return '';
                    })
                    .join('');
            }

            try {
                return JSON.stringify(value, null, 2);
            } catch {
                return String(value);
            }
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
                // Keep full serializable message structure so tool calls/results survive reloads.
                session.messages = this.messages.map(msg => sanitizeMessageForPersistence(msg));
                session.updatedAt = new Date().toISOString();
            }
            this.persistAppState();
            console.log('[ChatApp] Sessions saved to app state');
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