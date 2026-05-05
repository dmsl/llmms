// Alpine.js Component for chat.html
// Handles chat functionality for both web and Electron modes
// Uses agent-integration.js for consistent LLM interactions across platforms

// --- RAG Lazy Loader (lightweight performance approach) ---
let ragLoaded = false;
let ragLoadingPromise = null;

const LOCAL_RAG_ASSET_URLS = {
    tfjsUrl: new URL('../../vendor/tfjs/tf.min.js', import.meta.url).href,
    useScriptUrl: new URL('../../vendor/use/universal-sentence-encoder.min.js', import.meta.url).href,
    useModelUrl: new URL('../../vendor/use/model/model.json', import.meta.url).href,
    useVocabUrl: new URL('../../vendor/use/model/vocab.json', import.meta.url).href,
    jszipUrl: new URL('../../vendor/jszip/jszip.min.js', import.meta.url).href,
    xlsxUrl: new URL('../../vendor/xlsx/xlsx.full.min.js', import.meta.url).href,
    documentParserUrl: new URL('../document-parser.js', import.meta.url).href,
    ragPolicyUrl: new URL('../browser-rag/rag-policy.js', import.meta.url).href,
    vectorStoreUrl: new URL('../browser-rag/indexed-db-vector-store.js', import.meta.url).href,
    retrieverUrl: new URL('../browser-rag/browser-retriever.js', import.meta.url).href,
    ragWorkerUrl: new URL('../browser-rag/rag-worker.js', import.meta.url).href
};

window.RAG_ASSET_URLS = {
    ...(window.RAG_ASSET_URLS || {}),
    ...LOCAL_RAG_ASSET_URLS
};

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
    RETRIEVAL_TOP_K: 10,
    RETRIEVAL_MAX_PER_FILE: 6,
    RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE: 60,
    HYBRID_MODE: 'balanced',
    HYBRID_SEMANTIC_WEIGHT: 0.62,
    HYBRID_LEXICAL_WEIGHT: 0.38,
    HYBRID_DIVERSITY_LAMBDA: 0.18,
    HYBRID_CONTEXT_CHAR_BUDGET: 9000
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
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.tfjsUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.useScriptUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.jszipUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.xlsxUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.documentParserUrl);

    // Load browser-rag implementation only when needed
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.ragPolicyUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.vectorStoreUrl);
    await loadScriptOnce(LOCAL_RAG_ASSET_URLS.retrieverUrl);

    // Initialize the USE model (downloads ~50MB model shards)
    console.log('[RAG Loader] Initializing Universal Sentence Encoder model...');
    if (window.use && !window.ragEmbeddingModel) {
      window.ragEmbeddingModel = await window.use.load({
        modelUrl: LOCAL_RAG_ASSET_URLS.useModelUrl,
        vocabUrl: LOCAL_RAG_ASSET_URLS.useVocabUrl
      });
      console.log('[RAG Loader] Model initialized successfully');
    }

    ragLoaded = true;
    console.log('[RAG Loader] All RAG dependencies loaded successfully');
  })();

  return ragLoadingPromise;
}

// Import agent integration (handles both web and Electron modes)
import {
    askAgent,
    getProviderSettings,
    loadAvailableModels,
    supportsToolsFromProvider
} from '../agent-integration.js';
import {
    DEFAULT_PROVIDER_SETTINGS,
    detectProviderProfile,
    getProviderLabel,
    normalizeProviderSettings
} from '../llm-provider-adapters.js';
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
import { extractImageTextWithOcr } from './image-ocr.js';
import { formatEvidenceContext } from '../searchProviders.js';

window.askAgent = askAgent;

// API Base URL for model loading (Electron will use this to get available models)
const API_BASE_URL = 'https://chatucy.cs.ucy.ac.cy/api';
const STORAGE_KEYS = {
    appState: 'chat_app_state_v2',
    appStateBackup: 'chat_app_state_v2_backup',
    legacySessions: 'chat_sessions',
    workspaceStoragePolicy: 'workspace_storage_policy_v1',
    localRagPrefs: 'local_rag_prefs_v1',
    llmBaseUrl: 'llm_base_url_v1',
    llmThinkingEnabled: 'llm_thinking_enabled_v1'
};

const ONBOARDING_STORAGE_KEY = 'chatucy_onboarding_seen_v1';
const A2HS_SEEN_COOKIE_KEY = 'chatucy_a2hs_seen_v1';
const ONBOARDING_STEPS = Object.freeze([
    {
        id: 'new-chat',
        selector: '[data-tour="new-chat"]',
        eyebrow: 'Quick Start',
        title: 'Start a clean conversation instantly',
        description: 'Use New chat whenever you want a fresh thread without losing older conversations in the sidebar.',
        note: 'It is the fastest way to switch topics.',
        sidebar: 'open',
        spotlightPadding: 0,
        spotlightRadius: 10
    },
    {
        id: 'workspaces',
        selector: '[data-tour="workspace-zone"] .gpt-section-title',
        eyebrow: 'Organization',
        title: 'Keep projects tidy with workspaces',
        description: 'Search chats, create workspaces, and group related sessions so files and discussions stay together.',
        note: 'This is especially helpful once you have multiple topics going.',
        sidebar: 'open',
        spotlightPadding: 0,
        spotlightRadius: 2
    },
    {
        id: 'models',
        selector: '[data-tour="composer-models"]',
        eyebrow: 'Controls',
        title: 'Choose the model and response mode',
        description: 'Pick the model you want, then switch between Ask for normal chat or Agent when a tool-capable model is available.',
        note: 'Thinking appears automatically for supported models.',
        sidebar: 'close-mobile'
    },
    {
        id: 'context',
        selector: '[data-tour="composer-context"]',
        eyebrow: 'Files',
        title: 'Attach files and private context',
        description: 'Upload a file, enable the private document store, and keep extra material inside this browser session.',
        note: 'Great for PDFs, notes, and local research.',
        sidebar: 'close-mobile'
    },
    {
        id: 'composer',
        selector: '[data-tour="composer-shell"]',
        eyebrow: 'Chat',
        title: 'Write here and send when ready',
        description: 'Type your prompt, press Enter to send, and use Shift+Enter when you want a new line.',
        note: 'You are ready to start chatting.',
        sidebar: 'close-mobile'
    },
    {
        id: 'settings',
        selector: '[data-tour="settings-button"]',
        eyebrow: 'Advanced',
        title: 'Open settings whenever you need more control',
        description: 'Settings gives you access to providers, MCP tools, and the advanced configuration for the chat.',
        note: 'You can reopen this tour from the top-right menu at any time.',
        sidebar: 'open',
        spotlightPadding: 0,
        spotlightRadius: 2
    }
]);

const DEFAULT_LLM_SETTINGS = {
    providerType: DEFAULT_PROVIDER_SETTINGS.providerType,
    baseUrl: DEFAULT_PROVIDER_SETTINGS.baseUrl,
    authToken: DEFAULT_PROVIDER_SETTINGS.authToken
};

const WORKSPACE_STORAGE_LIMIT_DEFAULTS = {
    maxFileBytes: 25 * 1024 * 1024,
    maxWorkspaceBytes: 200 * 1024 * 1024,
    maxGlobalBytes: 1024 * 1024 * 1024
};
const MAX_CONCURRENT_PER_SESSION = 3;
const SESSION_SAVE_DEBOUNCE_MS = 700;

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

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function prefersReducedMotion() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getCookieValue(name) {
    try {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : '';
    } catch {
        return '';
    }
}

function setCookieValue(name, value, maxAgeSeconds = 60 * 60 * 24 * 365) {
    try {
        document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
    } catch {
        // no-op
    }
}

function findScrollableAncestor(element) {
    if (!element || typeof window === 'undefined') {
        return null;
    }

    let current = element.parentElement;
    while (current && current !== document.body) {
        const styles = window.getComputedStyle(current);
        const overflowY = styles.overflowY || styles.overflow;
        if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight + 1) {
            return current;
        }
        current = current.parentElement;
    }

    return null;
}

function revealElementInScrollableAncestor(element, behavior = 'auto') {
    if (!element || typeof window === 'undefined') {
        return;
    }

    const container = findScrollableAncestor(element);
    if (!container) {
        return;
    }

    const targetRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const margin = 20;
    const deltaTop = targetRect.top - containerRect.top - margin;
    const deltaBottom = targetRect.bottom - containerRect.bottom + margin;

    if (deltaTop < 0) {
        container.scrollTo({
            top: Math.max(0, container.scrollTop + deltaTop),
            behavior
        });
        return;
    }

    if (deltaBottom > 0) {
        container.scrollTo({
            top: container.scrollTop + deltaBottom,
            behavior
        });
    }
}

function elementNeedsViewportReveal(element) {
    if (!element || typeof window === 'undefined') {
        return false;
    }

    const rect = element.getBoundingClientRect();
    const viewportMargin = 20;
    return rect.top < viewportMargin || rect.bottom > (window.innerHeight - viewportMargin);
}

function buildRoundedSpotlightClipPath(left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : right;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : bottom;
    const path = [
        `M 0 0 H ${viewportWidth} V ${viewportHeight} H 0 Z`,
        `M ${left + r} ${top}`,
        `H ${right - r}`,
        `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
        `V ${bottom - r}`,
        `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
        `H ${left + r}`,
        `A ${r} ${r} 0 0 1 ${left} ${bottom - r}`,
        `V ${top + r}`,
        `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
        'Z'
    ].join(' ');

    return `path(evenodd, "${path}")`;
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
    delete safe.requestId;

    return safe;
}

function hydrateMessageFromPersistence(msg) {
    const safe = sanitizeMessageForPersistence(msg || {});
    safe.isTyping = false;
    safe.isStreaming = false;
    if (safe.role === 'reasoning' && typeof safe.expanded !== 'boolean') {
        safe.expanded = false;
    }
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
        inFlightRequests: new Map(),
        requestAbortControllers: new Map(),
        canceledRequestIds: new Set(),
        pendingSessionSaveIds: new Set(),
        sessionSaveTimerId: null,
        selectedModel: 'Select Model',
        modelStatuses: {},
        modelLoadingHint: '',
        thinkingEnabled: false,
        autoScrollEnabled: true,
        manualScrollLock: false,
        interactionMode: 'agent',
        availableModels: [],
        legacyLocalRagEnabled: true,
        localRagManagerOpen: false,
        localRagMode: 'hybrid-fallback',
        localRagLastModeUsed: 'none',
        localRagStatusText: '',
        localRagFileStates: {},
        localRagWarmupDone: false,
        localRagWarmupInProgress: false,
        localRagTraceSeq: 0,
        get localRagEnabled() {
            return !!this.getCurrentSessionRecord?.()?.privateStoreEnabled;
        },
        set localRagEnabled(value) {
            const session = this.getCurrentSessionRecord?.();
            if (!session) return;
            session.privateStoreEnabled = !!value;
            session.updatedAt = new Date().toISOString();
            this.persistAppState();
        },
        ragWorker: null,
        ragWorkerReady: false,
        ragWorkerJobs: {},
        ragWorkerJobSeq: 0,
        activeIndexJobId: null,
        activeRetrievalJobId: null,
        uploadedFile: null,
        uploadedFileName: '',
        uploadedFilePreview: null, // Base64 preview for images
        uploadedFiles: [],
        conversationManager: new ConversationManager(API_BASE_URL), // Conversation summarization manager
        onboarding: {
            open: false,
            currentStep: 0,
            steps: ONBOARDING_STEPS.map((step) => ({ ...step })),
            spotlightStyle: '',
            backdropStyle: '',
            cardStyle: '',
            targetVisible: false,
            sidebarStateBeforeTour: null,
            scrollLock: null,
            closeTimer: null
        },
        addToHomePromptOpen: false,
        deferredInstallPrompt: null,
        installPromptAvailable: false,
        modal: {
            show: false,
            type: '', // 'edit' | 'delete' | 'clear'
            value: '',
            sessionId: null,
            clearIncludeWorkspaces: false
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
        workspaceResourcesModal: {
            show: false
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
            expandedServerTools: {},
            llmBaseUrl: DEFAULT_LLM_SETTINGS.baseUrl,
            llmProviderType: DEFAULT_LLM_SETTINGS.providerType,
            llmAuthToken: DEFAULT_LLM_SETTINGS.authToken,
            llmDetectedProviderType: '',
            llmSupportedProviderTypes: [],
            llmDetectionSource: '',
            llmDetectionError: '',
            llmDetecting: false,
            llmDetectionKey: '',
            newServerForm: {
                show: false,
                name: '',
                url: '',
                autoConnect: false,
                error: ''
            },
            loadLLMSettings() {
                const settings = getProviderSettings();
                this.llmBaseUrl = settings.baseUrl || DEFAULT_LLM_SETTINGS.baseUrl;
                this.llmProviderType = settings.providerType || DEFAULT_LLM_SETTINGS.providerType;
                this.llmAuthToken = settings.authToken || '';
                this.llmDetectionError = '';
                this.llmDetectedProviderType = '';
                this.llmSupportedProviderTypes = [];
                this.llmDetectionSource = '';
                this.llmDetectionKey = '';
                window.LLM_PROVIDER_SETTINGS = {
                    providerType: this.llmProviderType,
                    baseUrl: this.llmBaseUrl,
                    authToken: this.llmAuthToken
                };
                this.detectLLMProvider();
            },
            async detectLLMProvider({ force = false } = {}) {
                const baseUrl = (this.llmBaseUrl || '').trim() || DEFAULT_LLM_SETTINGS.baseUrl;
                const detectionKey = `${baseUrl}::${this.llmAuthToken ? 'token' : 'no-token'}`;
                if (!force && this.llmDetectionKey === detectionKey && (this.llmDetectedProviderType || this.llmDetectionError)) {
                    return;
                }

                this.llmDetecting = true;
                this.llmDetectionError = '';
                this.llmDetectionKey = detectionKey;
                try {
                    const result = await detectProviderProfile({
                        baseUrl,
                        authToken: (this.llmAuthToken || '').trim(),
                        providerType: this.llmProviderType
                    });
                    this.llmDetectedProviderType = result.providerType || '';
                    this.llmSupportedProviderTypes = Array.isArray(result.supportedTypes) ? result.supportedTypes : [];
                    this.llmDetectionSource = result.source || '';
                } catch (error) {
                    this.llmDetectedProviderType = '';
                    this.llmSupportedProviderTypes = [];
                    this.llmDetectionSource = '';
                    this.llmDetectionError = error?.message || 'Provider detection failed.';
                } finally {
                    this.llmDetecting = false;
                }
            },
            applyDetectedProviderType() {
                if (!this.llmDetectedProviderType) return;
                this.llmProviderType = this.llmDetectedProviderType;
            },
            getDetectedProviderLabel(providerType = this.llmDetectedProviderType) {
                return providerType ? getProviderLabel(providerType) : '';
            },
            toggleServerTools(serverName) {
                if (!serverName) return;
                this.expandedServerTools = {
                    ...this.expandedServerTools,
                    [serverName]: !this.expandedServerTools[serverName]
                };
            },
            isServerToolsExpanded(serverName) {
                return !!this.expandedServerTools?.[serverName];
            },
            saveLLMSettings() {
                const settings = normalizeProviderSettings({
                    providerType: (this.llmProviderType || DEFAULT_LLM_SETTINGS.providerType).trim() || DEFAULT_LLM_SETTINGS.providerType,
                    baseUrl: (this.llmBaseUrl || '').trim() || DEFAULT_LLM_SETTINGS.baseUrl,
                    authToken: (this.llmAuthToken || '').trim()
                });
                this.llmBaseUrl = settings.baseUrl;
                this.llmProviderType = settings.providerType;
                this.llmAuthToken = settings.authToken;
                localStorage.setItem(STORAGE_KEYS.llmBaseUrl, JSON.stringify(settings));
                window.LLM_PROVIDER_SETTINGS = settings;
                if (window.chatAppState?.loadModels) {
                    window.chatAppState.loadModels();
                }
            },
            resetLLMSettings() {
                this.llmBaseUrl = DEFAULT_LLM_SETTINGS.baseUrl;
                this.llmProviderType = DEFAULT_LLM_SETTINGS.providerType;
                this.llmAuthToken = DEFAULT_LLM_SETTINGS.authToken;
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
                    const toolStates = window.mcpConfigManager.syncToolStates(
                        server.name,
                        tools.map(t => t.name)
                    );
                    window.mcpBrowserClient.applyToolStates(server.name, toolStates);
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
            window.chatAppState = this;
            const shouldAutoOpenOnboarding = !localStorage.getItem(ONBOARDING_STORAGE_KEY);
            // Watch for sidebar state changes and persist to localStorage
            this.$watch('sidebarOpen', (value) => {
                localStorage.setItem('sidebar_open', value.toString());
            });
            const pwaEvents = getEventManager('chat-app-pwa-install');
            pwaEvents.add(window, 'beforeinstallprompt', (event) => {
                event.preventDefault();
                this.deferredInstallPrompt = event;
                this.installPromptAvailable = true;
                this.maybeShowAddToHomePrompt();
            });
            pwaEvents.add(window, 'appinstalled', () => {
                this.installPromptAvailable = false;
                this.deferredInstallPrompt = null;
                this.dismissAddToHomePrompt();
            });

            this.mcpConfigModal.loadLLMSettings();
            this.loadThinkingPreference();
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
            this.syncChatLayoutSpacing();
            this.observeChatLayoutSpacing();

            const onboardingEvents = getEventManager('chat-app-onboarding');
            onboardingEvents.add(window, 'resize', () => this.refreshOnboardingLayout(false));
            onboardingEvents.add(window, 'orientationchange', () => this.refreshOnboardingLayout(false));
            onboardingEvents.add(window, 'themechange', () => this.refreshOnboardingLayout(false));
            this.$watch('sidebarOpen', () => {
                if (this.onboarding.open) {
                    this.$nextTick(() => this.refreshOnboardingLayout(false));
                }
            });

            if (shouldAutoOpenOnboarding) {
                this.$nextTick(() => this.openOnboarding());
            } else {
                this.$nextTick(() => this.maybeShowAddToHomePrompt());
            }

            await this.refreshStorageEstimate();
            await this.migrateLegacyWorkspaceFilesToIndexedDb();
            if (this.sessions.length > 0) {
                const first = this.currentSession || this.sessions[0].id;
                this.selectSession(first);
            } else {
                // Do not auto-create a session on init. Sessions should be
                // created explicitly by the user or when the first message
                // is sent. Keep currentSession null to indicate no active
                // session exists.
                this.currentSession = null;
                this.messages = [];
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
                    if (this.localRagWarmupDone || this.localRagWarmupInProgress) {
                        return;
                    }
                    this.localRagWarmupInProgress = true;
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
                        this.localRagWarmupDone = true;
                        
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
                    } finally {
                        this.localRagWarmupInProgress = false;
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

        getCurrentOnboardingStep() {
            return this.onboarding.steps[this.onboarding.currentStep] || null;
        },

        getOnboardingProgressPercent() {
            if (!this.onboarding.steps.length) return '0%';
            return `${((this.onboarding.currentStep + 1) / this.onboarding.steps.length) * 100}%`;
        },

        openOnboarding(force = false) {
            if (!force && localStorage.getItem(ONBOARDING_STORAGE_KEY)) {
                return;
            }

            if (this.onboarding.closeTimer) {
                clearTimeout(this.onboarding.closeTimer);
                this.onboarding.closeTimer = null;
            }

            if (this.onboarding.sidebarStateBeforeTour === null) {
                this.onboarding.sidebarStateBeforeTour = this.sidebarOpen;
            }

            this.onboarding.currentStep = 0;
            this.onboarding.open = true;
            this.lockOnboardingScroll();
            this.refreshOnboardingLayout(true);
        },

        closeOnboarding(markSeen = true) {
            if (this.onboarding.closeTimer) {
                clearTimeout(this.onboarding.closeTimer);
                this.onboarding.closeTimer = null;
            }

            this.onboarding.open = false;
            this.onboarding.closeTimer = setTimeout(() => {
                this.onboarding.targetVisible = false;
                this.onboarding.spotlightStyle = '';
                this.onboarding.backdropStyle = '';
                this.onboarding.cardStyle = '';
                this.unlockOnboardingScroll();
                this.onboarding.closeTimer = null;
            }, 180);

            if (markSeen) {
                localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
            }

            if (window.innerWidth < 1024 && typeof this.onboarding.sidebarStateBeforeTour === 'boolean') {
                this.sidebarOpen = this.onboarding.sidebarStateBeforeTour;
            }

            this.onboarding.sidebarStateBeforeTour = null;
            this.$nextTick(() => this.maybeShowAddToHomePrompt());
        },

        isIosMobile() {
            const ua = navigator.userAgent || '';
            const iOS = /iPad|iPhone|iPod/.test(ua)
                || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            return iOS && window.innerWidth <= 1024;
        },

        isRunningStandalonePwa() {
            return window.matchMedia?.('(display-mode: standalone)')?.matches === true
                || window.navigator.standalone === true;
        },

        hasSeenAddToHomePrompt() {
            if (getCookieValue(A2HS_SEEN_COOKIE_KEY) === '1') return true;
            return localStorage.getItem(A2HS_SEEN_COOKIE_KEY) === '1';
        },

        markAddToHomePromptSeen() {
            setCookieValue(A2HS_SEEN_COOKIE_KEY, '1');
            localStorage.setItem(A2HS_SEEN_COOKIE_KEY, '1');
        },

        dismissAddToHomePrompt() {
            this.addToHomePromptOpen = false;
            this.markAddToHomePromptSeen();
        },

        maybeShowAddToHomePrompt() {
            if (this.hasSeenAddToHomePrompt()) return;
            if (this.isRunningStandalonePwa()) return;
            if (this.installPromptAvailable || this.isIosMobile()) {
                this.addToHomePromptOpen = true;
            }
        },

        async handleAddToHomePromptClick() {
            if (!this.installPromptAvailable || !this.deferredInstallPrompt) {
                // Manual path (iOS / unsupported browsers): try opening native Share sheet.
                if (navigator.share) {
                    try {
                        await navigator.share({
                            title: 'Chat UCY',
                            text: 'Open Chat UCY',
                            url: window.location.href
                        });
                    } catch (error) {
                        // User canceled share sheet or browser blocked it; keep tip visible.
                        console.info('[ChatApp] Share sheet was not completed:', error?.message || error);
                    }
                }
                return;
            }
            try {
                this.deferredInstallPrompt.prompt();
                const choice = await this.deferredInstallPrompt.userChoice;
                if (choice?.outcome === 'accepted' || choice?.outcome === 'dismissed') {
                    this.dismissAddToHomePrompt();
                }
            } catch (error) {
                console.warn('[ChatApp] Install prompt failed:', error);
            } finally {
                this.deferredInstallPrompt = null;
                this.installPromptAvailable = false;
            }
        },

        getAddToHomePromptHintText() {
            if (this.installPromptAvailable) {
                return 'Tap to Install App';
            }
            return 'Share -> Add to Home Screen';
        },

        lockOnboardingScroll() {
            if (this.onboarding.scrollLock || typeof document === 'undefined' || typeof window === 'undefined') {
                return;
            }

            const handleWindowScroll = () => {
                if (!this.onboarding.scrollLock) {
                    return;
                }
                if (window.scrollX !== this.onboarding.scrollLock.scrollX || window.scrollY !== this.onboarding.scrollLock.scrollY) {
                    window.scrollTo(this.onboarding.scrollLock.scrollX, this.onboarding.scrollLock.scrollY);
                }
            };

            this.onboarding.scrollLock = {
                htmlOverflow: document.documentElement.style.overflow,
                bodyOverflow: document.body.style.overflow,
                scrollX: window.scrollX,
                scrollY: window.scrollY,
                handleWindowScroll
            };

            document.documentElement.style.overflow = 'hidden';
            document.body.style.overflow = 'hidden';
            window.addEventListener('scroll', handleWindowScroll, { passive: true });
            window.scrollTo(this.onboarding.scrollLock.scrollX, this.onboarding.scrollLock.scrollY);
        },

        unlockOnboardingScroll() {
            if (!this.onboarding.scrollLock || typeof document === 'undefined' || typeof window === 'undefined') {
                return;
            }

            document.documentElement.style.overflow = this.onboarding.scrollLock.htmlOverflow;
            document.body.style.overflow = this.onboarding.scrollLock.bodyOverflow;
            window.removeEventListener('scroll', this.onboarding.scrollLock.handleWindowScroll);
            window.scrollTo(this.onboarding.scrollLock.scrollX, this.onboarding.scrollLock.scrollY);
            this.onboarding.scrollLock = null;
        },

        reopenOnboarding() {
            this.openOnboarding(true);
        },

        nextOnboardingStep() {
            if (this.onboarding.currentStep >= this.onboarding.steps.length - 1) {
                this.closeOnboarding(true);
                return;
            }

            this.onboarding.currentStep += 1;
            this.refreshOnboardingLayout(true);
        },

        previousOnboardingStep() {
            if (this.onboarding.currentStep <= 0) {
                return;
            }

            this.onboarding.currentStep -= 1;
            this.refreshOnboardingLayout(true);
        },

        applyOnboardingSidebarState(step) {
            if (!step) return;

            if (step.sidebar === 'open') {
                this.sidebarOpen = true;
                return;
            }

            if (step.sidebar === 'close-mobile' && window.innerWidth < 1024) {
                this.sidebarOpen = false;
            }
        },

        refreshOnboardingLayout(revealTarget = false) {
            if (!this.onboarding.open) {
                return;
            }

            const step = this.getCurrentOnboardingStep();
            if (!step) {
                return;
            }

            this.applyOnboardingSidebarState(step);

            this.$nextTick(() => {
                requestAnimationFrame(() => {
                    const target = document.querySelector(step.selector);
                    if (!target) {
                        this.onboarding.targetVisible = false;
                        this.onboarding.spotlightStyle = '';
                        this.onboarding.backdropStyle = 'inset:0;';
                        this.onboarding.cardStyle = 'left:12px; top:12px; width:min(380px, calc(100vw - 24px));';
                        return;
                    }

                    const applyLayout = () => {
                        const rect = target.getBoundingClientRect();
                        const padding = Number.isFinite(step.spotlightPadding)
                            ? step.spotlightPadding
                            : (window.innerWidth < 768 ? 10 : 14);
                        const inset = 10;
                        const top = clampNumber(rect.top - padding, inset, Math.max(inset, window.innerHeight - 48));
                        const left = clampNumber(rect.left - padding, inset, Math.max(inset, window.innerWidth - 48));
                        const maxWidth = Math.max(48, window.innerWidth - left - inset);
                        const maxHeight = Math.max(48, window.innerHeight - top - inset);
                        const width = clampNumber(rect.width + (padding * 2), 48, maxWidth);
                        const height = clampNumber(rect.height + (padding * 2), 48, maxHeight);
                        const compact = window.innerWidth < 900;
                        const targetCenterX = rect.left + (rect.width / 2);
                        const targetCenterY = rect.top + (rect.height / 2);
                        const cardWidth = compact
                            ? Math.min(Math.max(240, window.innerWidth - 24), window.innerWidth - 24)
                            : Math.min(380, Math.max(280, window.innerWidth - 48));
                        const safeTop = 12;
                        const safeBottom = 12;
                        const cardElement = typeof document !== 'undefined'
                            ? document.querySelector('.chatucy-tour-card')
                            : null;
                        const measuredCardHeight = cardElement?.offsetHeight || 0;
                        const fallbackCardHeight = compact ? 286 : 312;
                        const cardHeight = Math.max(measuredCardHeight, fallbackCardHeight);
                        const maxCardTop = Math.max(safeTop, window.innerHeight - cardHeight - safeBottom);

                        this.onboarding.targetVisible = true;
                        const spotlightRadius = Number.isFinite(step.spotlightRadius)
                            ? step.spotlightRadius
                            : Math.min(24, Math.max(16, Math.round(height / 3)));
                        this.onboarding.spotlightStyle = [
                            `top:${top}px`,
                            `left:${left}px`,
                            `width:${width}px`,
                            `height:${height}px`,
                            `border-radius:${spotlightRadius}px`
                        ].join(';');
                        this.onboarding.backdropStyle = [
                            'inset:0',
                            `clip-path:${buildRoundedSpotlightClipPath(left, top, width, height, spotlightRadius)}`,
                            `-webkit-clip-path:${buildRoundedSpotlightClipPath(left, top, width, height, spotlightRadius)}`
                        ].join(';');

                        if (compact) {
                            const preferredCardTop = targetCenterY > (window.innerHeight * 0.58)
                                ? 12
                                : maxCardTop;
                            const cardTop = clampNumber(preferredCardTop, safeTop, maxCardTop);
                            this.onboarding.cardStyle = `left:12px; top:${cardTop}px; width:${cardWidth}px;`;
                            return;
                        }

                        const cardLeft = targetCenterX < (window.innerWidth / 2)
                            ? Math.max(24, window.innerWidth - cardWidth - 24)
                            : 24;
                        const preferredCardTop = targetCenterY > (window.innerHeight * 0.55)
                            ? 24
                            : maxCardTop;
                        const cardTop = clampNumber(preferredCardTop, safeTop, maxCardTop);
                        this.onboarding.cardStyle = `left:${cardLeft}px; top:${cardTop}px; width:${cardWidth}px;`;
                    };

                    if (revealTarget && elementNeedsViewportReveal(target)) {
                        revealElementInScrollableAncestor(target, prefersReducedMotion() ? 'auto' : 'smooth');
                        requestAnimationFrame(applyLayout);
                        return;
                    }

                    applyLayout();
                });
            });
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
                const toolStates = window.mcpConfigManager.syncToolStates(
                    serverName,
                    tools.map(tool => tool.name)
                );

                if (serverConfig?.enabled) {
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
                privateStoreEnabled: typeof s.privateStoreEnabled === 'boolean'
                    ? s.privateStoreEnabled
                    : true,
                workspaceId: s.workspaceId && workspaceIds.has(s.workspaceId) ? s.workspaceId : null,
                localDocumentRefs: Array.isArray(s.localDocumentRefs) ? s.localDocumentRefs : []
            }));
            this.workspaces = this.workspaces.map(workspace => ({
                ...workspace,
                localDocumentRefs: Array.isArray(workspace.localDocumentRefs) ? workspace.localDocumentRefs : []
            }));
            this.sessions.forEach(session => {
                this.pruneSessionDocumentRefs(session.id);
            });
            this.workspaces.forEach(workspace => {
                this.pruneWorkspaceDocumentRefs(workspace.id);
            });
        },

        loadLocalRagPrefs() {
            try {
                const raw = localStorage.getItem(STORAGE_KEYS.localRagPrefs);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                this.legacyLocalRagEnabled = typeof parsed.localRagEnabled === 'boolean'
                    ? parsed.localRagEnabled
                    : true;
                this.localRagFileStates = parsed.localRagFileStates || {};
            } catch (error) {
                console.warn('[ChatApp] Failed to load local RAG preferences:', error);
            }
        },

        loadThinkingPreference() {
            try {
                this.thinkingEnabled = localStorage.getItem(STORAGE_KEYS.llmThinkingEnabled) === 'true';
            } catch (error) {
                this.thinkingEnabled = false;
            }
        },

        saveThinkingPreference() {
            try {
                localStorage.setItem(STORAGE_KEYS.llmThinkingEnabled, this.thinkingEnabled ? 'true' : 'false');
            } catch (error) {
                console.warn('[ChatApp] Failed to persist thinking preference:', error);
            }
        },

        persistLocalRagPrefs() {
            try {
                localStorage.setItem(STORAGE_KEYS.localRagPrefs, JSON.stringify({
                    localRagEnabled: this.getCurrentSessionPrivateStoreEnabled(),
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
            if (!window.browserRetriever?.vectorDB) {
                throw new Error('indexeddb-unavailable');
            }
            if (!window.browserRetriever?.embeddingModel) {
                try {
                    await window.browserRetriever.initializeEmbeddingModel();
                } catch (error) {
                    throw new Error(`embedding-init-failed: ${error?.message || String(error)}`);
                }
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
                this.ragWorker = new Worker(LOCAL_RAG_ASSET_URLS.ragWorkerUrl);
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
                    this.localRagStatusText = 'Local RAG worker error. Check browser console.';
                };
            }

            if (!this.ragWorkerReady) {
                this.ragWorkerJobSeq += 1;
                const initJobId = `init_${Date.now()}_${this.ragWorkerJobSeq}`;
                try {
                    await new Promise((resolve, reject) => {
                        this.ragWorkerJobs[initJobId] = { resolve, reject, onProgress: null };
                        this.ragWorker.postMessage({ type: 'init', jobId: initJobId, payload: {} });
                    });
                } catch (error) {
                    this.localRagStatusText = 'worker-init-failed';
                    this.ragLog('RAG:workerInit', { ok: false, initJobId, error: error?.message || String(error) });
                    throw new Error(`worker-init-failed: ${error?.message || String(error)}`);
                }
                this.ragWorkerReady = true;
                this.ragLog('RAG:workerInit', { ok: true, initJobId });
            }

            return this.ragWorker;
        },

        async postRagWorkerTask(type, payload, options = {}) {
            await this.ensureRagWorker();
            this.ragWorkerJobSeq += 1;
            const jobId = `${type}_${Date.now()}_${this.ragWorkerJobSeq}`;
            this.ragLog('RAG:workerTaskStart', { type, jobId });

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
            await ensureRagLoaded();
            if (!window.ChatUcyDocumentParser?.extractText) {
                throw new Error('Document extraction runtime is not loaded');
            }

            return window.ChatUcyDocumentParser.extractText(file);
        },

        getCurrentWorkspaceIdForSession(sessionId = this.currentSession) {
            const session = this.sessions.find(s => s.id === sessionId);
            return session?.workspaceId || null;
        },

        getWorkspaceScopeKey(workspaceId) {
            return workspaceId || 'unassigned';
        },

        buildLocalRagFileId(file, scope) {
            const scopeType = scope.scopeType || (scope.chatId ? 'chat' : 'workspace');
            const workspacePart = scope.workspaceId || 'unassigned';
            const chatPart = scope.chatId || 'none';
            return `${scopeType}::${workspacePart}::${chatPart}::${file.name}::${file.size || 0}::${file.lastModified || 0}`;
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
                scopeType: 'chat',
                workspaceId: this.getCurrentWorkspaceIdForSession(this.currentSession),
                chatId: this.currentSession
            };
            const fileId = this.buildLocalRagFileId(this.uploadedFile, scope);
            return this.localRagFileStates[fileId] || null;
        },

        getCurrentSessionRecord(sessionId = this.currentSession) {
            return this.sessions.find(s => s.id === sessionId) || null;
        },

        getWorkspaceById(workspaceId) {
            return this.workspaces.find(workspace => workspace.id === workspaceId) || null;
        },

        getWorkspaceDocumentRefs(workspaceId = this.selectedWorkspaceId) {
            const workspace = this.getWorkspaceById(workspaceId);
            return Array.isArray(workspace?.localDocumentRefs) ? workspace.localDocumentRefs : [];
        },

        addWorkspaceDocumentRef(ref, workspaceId = this.selectedWorkspaceId) {
            const workspace = this.getWorkspaceById(workspaceId);
            if (!workspace || !ref?.fileId) return;

            const existingRefs = Array.isArray(workspace.localDocumentRefs) ? workspace.localDocumentRefs : [];
            const alreadyExists = existingRefs.some(item => item?.fileId === ref.fileId);
            if (alreadyExists) {
                workspace.localDocumentRefs = existingRefs.map(item => (
                    item?.fileId === ref.fileId
                        ? { ...item, ...ref, updatedAt: new Date().toISOString() }
                        : item
                ));
            } else {
                workspace.localDocumentRefs = [
                    ...existingRefs,
                    {
                        ...ref,
                        addedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                ];
            }
            workspace.updatedAt = new Date().toISOString();
        },

        pruneWorkspaceDocumentRefs(workspaceId = this.selectedWorkspaceId) {
            const workspace = this.getWorkspaceById(workspaceId);
            if (!workspace) return;

            const refs = Array.isArray(workspace.localDocumentRefs) ? workspace.localDocumentRefs : [];
            workspace.localDocumentRefs = refs.filter(ref => {
                const state = ref?.fileId ? this.localRagFileStates?.[ref.fileId] : null;
                return state?.status === 'indexed';
            });
        },

        removeLocalRagState(fileId) {
            if (!fileId || !this.localRagFileStates?.[fileId]) return;
            const nextStates = { ...this.localRagFileStates };
            delete nextStates[fileId];
            this.localRagFileStates = nextStates;
        },

        removeLocalRagStatesByFilters(filters = {}) {
            const nextStates = {};
            for (const [fileId, state] of Object.entries(this.localRagFileStates || {})) {
                if (Array.isArray(filters.fileIds) && filters.fileIds.length > 0 && !filters.fileIds.includes(fileId)) {
                    nextStates[fileId] = state;
                    continue;
                }
                if (filters.scopeType && state?.scopeType !== filters.scopeType) {
                    nextStates[fileId] = state;
                    continue;
                }
                if (filters.sourceType && state?.sourceType !== filters.sourceType) {
                    nextStates[fileId] = state;
                    continue;
                }
                if (filters.workspaceId !== undefined && state?.workspaceId !== filters.workspaceId) {
                    nextStates[fileId] = state;
                    continue;
                }
                if (filters.chatId !== undefined && state?.chatId !== filters.chatId) {
                    nextStates[fileId] = state;
                    continue;
                }
            }
            this.localRagFileStates = nextStates;
        },

        getCurrentSessionPrivateStoreEnabled(sessionId = this.currentSession) {
            return !!this.getCurrentSessionRecord(sessionId)?.privateStoreEnabled;
        },

        setCurrentSessionPrivateStoreEnabled(enabled, sessionId = this.currentSession) {
            const session = this.getCurrentSessionRecord(sessionId);
            if (!session) return false;
            session.privateStoreEnabled = !!enabled;
            session.updatedAt = new Date().toISOString();
            this.persistAppState();
            return true;
        },

        getSessionDocumentRefs(sessionId = this.currentSession) {
            const session = this.getCurrentSessionRecord(sessionId);
            return Array.isArray(session?.localDocumentRefs) ? session.localDocumentRefs : [];
        },

        addSessionDocumentRef(ref, sessionId = this.currentSession) {
            const session = this.getCurrentSessionRecord(sessionId);
            if (!session || !ref?.fileId) return;

            const existingRefs = Array.isArray(session.localDocumentRefs) ? session.localDocumentRefs : [];
            const alreadyExists = existingRefs.some(item => item?.fileId === ref.fileId);
            if (alreadyExists) {
                session.localDocumentRefs = existingRefs.map(item => (
                    item?.fileId === ref.fileId
                        ? { ...item, ...ref, updatedAt: new Date().toISOString() }
                        : item
                ));
            } else {
                session.localDocumentRefs = [
                    ...existingRefs,
                    {
                        ...ref,
                        addedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                ];
            }
            session.updatedAt = new Date().toISOString();
        },

        pruneSessionDocumentRefs(sessionId = this.currentSession) {
            const session = this.getCurrentSessionRecord(sessionId);
            if (!session) return;

            const refs = Array.isArray(session.localDocumentRefs) ? session.localDocumentRefs : [];
            session.localDocumentRefs = refs.filter(ref => {
                const state = ref?.fileId ? this.localRagFileStates?.[ref.fileId] : null;
                return state?.status === 'indexed';
            });
        },

        getSessionPrivateDocCount(sessionId = this.currentSession) {
            return this.getSessionDocumentRefs(sessionId).length;
        },

        getGlobalPrivateDocCount() {
            return this.sessions.reduce((sum, session) => {
                const refs = Array.isArray(session?.localDocumentRefs) ? session.localDocumentRefs : [];
                return sum + refs.length;
            }, 0);
        },

        toggleLocalRagEnabled() {
            if (!this.currentSession || !this.sessions.find(s => s.id === this.currentSession)) {
                this.newChat();
            }
            const nextValue = !this.getCurrentSessionPrivateStoreEnabled();
            const applied = this.setCurrentSessionPrivateStoreEnabled(nextValue);
            const sessionId = this.currentSession;
            this.localRagStatusText = nextValue
                ? `Local RAG enabled for chat ${sessionId}`
                : `Local RAG disabled for chat ${sessionId}`;
            this.ragLog('RAG:toggle', { sessionId, enabled: nextValue, applied });
        },

        makeRagTraceId(sessionId = this.currentSession) {
            this.localRagTraceSeq = Number(this.localRagTraceSeq || 0) + 1;
            return `rag_${sessionId || 'nochat'}_${Date.now()}_${this.localRagTraceSeq}`;
        },

        ragLog(event, details = {}) {
            try {
                console.log(`[LocalRAG] ${event}`, details);
            } catch (_) {
                // noop
            }
        },

        async removeSessionDocument(fileId, sessionId = this.currentSession) {
            const session = this.getCurrentSessionRecord(sessionId);
            if (!session || !fileId) return;

            const ref = this.getSessionDocumentRefs(sessionId).find(item => item?.fileId === fileId);
            const workspaceId = ref?.workspaceId ?? this.getCurrentWorkspaceIdForSession(sessionId);
            const chatId = ref?.chatId ?? sessionId;

            await this.ensureLocalRetriever();
            if (window.browserRetriever?.deleteDocumentsByFilters) {
                await window.browserRetriever.deleteDocumentsByFilters({
                    sourceType: ref?.sourceType || 'chatAttachment',
                    workspaceId,
                    chatId,
                    fileId
                });
            }

            session.localDocumentRefs = this.getSessionDocumentRefs(sessionId).filter(item => item?.fileId !== fileId);
            this.removeLocalRagState(fileId);

            if (this.uploadedFile) {
                const uploadedFileId = this.buildLocalRagFileId(this.uploadedFile, {
                    workspaceId: this.getCurrentWorkspaceIdForSession(sessionId),
                    chatId: sessionId
                });
                if (uploadedFileId === fileId) {
                    this.localRagStatusText = '';
                }
            }

            session.updatedAt = new Date().toISOString();
            this.persistLocalRagPrefs();
            this.saveSessions();
        },

        async clearSessionDocumentStore(sessionId = this.currentSession) {
            const refs = [...this.getSessionDocumentRefs(sessionId)];
            for (const ref of refs) {
                await this.removeSessionDocument(ref.fileId, sessionId);
            }
            this.inFlightRequests.delete(sessionId);
            this.localRagManagerOpen = false;
            this.localRagStatusText = '';
        },

        async removeWorkspaceDocument(fileId, workspaceId = this.selectedWorkspaceId) {
            const workspace = this.getWorkspaceById(workspaceId);
            if (!workspace || !fileId) return;

            const ref = this.getWorkspaceDocumentRefs(workspaceId).find(item => item?.fileId === fileId);
            if (!ref) return;

            await this.ensureLocalRetriever();
            if (window.browserRetriever?.deleteDocumentsByFilters) {
                await window.browserRetriever.deleteDocumentsByFilters({
                    sourceType: ref?.sourceType || 'workspaceAttachment',
                    workspaceId,
                    chatId: null,
                    fileId
                });
            }

            workspace.localDocumentRefs = this.getWorkspaceDocumentRefs(workspaceId).filter(item => item?.fileId !== fileId);
            this.removeLocalRagState(fileId);
            workspace.updatedAt = new Date().toISOString();
            this.persistLocalRagPrefs();
            this.saveSessions();
        },

        async clearWorkspaceDocumentStore(workspaceId = this.selectedWorkspaceId) {
            const refs = [...this.getWorkspaceDocumentRefs(workspaceId)];
            for (const ref of refs) {
                await this.removeWorkspaceDocument(ref.fileId, workspaceId);
            }
        },

        async clearAllPrivateDocumentStores() {
            await this.ensureLocalRetriever();

            if (window.browserRetriever?.deleteDocumentsByFilters) {
                await window.browserRetriever.deleteDocumentsByFilters({
                    sourceType: 'chatAttachment'
                });
                await window.browserRetriever.deleteDocumentsByFilters({
                    sourceType: 'workspaceAttachment'
                });
            } else if (window.browserRetriever?.clearAllDocuments) {
                await window.browserRetriever.clearAllDocuments();
            }

            this.sessions = this.sessions.map(session => ({
                ...session,
                localDocumentRefs: [],
                updatedAt: new Date().toISOString()
            }));
            this.workspaces = this.workspaces.map(workspace => ({
                ...workspace,
                localDocumentRefs: [],
                updatedAt: new Date().toISOString()
            }));

            this.localRagFileStates = {};
            this.localRagStatusText = '';
            this.localRagManagerOpen = false;
            this.persistLocalRagPrefs();
            this.saveSessions();
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

        buildKnowledgeContextBlock(query, { localContext = '', evidenceBundle = null } = {}) {
            const sections = [
                'Use the evidence below to answer the question. If the evidence is incomplete, say so briefly rather than guessing.'
            ];

            if (localContext) {
                sections.push('', 'Local context:', localContext);
            }

            if (Array.isArray(evidenceBundle?.items) && evidenceBundle.items.length > 0) {
                const webEvidence = formatEvidenceContext(evidenceBundle, { maxItems: 12 });
                sections.push('', webEvidence);
            }

            sections.push('', `User question: ${query}`);
            return sections.join('\n');
        },

        async indexUploadedDocumentForLocalRag(file, sessionId = this.currentSession) {
            const limits = getRagLimits();
            const scope = {
                scopeType: 'chat',
                workspaceId: this.getCurrentWorkspaceIdForSession(sessionId),
                chatId: sessionId
            };

            const selectionError = this.validateLocalRagFileSelection(file, scope.workspaceId);
            if (selectionError) {
                return { ok: false, error: selectionError };
            }

            const fileId = this.buildLocalRagFileId(file, scope);
            this.ragLog('RAG:indexStart', { sessionId, fileId, fileName: file?.name, workspaceId: scope.workspaceId });
            const existingState = this.localRagFileStates[fileId];
            if (existingState?.status === 'indexed') {
                this.addSessionDocumentRef({
                    fileId,
                    name: file.name,
                    workspaceId: scope.workspaceId,
                    chatId: scope.chatId,
                    sourceType: 'chatAttachment',
                    chunkCount: existingState.chunkCount || 0,
                    estimatedBytes: existingState.estimatedBytes || 0
                }, scope.chatId);
                return { ok: true, fileId, chunkCount: existingState.chunkCount || 0 };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexing',
                name: file.name,
                scopeType: scope.scopeType,
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
                        this.ragLog('RAG:indexProgress', { sessionId, fileId, processed, total });
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
                this.ragLog('RAG:indexFail', { sessionId, fileId, error: errorMessage });
                return { ok: false, fileId, error: errorMessage };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexed',
                chunkCount: result.chunkCount || 0,
                estimatedBytes: result.estimatedBytes || 0,
                extractedTextBytes: result.extractedTextBytes || 0,
                error: ''
            });
            try {
                await this.ensureLocalRetriever();
                if (window.browserRetriever?.vectorDB?.size) {
                    const localVectorCount = await window.browserRetriever.vectorDB.size();
                    const scopedVectorCount = window.browserRetriever?.vectorDB?.countByFilter
                        ? await window.browserRetriever.vectorDB.countByFilter({
                            sourceType: 'chatAttachment',
                            workspaceId: scope.workspaceId,
                            chatId: scope.chatId,
                            fileId
                        })
                        : null;
                    console.log('[ChatApp] Local vector count after index:', localVectorCount);
                    this.ragLog('RAG:indexDone', {
                        sessionId,
                        fileId,
                        chunkCount: result.chunkCount || 0,
                        globalVectorCount: localVectorCount,
                        scopedVectorCount
                    });
                    if (!Number.isFinite(localVectorCount) || localVectorCount <= 0) {
                        this.localRagStatusText = 'Indexing completed but no vectors found in IndexedDB.';
                        this.ragLog('RAG:indexeddbWarning', {
                            sessionId,
                            fileId,
                            dbName: window.browserRetriever?.vectorDB?.dbName || 'unknown',
                            storeName: window.browserRetriever?.vectorDB?.storeName || 'unknown'
                        });
                    }
                }
            } catch (verifyError) {
                console.warn('[ChatApp] Could not verify local vector count:', verifyError);
                this.ragLog('RAG:indexeddbVerifyFail', { sessionId, fileId, error: verifyError?.message || String(verifyError) });
            }
            this.addSessionDocumentRef({
                fileId,
                name: file.name,
                workspaceId: scope.workspaceId,
                chatId: scope.chatId,
                sourceType: 'chatAttachment',
                chunkCount: result.chunkCount || 0,
                estimatedBytes: result.estimatedBytes || 0
            }, scope.chatId);
            this.updateLocalRagWarnings(scope.workspaceId);
            return { ok: true, fileId, chunkCount: result.chunkCount || 0 };
        },

        async indexOcrTextForLocalRag(file, ocrText, sessionId = this.currentSession) {
            const limits = getRagLimits();
            const scope = {
                scopeType: 'chat',
                workspaceId: this.getCurrentWorkspaceIdForSession(sessionId),
                chatId: sessionId
            };
            const fileId = this.buildLocalRagFileId(file, scope);
            const existingState = this.localRagFileStates[fileId];
            if (existingState?.status === 'indexed') {
                return { ok: true, fileId, chunkCount: existingState.chunkCount || 0 };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexing',
                name: file.name,
                scopeType: scope.scopeType,
                sourceType: 'chatAttachment',
                workspaceId: scope.workspaceId,
                chatId: scope.chatId,
                chunkCount: 0,
                estimatedBytes: 0,
                error: ''
            });

            const extractedTextBytes = new TextEncoder().encode(ocrText || '').length;
            const workerTask = await this.postRagWorkerTask('indexText', {
                text: ocrText,
                descriptor: {
                    fileId,
                    source: file.name,
                    sourceName: file.name,
                    sourceType: 'chatAttachment',
                    workspaceId: scope.workspaceId,
                    chatId: scope.chatId,
                    replaceExisting: true,
                    extractedTextBytes,
                    extractionHints: { kind: 'ocr' }
                },
                limits
            });

            let result;
            try {
                result = await workerTask.promise;
            } catch (error) {
                this.setLocalRagFileState(fileId, {
                    status: 'failed',
                    error: error?.message || 'OCR indexing failed'
                });
                return { ok: false, fileId, error: error?.message || 'OCR indexing failed' };
            }

            if (!result?.success) {
                const errorMessage = result?.error || 'OCR indexing failed';
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
            this.addSessionDocumentRef({
                fileId,
                name: file.name,
                workspaceId: scope.workspaceId,
                chatId: scope.chatId,
                sourceType: 'chatAttachment',
                chunkCount: result.chunkCount || 0,
                estimatedBytes: result.estimatedBytes || 0
            }, scope.chatId);
            return { ok: true, fileId, chunkCount: result.chunkCount || 0 };
        },

        async indexWorkspaceFileForLocalRag(file, workspaceId = this.selectedWorkspaceId) {
            const limits = getRagLimits();
            const scope = {
                scopeType: 'workspace',
                workspaceId,
                chatId: null
            };

            if (!workspaceId) {
                return { ok: false, error: 'no-workspace' };
            }

            const selectionError = this.validateLocalRagFileSelection(file, workspaceId);
            if (selectionError) {
                return { ok: false, error: selectionError };
            }

            const fileId = this.buildLocalRagFileId(file, scope);
            const existingState = this.localRagFileStates[fileId];
            if (existingState?.status === 'indexed') {
                this.addWorkspaceDocumentRef({
                    fileId,
                    name: file.name,
                    workspaceId,
                    chatId: null,
                    scopeType: scope.scopeType,
                    sourceType: 'workspaceAttachment',
                    chunkCount: existingState.chunkCount || 0,
                    estimatedBytes: existingState.estimatedBytes || 0
                }, workspaceId);
                return { ok: true, fileId, chunkCount: existingState.chunkCount || 0 };
            }

            this.setLocalRagFileState(fileId, {
                status: 'indexing',
                name: file.name,
                scopeType: scope.scopeType,
                sourceType: 'workspaceAttachment',
                workspaceId,
                chatId: null,
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
                        sourceType: 'workspaceAttachment',
                        workspaceId,
                        chatId: null,
                        replaceExisting: true,
                        extractedTextBytes
                    },
                    limits
                },
                {
                    onProgress: (progress) => {
                        const processed = Number(progress?.processedChunks || 0);
                        const total = Number(progress?.totalChunks || 0);
                        this.localRagStatusText = `Indexing workspace file... ${processed}/${total}`;
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
            this.addWorkspaceDocumentRef({
                fileId,
                name: file.name,
                workspaceId,
                chatId: null,
                scopeType: scope.scopeType,
                sourceType: 'workspaceAttachment',
                chunkCount: result.chunkCount || 0,
                estimatedBytes: result.estimatedBytes || 0
            }, workspaceId);
            this.updateLocalRagWarnings(workspaceId);
            return { ok: true, fileId, chunkCount: result.chunkCount || 0 };
        },

        async buildLocalContextForMessage(query, uploadedDocumentFile, sessionId = this.currentSession) {
            if (uploadedDocumentFile) {
                const indexResult = await this.indexUploadedDocumentForLocalRag(uploadedDocumentFile, sessionId);
                if (!indexResult.ok) {
                    return { ok: false, reason: indexResult.error || 'index-failed' };
                }
            }

            const scope = {
                scopeType: 'chat',
                workspaceId: this.getCurrentWorkspaceIdForSession(sessionId),
                chatId: sessionId
            };
            const sessionFileIds = this.getSessionDocumentRefs(scope.chatId)
                .map(ref => ref?.fileId)
                .filter(Boolean);
            const workspaceFileIds = scope.workspaceId
                ? this.getWorkspaceDocumentRefs(scope.workspaceId)
                    .map(ref => ref?.fileId)
                    .filter(Boolean)
                : [];

            if (sessionFileIds.length === 0 && workspaceFileIds.length === 0) {
                return { ok: false, reason: 'no-session-documents' };
            }

            const limits = getRagLimits();
            if (this.activeRetrievalJobId) {
                this.cancelRagWorkerTask(this.activeRetrievalJobId);
            }

            const retrievalJobs = [];
            if (sessionFileIds.length > 0) {
                this.ragLog('RAG:retrieveStart', {
                    sessionId,
                    sourceType: 'chatAttachment',
                    topK: limits.RETRIEVAL_TOP_K || 5,
                    fileIds: sessionFileIds
                });
                retrievalJobs.push(await this.postRagWorkerTask('retrieve', {
                    query,
                    maxResults: limits.RETRIEVAL_TOP_K || 5,
                    filters: {
                        sourceType: 'chatAttachment',
                        workspaceId: scope.workspaceId,
                        chatId: scope.chatId,
                        fileIds: sessionFileIds
                    },
                    options: {
                        candidateLimitPerSource: limits.RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE || 20,
                        maxPerFile: limits.RETRIEVAL_MAX_PER_FILE || 2
                    }
                }));
            }
            if (workspaceFileIds.length > 0) {
                this.ragLog('RAG:retrieveStart', {
                    sessionId,
                    sourceType: 'workspaceAttachment',
                    topK: limits.RETRIEVAL_TOP_K || 5,
                    fileIds: workspaceFileIds
                });
                retrievalJobs.push(await this.postRagWorkerTask('retrieve', {
                    query,
                    maxResults: limits.RETRIEVAL_TOP_K || 5,
                    filters: {
                        sourceType: 'workspaceAttachment',
                        workspaceId: scope.workspaceId,
                        chatId: null,
                        fileIds: workspaceFileIds
                    },
                    options: {
                        candidateLimitPerSource: limits.RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE || 20,
                        maxPerFile: limits.RETRIEVAL_MAX_PER_FILE || 2
                    }
                }));
            }

            const docs = [];
            const diagnostics = [];
            for (const workerTask of retrievalJobs) {
                this.activeRetrievalJobId = workerTask.jobId;
                try {
                    const result = (await workerTask.promise) || [];
                    if (Array.isArray(result)) {
                        docs.push(...result);
                    } else if (result && Array.isArray(result.docs)) {
                        docs.push(...result.docs);
                        diagnostics.push(result.diagnostics || {});
                    }
                } finally {
                    this.activeRetrievalJobId = null;
                }
            }

            if (docs.length === 0) {
                this.ragLog('RAG:retrieveDone', { sessionId, chunks: 0 });
                return { ok: false, reason: 'no-local-results' };
            }
            this.ragLog('RAG:retrieveDone', {
                sessionId,
                chunks: docs.length,
                fileIdsHit: [...new Set(docs.map(d => d?.metadata?.fileId).filter(Boolean))],
                candidateCounts: diagnostics.map(d => d?.candidateCounts || null),
                scoreSummary: diagnostics.map(d => d?.scoreSummary || null),
                mode: diagnostics.map(d => d?.mode || null),
                expandedQuery: diagnostics.map(d => d?.expandedQuery || null)
            });

            const charBudget = Number(limits.HYBRID_CONTEXT_CHAR_BUDGET || 9000);
            let used = 0;
            const contextParts = [];
            for (const doc of docs) {
                const src = doc.metadata?.source || 'document';
                const chunkNo = (doc.metadata?.chunkIndex ?? 0) + 1;
                const pos = Number(doc.metadata?.docPosition ?? -1);
                const posLabel = pos >= 0 ? `, Pos: ${Math.round(pos * 100)}%` : '';
                const section = doc.metadata?.sectionHint ? `, Section: ${doc.metadata.sectionHint}` : '';
                const block = `[Source: ${src}, Chunk: ${chunkNo}${posLabel}${section}]\n${doc.text}`;
                if (used + block.length > charBudget && contextParts.length > 0) break;
                contextParts.push(block);
                used += block.length + 2;
            }
            const context = contextParts.join('\n\n');

            const firstMode = diagnostics.find(d => d?.mode)?.mode || 'hybrid-balanced';
            return {
                ok: true,
                context,
                usedChunks: contextParts.length,
                retrievalMode: firstMode
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
            this.sessions = this.normalizeSessions(legacy || [], !!this.legacyLocalRagEnabled);
            this.workspaces = [];
            this.workspaceFiles = [];
            this.currentSession = this.sessions[0]?.id || null;
            this.persistAppState();
        },

        normalizeSessions(sessions, defaultPrivateStoreEnabled = true) {
            return (sessions || []).map((s, idx) => ({
                id: s.id || makeId('chat'),
                name: s.name || `Chat ${idx + 1}`,
                messages: Array.isArray(s.messages)
                    ? s.messages.map(m => hydrateMessageFromPersistence(m))
                    : [],
                localDocumentRefs: Array.isArray(s.localDocumentRefs) ? s.localDocumentRefs : [],
                workspaceId: s.workspaceId ?? null,
                privateStoreEnabled: typeof s.privateStoreEnabled === 'boolean'
                    ? s.privateStoreEnabled
                    : !!defaultPrivateStoreEnabled,
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
                localDocumentRefs: Array.isArray(w.localDocumentRefs) ? w.localDocumentRefs : [],
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
                const serializableSessions = this.sessions.map(session => ({
                    ...session,
                    messages: Array.isArray(session.messages)
                        ? session.messages.map(msg => sanitizeMessageForPersistence(msg))
                        : []
                }));
                const payload = {
                    version: 2,
                    sessions: serializableSessions,
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
            if (typeof document !== 'undefined' && document.activeElement?.blur) {
                document.activeElement.blur();
            }
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

        syncChatLayoutSpacing() {
            const inputArea = document.getElementById('input-area');
            const chatHistory = document.getElementById('chat-history');
            const messagesContainer = document.getElementById('messages-container');
            if (!inputArea || !messagesContainer) return;

            const inputAreaHeight = inputArea.offsetHeight || 0;
            if (chatHistory) {
                chatHistory.style.setProperty('--chat-composer-height', `${inputAreaHeight}px`);
            }
            messagesContainer.style.paddingBottom = `${inputAreaHeight + 20}px`;
        },

        observeChatLayoutSpacing() {
            if (this._chatLayoutResizeObserver) {
                this._chatLayoutResizeObserver.disconnect();
            }

            const inputArea = document.getElementById('input-area');
            if (!inputArea || typeof ResizeObserver === 'undefined') {
                return;
            }

            this._chatLayoutResizeObserver = new ResizeObserver(() => {
                this.syncChatLayoutSpacing();
            });
            this._chatLayoutResizeObserver.observe(inputArea);
        },

        isNearChatBottom(threshold = 96) {
            const chatHistory = document.getElementById('chat-history');
            if (!chatHistory) return true;
            const distanceFromBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight;
            return distanceFromBottom <= threshold;
        },

        handleChatScroll() {
            const nearBottom = this.isNearChatBottom(12);
            if (this.manualScrollLock) {
                if (nearBottom) {
                    this.manualScrollLock = false;
                    this.autoScrollEnabled = true;
                } else {
                    this.autoScrollEnabled = false;
                }
                return;
            }
            this.autoScrollEnabled = nearBottom;
        },

        handleChatWheel(event) {
            const chatHistory = document.getElementById('chat-history');
            if (!chatHistory) return;

            if (event.deltaY < 0) {
                this.manualScrollLock = true;
                this.autoScrollEnabled = false;
                // Interrupt any in-progress smooth auto-scroll immediately.
                chatHistory.scrollTo({
                    top: chatHistory.scrollTop,
                    behavior: 'auto'
                });
                return;
            }

            if (this.isNearChatBottom()) {
                this.autoScrollEnabled = true;
            }
        },
        
        scrollToBottom(options = {}) {
            const { force = false, behavior = 'smooth' } = options;
            const chatHistory = document.getElementById('chat-history');
            this.syncChatLayoutSpacing();

            if (chatHistory) {
                if (!force && (!this.autoScrollEnabled || this.manualScrollLock)) {
                    return;
                }
                chatHistory.scrollTo({
                    top: chatHistory.scrollHeight,
                    behavior
                });
                this.autoScrollEnabled = true;
                if (force) {
                    this.manualScrollLock = false;
                }
            }
        },

        getSessionById(sessionId = this.currentSession) {
            if (!sessionId) return null;
            return this.sessions.find(s => s.id === sessionId) || null;
        },

        getSessionMessages(sessionId = this.currentSession) {
            const session = this.getSessionById(sessionId);
            if (!session) return [];
            if (!Array.isArray(session.messages)) {
                session.messages = [];
            }
            return session.messages;
        },

        getInFlightRequestCount(sessionId = this.currentSession) {
            if (!sessionId) return 0;
            const pending = this.inFlightRequests.get(sessionId);
            return pending ? pending.size : 0;
        },

        hasActiveResponse(sessionId = this.currentSession) {
            return this.getInFlightRequestCount(sessionId) > 0;
        },

        isSessionAtConcurrencyLimit(sessionId = this.currentSession) {
            return this.getInFlightRequestCount(sessionId) >= MAX_CONCURRENT_PER_SESSION;
        },

        canSendCurrentSession() {
            return !!this.userInput.trim() && !this.isSessionAtConcurrencyLimit(this.currentSession);
        },

        canComposerPrimaryAction() {
            return this.hasActiveResponse(this.currentSession) || !!this.userInput.trim();
        },

        async handleComposerPrimaryAction() {
            if (this.hasActiveResponse(this.currentSession)) {
                if (this.userInput.trim()) {
                    await this.sendMessage();
                    return;
                }
                await this.stopCurrentSessionResponses();
                return;
            }
            await this.sendMessage();
        },

        registerInFlightRequest(sessionId, requestId) {
            if (!sessionId || !requestId) return;
            if (!this.inFlightRequests.has(sessionId)) {
                this.inFlightRequests.set(sessionId, new Set());
            }
            this.inFlightRequests.get(sessionId).add(requestId);
            console.log('[ChatApp] Request started', {
                sessionId,
                requestId,
                activeRequests: this.getInFlightRequestCount(sessionId)
            });
        },

        unregisterInFlightRequest(sessionId, requestId) {
            if (!sessionId || !requestId) return;
            const pending = this.inFlightRequests.get(sessionId);
            if (!pending) return;
            pending.delete(requestId);
            if (pending.size === 0) {
                this.inFlightRequests.delete(sessionId);
            }
            console.log('[ChatApp] Request completed', {
                sessionId,
                requestId,
                activeRequests: this.getInFlightRequestCount(sessionId)
            });
            this.requestAbortControllers.delete(requestId);
        },

        registerRequestAbortController(requestId, controller) {
            if (!requestId || !controller) return;
            this.requestAbortControllers.set(requestId, controller);
        },

        async stopCurrentSessionResponses(sessionId = this.currentSession, reason = 'Stopped by user.') {
            if (!sessionId) return false;
            const pending = this.inFlightRequests.get(sessionId);
            if (!pending || pending.size === 0) return false;

            const requestIds = [...pending];
            for (const requestId of requestIds) {
                this.canceledRequestIds.add(requestId);
                const controller = this.requestAbortControllers.get(requestId);
                if (controller) {
                    try {
                        controller.abort();
                    } catch (error) {
                        console.warn('[ChatApp] Failed to abort request', { requestId, error });
                    }
                }
                this.requestAbortControllers.delete(requestId);
            }
            this.inFlightRequests.delete(sessionId);

            const sessionMessages = this.getSessionMessages(sessionId);
            const pendingSet = new Set(requestIds);
            for (const message of sessionMessages) {
                if (message?.role !== 'assistant') continue;
                if (!message.requestId || !pendingSet.has(message.requestId)) continue;
                const hadRawText = typeof message.rawText === 'string' && message.rawText.trim().length > 0;
                if (!hadRawText && message.isTyping) {
                    message.content = '';
                    message.rawText = '';
                }
                message.isStreaming = false;
                message.isTyping = false;
                message.finishReason = message.finishReason || 'stopped';
            }

            this.saveSessions(sessionId);
            return true;
        },

        scheduleSessionSave(sessionId = this.currentSession) {
            if (sessionId) {
                this.pendingSessionSaveIds.add(sessionId);
            }
            if (this.sessionSaveTimerId) return;
            this.sessionSaveTimerId = window.setTimeout(() => {
                this.sessionSaveTimerId = null;
                this.persistAppState();
                this.pendingSessionSaveIds.clear();
            }, SESSION_SAVE_DEBOUNCE_MS);
        },

        findMessageIndexById(messageId, sessionId = this.currentSession) {
            const messages = this.getSessionMessages(sessionId);
            return messages.findIndex(message => message.id === messageId);
        },

        getMessageById(messageId, sessionId = this.currentSession) {
            const messages = this.getSessionMessages(sessionId);
            const messageIndex = this.findMessageIndexById(messageId, sessionId);
            return messageIndex >= 0 ? messages[messageIndex] : null;
        },

        ensureReasoningMessageForAssistant(assistantMessageId, sessionId = this.currentSession) {
            const messages = this.getSessionMessages(sessionId);
            const assistantIndex = this.findMessageIndexById(assistantMessageId, sessionId);
            if (assistantIndex === -1) return null;

            const assistantMessage = messages[assistantIndex];
            if (!assistantMessage || assistantMessage.role !== 'assistant') return null;

            if (assistantMessage.reasoningMessageId) {
                const existing = this.getMessageById(assistantMessage.reasoningMessageId, sessionId);
                if (existing) return existing;
            }

            const reasoningMessage = {
                id: makeId('reasoning'),
                role: 'reasoning',
                content: '',
                rawText: '',
                expanded: false,
                model: assistantMessage.model || null,
                providerLabel: assistantMessage.providerLabel || '',
                parentMessageId: assistantMessage.id
            };

            messages.splice(assistantIndex, 0, reasoningMessage);
            assistantMessage.reasoningMessageId = reasoningMessage.id;
            return reasoningMessage;
        },

        scheduleStreamingMarkdownRender(assistantMessageId, sessionId = this.currentSession) {
            const timerKey = `${sessionId}:${assistantMessageId}`;
            if (!window.marked) {
                const message = this.getMessageById(assistantMessageId, sessionId);
                if (message) {
                    message.content = `${message.rawText || ''}<span class="typing-cursor"></span>`;
                }
                return;
            }

            if (!this._streamMarkdownTimers) {
                this._streamMarkdownTimers = {};
            }

            if (this._streamMarkdownTimers[timerKey]) {
                return;
            }

            this._streamMarkdownTimers[timerKey] = window.setTimeout(() => {
                delete this._streamMarkdownTimers[timerKey];
                this.renderStreamingMarkdown(assistantMessageId, sessionId);
            }, 80);
        },

        cancelStreamingMarkdownRender(assistantMessageId, sessionId = this.currentSession) {
            const timerKey = `${sessionId}:${assistantMessageId}`;
            if (!this._streamMarkdownTimers?.[timerKey]) return;
            window.clearTimeout(this._streamMarkdownTimers[timerKey]);
            delete this._streamMarkdownTimers[timerKey];
        },

        renderStreamingMarkdown(assistantMessageId, sessionId = this.currentSession) {
            const message = this.getMessageById(assistantMessageId, sessionId);
            if (!message) return;

            const rawText = message.rawText || '';
            if (!rawText) {
                message.content = '<span class="typing-cursor"></span>';
                return;
            }

            if (!window.marked) {
                message.content = `${rawText}<span class="typing-cursor"></span>`;
                return;
            }

            try {
                const parsed = window.marked.parse(rawText);
                message.content = `${parsed}<span class="typing-cursor"></span>`;
            } catch (error) {
                console.warn('[ChatApp] Incremental markdown render failed, falling back to raw text:', error);
                message.content = `${rawText}<span class="typing-cursor"></span>`;
            }
        },
        
        detectModelCapabilities(modelName) {
            const name = modelName.toLowerCase();
            return {
                vision: name.includes('vision') || name.includes('llava') || name.includes('minicpm-v') || 
                        name.includes('moondream') || name.includes('bakllava') || name.includes('qwen') && name.includes('vl') ||
                        name.includes('gemma3') || name.includes('llama3.2-vision') || name.includes('llama4'),
                tools: name.includes('gpt-4') || name.includes('gpt-5') || name.includes('gpt-oss') ||
                       name.includes('claude') || name.includes('gemini') || name.includes('qwen3') ||
                       name.includes('llama3.1') || name.includes('llama3.3') || name.includes('llama4') ||
                       name.includes('mistral') || name.includes('command-r') || name.includes('deepseek-v3') ||
                       name.includes('granite'),
                thinking: name.includes('deepseek-r1') || name.includes('deepseek-v3') || name.includes('qwq') ||
                         name.includes('gpt-oss') || name.includes('magistral') ||
                         (name.includes('qwen3') && !name.includes('coder'))
            };
        },

        isEmbeddingOnlyModel(model) {
            if (!model) return false;
            if (model.embedding === true) return true;
            if (model.chatCapable === false) return true;

            const id = String(model.id || model.displayName || '').toLowerCase();
            return id.includes('embed') ||
                id.includes('embedding') ||
                id.startsWith('bge') ||
                id.includes('bge-') ||
                id.includes('e5-') ||
                id === 'e5' ||
                id.includes('nomic-embed') ||
                id.includes('text-embedding') ||
                id.includes('snowflake-arctic-embed') ||
                id.includes('mxbai-embed');
        },

        filterChatModels(models) {
            const list = Array.isArray(models) ? models : [];
            const filtered = list.filter(model => !this.isEmbeddingOnlyModel(model));
            return filtered.length > 0 ? filtered : list;
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

            const exactPreferred = models.find(model => String(model.id || '').toLowerCase() === 'gemma4:26b');
            if (exactPreferred) {
                return exactPreferred.id;
            }

            const toolCapable = models.filter(m => m.toolSupport === true);
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
                const models = this.filterChatModels(await loadAvailableModels());
                this.availableModels = models.map(model => {
                    const inferred = this.detectModelCapabilities(model.id || model.displayName || '');
                    return {
                        ...model,
                        tools: model.toolSupport === true,
                        iconVision: model.vision === true || inferred.vision === true,
                        iconTools: model.toolSupport === true || inferred.tools === true,
                        iconThinking: model.thinking === true || inferred.thinking === true
                    };
                });

                if (this.availableModels.length > 0) {
                    const selectedStillExists = this.availableModels.some(model => model.id === this.selectedModel);
                    if (!selectedStillExists) {
                        const preferred = this.pickPreferredDefaultModel(this.availableModels);
                        if (preferred) {
                            this.selectedModel = preferred;
                        }
                    }
                }

                console.log('[ChatApp] Successfully loaded models');
            } catch (error) {
                console.error('[ChatApp] Failed to load models from provider:', error);
                try {
                    const response = await fetch(`${API_BASE_URL}/get_models`);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const data = await response.json();
                    const settings = getProviderSettings();
                    const providerLabel = settings.providerType === 'ollama'
                        ? 'Ollama'
                        : settings.providerType === 'anthropic-compatible'
                            ? 'Anthropic-Compatible'
                            : 'OpenAI-Compatible';
                    this.availableModels = Array.isArray(data.models)
                        ? this.filterChatModels(data.models.map(model => {
                            const modelId = model.id || model.name || model;
                            const embedding = this.isEmbeddingOnlyModel({ id: modelId });
                            const inferred = this.detectModelCapabilities(modelId);
                            return {
                                id: modelId,
                                displayName: this.formatModelName(modelId),
                                providerType: settings.providerType,
                                providerLabel,
                                providerSource: 'backend-fallback',
                                contextWindow: Number(model.context_length) > 0 ? Number(model.context_length) : null,
                                maxOutputTokens: null,
                                knowledgeCutoff: null,
                                metadataVerified: Number(model.context_length) > 0,
                                metadataTrust: Number(model.context_length) > 0 ? 'verified' : 'unknown',
                                toolSupport: null,
                                toolSupportProvenance: 'unknown',
                                tools: false,
                                embedding,
                                chatCapable: !embedding,
                                vision: false,
                                thinking: false,
                                iconVision: inferred.vision === true,
                                iconTools: inferred.tools === true,
                                iconThinking: inferred.thinking === true
                            };
                        }))
                        : [];
                } catch (fallbackError) {
                    console.error('[ChatApp] Failed to load models from backend fallback:', fallbackError);
                    this.availableModels = [];
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
                privateStoreEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                modelOverride: workspaceDefaults?.defaultModel || null
            };
            this.sessions.unshift(newSession); // Add to the beginning of the array
            this.currentSession = newSession.id;
            this.messages = newSession.messages;
            if (workspaceDefaults?.defaultModel) {
                this.selectedModel = workspaceDefaults.defaultModel;
            }
            this.saveSessions();
            this.$nextTick(() => {
                this.scrollToBottom({ force: true, behavior: 'auto' });
            });
        },
        
        autoGenerateSessionName(sessionId = this.currentSession) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            
            // Only auto-generate if this is the first user message and name is default
            const sessionMessages = this.getSessionMessages(sessionId);
            const userMessages = sessionMessages.filter(m => m.role === 'user');
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
            if (typeof document !== 'undefined' && document.activeElement?.blur) {
                document.activeElement.blur();
            }
            this.currentSession = sessionId;
            this.workspaceDetailsOpen = false;
            this.currentWorkspaceFilter = 'all';
            this.selectedWorkspaceId = null;
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                this.pruneSessionDocumentRefs(sessionId);
                if (!Array.isArray(session.messages)) {
                    session.messages = [];
                }
                this.messages = session.messages;
                
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
                this.scrollToBottom({ force: true, behavior: 'auto' });
            });
        },
        
        editSessionName(sessionId) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                this.modal = {
                    show: true,
                    type: 'edit',
                    value: session.name,
                    sessionId: sessionId,
                    clearIncludeWorkspaces: false
                };
            }
        },
        
        deleteSession(sessionId) {
            this.modal = {
                show: true,
                type: 'delete',
                value: '',
                sessionId: sessionId,
                clearIncludeWorkspaces: false
            };
        },

        openClearChatsModal() {
            this.modal = {
                show: true,
                type: 'clear',
                value: '',
                sessionId: null,
                clearIncludeWorkspaces: false
            };
        },
        
        async confirmModal() {
            if (this.modal.type === 'edit') {
                const session = this.sessions.find(s => s.id === this.modal.sessionId);
                if (session && this.modal.value.trim()) {
                    session.name = this.modal.value.trim();
                    this.saveSessions();
                }
            } else if (this.modal.type === 'delete') {
                const index = this.sessions.findIndex(s => s.id === this.modal.sessionId);
                if (index !== -1) {
                    await this.clearSessionDocumentStore(this.modal.sessionId);
                    this.sessions.splice(index, 1);
                    
                    // If we deleted the current session, switch to another or create new
                    if (this.currentSession === this.modal.sessionId) {
                        if (this.sessions.length > 0) {
                            this.selectSession(this.sessions[0].id);
                        } else {
                            // Do not auto-create a new session when the last one
                            // is deleted. Clear currentSession/messages and
                            // persist the empty state.
                            this.currentSession = null;
                            this.messages = [];
                            this.persistAppState();
                        }
                    }
                    
                    this.saveSessions();
                }
            } else if (this.modal.type === 'clear') {
                await this.executeClearChats({
                    includeWorkspaces: this.modal.clearIncludeWorkspaces === true
                });
            }
            
            this.modal.show = false;
        },

        async executeClearChats({ includeWorkspaces = false } = {}) {
            const sessionsToRemove = includeWorkspaces
                ? [...this.sessions]
                : this.sessions.filter(s => !s.workspaceId);
            const removedSessionIds = new Set(sessionsToRemove.map(s => s.id));

            if (removedSessionIds.size === 0 && !includeWorkspaces) {
                return;
            }

            if (includeWorkspaces) {
                const workspaceStorageKeys = this.workspaceFiles
                    .map(file => file?.storageKey)
                    .filter(Boolean);

                await clearWorkspaceFileBlobs(workspaceStorageKeys);
                await this.clearAllPrivateDocumentStores();
                this.inFlightRequests.clear();

                this.sessions = [];
                this.workspaces = [];
                this.workspaceFiles = [];
                this.workspaceExpanded = {};
                this.currentWorkspaceFilter = 'all';
                this.selectedWorkspaceId = null;
                this.workspaceDetailsOpen = false;
            } else {
                for (const session of sessionsToRemove) {
                    await this.clearSessionDocumentStore(session.id);
                }
                this.sessions = this.sessions.filter(s => !removedSessionIds.has(s.id));
            }

            for (const sessionId of removedSessionIds) {
                this.inFlightRequests.delete(sessionId);
            }

            if (this.currentSession && removedSessionIds.has(this.currentSession)) {
                if (this.sessions.length > 0) {
                    this.selectSession(this.sessions[0].id);
                } else {
                    this.currentSession = null;
                    this.messages = [];
                }
            } else if (this.currentSession) {
                const currentExists = this.sessions.find(s => s.id === this.currentSession);
                if (currentExists) {
                    this.messages = Array.isArray(currentExists.messages) ? currentExists.messages : [];
                } else if (this.sessions.length > 0) {
                    this.selectSession(this.sessions[0].id);
                } else {
                    this.currentSession = null;
                    this.messages = [];
                }
            } else {
                this.messages = [];
            }

            this.persistAppState();
            await this.refreshStorageEstimate();
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
            const newWorkspaceId = makeId('ws');
            this.workspaces.unshift({
                id: newWorkspaceId,
                name: 'Untitled workspace',
                icon: '',
                color: '#6a42c2',
                description: '',
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
            this.setWorkspaceFilter('workspace', newWorkspaceId);
            this.workspaceDetailsOpen = true;
            this.persistAppState();
        },

        openEditWorkspace(workspaceId) {
            this.selectWorkspace(workspaceId);
        },

        openWorkspaceResourcesModal() {
            if (!this.getCurrentWorkspace()) return;
            this.workspaceResourcesModal.show = true;
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
                    icon: '',
                    color: '#6a42c2',
                    description: '',
                    pinnedNote: '',
                    defaultModel: '',
                    defaultSettings: {},
                    localDocumentRefs: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                this.workspaceExpanded = {
                    ...this.workspaceExpanded,
                    [newWorkspaceId]: true
                };
                this.setWorkspaceFilter('workspace', newWorkspaceId);
                this.workspaceDetailsOpen = true;
            }

            if (mode === 'delete') {
                const workspaceId = this.workspaceModal.workspaceId;
                const deletedSessionIds = new Set(
                    this.sessions.filter(s => s.workspaceId === workspaceId).map(s => s.id)
                );
                const workspaceRefs = [...this.getWorkspaceDocumentRefs(workspaceId)];
                const storageKeys = this.workspaceFiles
                    .filter(f => f.workspaceId === workspaceId)
                    .map(f => f.storageKey)
                    .filter(Boolean);

                await clearWorkspaceFileBlobs(storageKeys);
                for (const sessionId of deletedSessionIds) {
                    await this.clearSessionDocumentStore(sessionId);
                }
                for (const ref of workspaceRefs) {
                    if (window.browserRetriever?.deleteDocumentsByFilters && ref?.fileId) {
                        await window.browserRetriever.deleteDocumentsByFilters({
                            sourceType: 'workspaceAttachment',
                            workspaceId,
                            chatId: null,
                            fileId: ref.fileId
                        });
                    }
                    this.removeLocalRagState(ref.fileId);
                }
                this.workspaces = this.workspaces.filter(w => w.id !== workspaceId);
                this.workspaceFiles = this.workspaceFiles.filter(f => f.workspaceId !== workspaceId);
                const { [workspaceId]: _removed, ...restExpanded } = this.workspaceExpanded;
                this.workspaceExpanded = restExpanded;
                this.sessions = this.sessions.filter(s => s.workspaceId !== workspaceId);
                if (this.selectedWorkspaceId === workspaceId) {
                    this.setWorkspaceFilter('all');
                    this.workspaceDetailsOpen = false;
                }
                if (this.currentSession && deletedSessionIds.has(this.currentSession)) {
                    if (this.sessions.length > 0) {
                        this.selectSession(this.sessions[0].id);
                    } else {
                        this.currentSession = null;
                        this.messages = [];
                    }
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

        updateCurrentWorkspaceMeta(patch = {}) {
            const workspace = this.getCurrentWorkspace();
            if (!workspace) return;
            if (typeof patch.name === 'string') {
                workspace.name = patch.name.slice(0, 60);
            }
            if (typeof patch.icon === 'string') {
                workspace.icon = patch.icon.slice(0, 4);
            }
            if (typeof patch.color === 'string') {
                workspace.color = patch.color || '#6a42c2';
            }
            if (typeof patch.description === 'string') {
                workspace.description = patch.description.slice(0, 200);
            }
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

                if (!file.type.startsWith('image/')) {
                    try {
                        await this.indexWorkspaceFileForLocalRag(file, workspace.id);
                        this.localRagStatusText = this.getLocalRagStatusLabel();
                    } catch (error) {
                        console.error('[ChatApp] Workspace file indexing failed:', error);
                        this.localRagStatusText = `Workspace indexing failed: ${error.message}`;
                    }
                }
            }
            event.target.value = '';
            this.persistAppState();
            await this.refreshStorageEstimate();
        },

        async removeWorkspaceFile(fileId) {
            const file = this.workspaceFiles.find(f => f.id === fileId);
            if (!file) return;

            await this.removeWorkspaceDocument(fileId, file.workspaceId);
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
                    localDocumentRefs: Array.isArray(data.workspace.localDocumentRefs) ? data.workspace.localDocumentRefs : [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                const chats = (data.chats || []).map((chat, idx) => ({
                    ...chat,
                    id: makeId(`chati${idx}`),
                    workspaceId: importedWorkspaceId,
                    privateStoreEnabled: typeof chat.privateStoreEnabled === 'boolean' ? chat.privateStoreEnabled : false,
                    localDocumentRefs: Array.isArray(chat.localDocumentRefs) ? chat.localDocumentRefs : [],
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
            this.openClearChatsModal();
        },
        
        selectModel(modelId) {
            this.selectedModel = modelId;
            if (!this.selectedModelSupportsThinking(modelId)) {
                this.thinkingEnabled = false;
                this.saveThinkingPreference();
            }
            supportsToolsFromProvider(modelId).then((isToolCapable) => {
                const model = this.availableModels.find(m => m.id === modelId);
                if (model) {
                    model.toolSupport = !!isToolCapable;
                    model.toolSupportProvenance = 'verified';
                    model.tools = !!isToolCapable;
                }
            }).catch(() => {
                const model = this.availableModels.find(m => m.id === modelId);
                if (model) {
                    model.toolSupport = null;
                    model.toolSupportProvenance = 'unknown';
                    model.tools = false;
                }
            });
        },

        selectInteractionMode(mode) {
            this.interactionMode = mode === 'ask' ? 'ask' : 'agent';
        },

        toggleThinking() {
            if (!this.selectedModelSupportsThinking()) {
                this.thinkingEnabled = false;
                this.saveThinkingPreference();
                return;
            }
            this.thinkingEnabled = !this.thinkingEnabled;
            this.saveThinkingPreference();
        },

        modelSupportsAgent(modelId = this.selectedModel) {
            const model = this.availableModels.find(m => m.id === modelId);
            return model?.toolSupport === true;
        },

        selectedModelSupportsThinking(modelId = this.selectedModel) {
            const model = this.availableModels.find(m => m.id === modelId);
            return model?.thinking === true || model?.iconThinking === true;
        },

        selectedModelSupportsVision(modelId = this.selectedModel) {
            const model = this.availableModels.find(m => m.id === modelId);
            return model?.vision === true || model?.iconVision === true;
        },

        buildImageOcrContextBlock(query, ocrText) {
            return [
                'The attached image was converted to text using OCR because the selected model does not support vision.',
                '',
                'OCR text:',
                ocrText,
                '',
                `User question: ${query}`
            ].join('\n');
        },

        getAgentModeHint(modelId = this.selectedModel) {
            const model = this.availableModels.find(m => m.id === modelId);
            if (!model) {
                return 'Agent requires a verified tools-capable model.';
            }
            if (model.toolSupport === true) {
                return 'Agent is available for this model.';
            }
            if (model.toolSupportProvenance === 'unknown') {
                return 'Agent is disabled until tool support is verified for this provider/model.';
            }
            return 'Agent requires a verified tools-capable model.';
        },

        formatModelMetaNumber(value) {
            if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
                return 'Unknown';
            }

            const num = Number(value);
            if (num >= 1000000) return `${Math.round(num / 100000) / 10}M`;
            if (num >= 1000) return `${Math.round(num / 100) / 10}K`;
            return String(num);
        },

        getModelMetaLine(model) {
            if (!model) return '';

            const parts = [
                model.providerLabel || 'Provider Unknown',
                `Ctx ${this.formatModelMetaNumber(model.contextWindow)}`,
                `Max ${this.formatModelMetaNumber(model.maxOutputTokens)}`,
                `Cutoff ${model.knowledgeCutoff || 'Unknown'}`
            ];

            return parts.join(' · ');
        },
        
        getSelectedModelName() {
            const model = this.availableModels.find(m => m.id === this.selectedModel);
            return model ? model.displayName : this.formatModelName(this.selectedModel) || 'Select Model';
        },
        getModelStatus(modelId = this.selectedModel) {
            return this.modelStatuses[modelId] || 'unknown';
        },
        setModelStatus(modelId, status) {
            if (!modelId) return;
            this.modelStatuses[modelId] = status;
        },

        formatProviderErrorMessage(error, { modelId = '', canUseAgent = false } = {}) {
            const raw = String(error?.message || error || 'Unknown error');
            const msg = raw.toLowerCase();
            const modelNote = modelId ? ` (model: ${modelId})` : '';

            if (msg.includes('load failed')) {
                return `Could not reach the model backend${modelNote}. Check network reachability, CORS/TLS, and that the model server is running.`;
            }
            if (msg.includes('aborted') || msg.includes('aborterror')) {
                return `Generation was stopped before completion${modelNote}.`;
            }
            if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network error')) {
                return `Network request failed${modelNote}. Verify base URL, server availability, and browser network access.`;
            }
            if (msg.includes('timeout') || msg.includes('timed out')) {
                return `Model request timed out${modelNote}. The model may be cold-starting or overloaded; retry after it becomes responsive.`;
            }
            if (msg.includes('503') || msg.includes('502') || msg.includes('gateway')) {
                return `Model backend is temporarily unavailable${modelNote} (gateway/service error). Try again shortly.`;
            }
            if (msg.includes('404')) {
                return `Model endpoint was not found${modelNote}. Check provider base URL and API path configuration.`;
            }
            if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
                return `Authorization failed${modelNote}. Verify API key/token and provider permissions.`;
            }
            if (msg.includes('model') && (msg.includes('not found') || msg.includes('no such'))) {
                return `Selected model is unavailable on the provider${modelNote}. Pull/install the model or choose another one.`;
            }
            if (msg.includes('mcp tools not available') || msg.includes('tool execution not available') || msg.includes('not found in any connected mcp server')) {
                return `Agent tools are unavailable. Ensure MCP servers are connected and tool schemas are loaded.`;
            }

            const suffix = canUseAgent
                ? 'Please ensure the model server and MCP tools are accessible.'
                : 'Please ensure the model server is accessible.';
            return `${raw}. ${suffix}`;
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
            const files = Array.from(event.target.files || []);
            if (!files.length) return;
            this.localRagStatusText = '';
            for (const file of files) {
                const entry = {
                    id: makeId('upl'),
                    file,
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    status: 'queued',
                    error: ''
                };
                this.uploadedFiles.push(entry);
                this.uploadedFile = file;
                this.uploadedFileName = file.name;
                entry.status = 'queued';
                this.ragLog('RAG:uploadQueued', {
                    fileName: file.name,
                    fileSize: file.size,
                    fileType: file.type,
                    sessionId: this.currentSession
                });
            }
            this.localRagStatusText = 'Files queued. They will be ingested when you send.';
        },
        removeUploadedFile(fileId) {
            this.uploadedFiles = this.uploadedFiles.filter(f => f.id !== fileId);
            if (!this.uploadedFiles.length) this.clearFile();
        },
        
        clearFile() {
            this.uploadedFile = null;
            this.uploadedFileName = '';
            this.uploadedFilePreview = null;
            this.uploadedFiles = [];
            this.localRagStatusText = '';
            if (this.$refs.fileInput) {
                this.$refs.fileInput.value = '';
            }
        },
        
        async sendMessage() {
            if (!this.userInput.trim()) return;

            // Ensure a valid session exists before sending. Create one only
            // if there is no selected active session or the selected id is
            // not present in the sessions array (stale reference).
            if (!this.currentSession || !this.sessions.find(s => s.id === this.currentSession)) {
                this.newChat();
            }
            const sessionId = this.currentSession;
            if (this.getInFlightRequestCount(sessionId) > 0) {
                await this.stopCurrentSessionResponses(sessionId, 'Interrupted by a newer message.');
            }
            const ragTraceId = this.makeRagTraceId(sessionId);
            const activeModelId = this.selectedModel;
            this.setModelStatus(activeModelId, 'loading');
            const hasSessionPrivateDocs = this.getSessionDocumentRefs(sessionId).length > 0;
            const hasWorkspaceSharedDocs = this.getWorkspaceDocumentRefs(this.getCurrentWorkspaceIdForSession(sessionId)).length > 0;
            const needsLocalRagEngine = this.localRagEnabled || hasSessionPrivateDocs || hasWorkspaceSharedDocs;
            this.ragLog('RAG:sendStart', {
                ragTraceId,
                sessionId,
                localRagEnabled: this.localRagEnabled,
                queuedFiles: this.uploadedFiles.length,
                hasSessionPrivateDocs,
                hasWorkspaceSharedDocs
            });
            if (this.isSessionAtConcurrencyLimit(sessionId)) {
                console.warn('[ChatApp] Session reached max concurrent requests', {
                    sessionId,
                    limit: MAX_CONCURRENT_PER_SESSION
                });
                return;
            }

            // Sending a message should return to normal chat view.
            this.workspaceDetailsOpen = false;

            const userMessage = {
                id: makeId('msg'),
                role: 'user',
                content: this.userInput.trim()
            };
            
            const sessionMessages = this.getSessionMessages(sessionId);
            sessionMessages.push(userMessage);
            if (sessionId === this.currentSession) {
                this.messages = sessionMessages;
            }
            const query = this.userInput.trim();
            this.userInput = '';
            
            // Save user message immediately
            this.saveSessions(sessionId);
            
            // Scroll to bottom
            this.$nextTick(() => {
                this.scrollToBottom({ force: true, behavior: 'smooth' });
            });
            
            let assistantMessageId = null;
            let requestId = null;
            try {
                // Check if this is the first assistant message or if model changed
                const previousAssistantMessages = sessionMessages.filter(m => m.role === 'assistant');
                const lastAssistantModel = previousAssistantMessages.length > 0 
                    ? previousAssistantMessages[previousAssistantMessages.length - 1].model 
                    : null;
                const showModelInfo = previousAssistantMessages.length === 0 || lastAssistantModel !== activeModelId;
                
                assistantMessageId = makeId('msg');
                requestId = makeId('req');
                this.canceledRequestIds.delete(requestId);
                const requestAbortController = new AbortController();
                let assistantMessage = {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: '<div class="typing-indicator"><span></span><span></span><span></span></div>',
                    model: activeModelId,
                    providerLabel: this.availableModels.find(m => m.id === activeModelId)?.providerLabel || '',
                    showModelInfo: showModelInfo,
                    requestId,
                    reasoningMessageId: null,
                    isStreaming: true,
                    isTyping: true,
                    rawText: '',
                    finishReason: null,
                    incompleteReason: null,
                    usage: null
                };
                sessionMessages.push(assistantMessage);
                this.registerInFlightRequest(sessionId, requestId);
                this.registerRequestAbortController(requestId, requestAbortController);
                this.saveSessions(sessionId, { immediate: false });
                
                // Build conversation history excluding:
                // - the assistant placeholder being built
                // - the latest user message, which askAgent() appends explicitly
                const conversationHistory = sessionMessages.slice(0, -2).map(m => ({
                    role: m.role,
                    content: m.rawText ?? m.content
                })).filter(m => m.role !== 'reasoning');
                
                const canUseAgent = this.interactionMode === 'agent';

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
                let fileForAgent = this.uploadedFiles[0]?.file || this.uploadedFile;
                this.localRagLastModeUsed = 'none';
                const queuedEntries = [...this.uploadedFiles];
                const queuedImageEntries = queuedEntries.filter(entry => entry?.file?.type?.startsWith('image/'));
                const queuedDocumentEntries = queuedEntries.filter(entry => entry?.file && !entry.file.type.startsWith('image/'));
                const hasImageUpload = queuedImageEntries.length > 0;
                let localContext = '';
                let localRagRuntimeReady = !needsLocalRagEngine;
                const ocrContextSections = [];

                // Load Local RAG dependencies after user bubble/typing bubble are visible,
                // so UI feedback is immediate and perceived latency is reduced.
                if (needsLocalRagEngine) {
                    try {
                        await ensureRagLoaded();
                        localRagRuntimeReady = true;
                    } catch (error) {
                        console.error('[ChatApp] Failed to load RAG dependencies:', error);
                        localRagRuntimeReady = false;
                        this.localRagStatusText = 'Local RAG failed to initialize; continuing without local retrieval.';
                    }
                }
                if (this.localRagEnabled && localRagRuntimeReady) {
                    for (const entry of queuedDocumentEntries) {
                        if (entry.status !== 'queued') continue;
                        try {
                            entry.status = 'ingesting';
                            const workspaceId = this.getCurrentWorkspaceIdForSession(sessionId);
                            const selectionError = this.validateLocalRagFileSelection(entry.file, workspaceId);
                            if (selectionError) throw new Error(selectionError);
                            await this.indexUploadedDocumentForLocalRag(entry.file);
                            entry.status = 'ready';
                        } catch (error) {
                            entry.status = 'failed';
                            entry.error = error.message || 'Ingestion failed';
                        }
                    }
                }

                if (hasImageUpload) {
                    for (const imageEntry of queuedImageEntries) {
                        try {
                            imageEntry.status = 'ingesting';
                            const ocrResult = await extractImageTextWithOcr(imageEntry.file);
                            const ocrText = (ocrResult?.text || '').trim();
                            if (!ocrText) {
                                throw new Error('OCR returned empty text');
                            }
                            ocrContextSections.push(`[Image OCR: ${imageEntry.file.name}]\n${ocrText}`);
                            if (this.localRagEnabled && localRagRuntimeReady) {
                                await this.indexOcrTextForLocalRag(imageEntry.file, ocrText, sessionId);
                            }
                            imageEntry.status = 'ready';
                        } catch (ocrError) {
                            imageEntry.status = 'failed';
                            imageEntry.error = ocrError?.message || 'OCR failed';
                            this.ragLog('RAG:ocrFail', {
                                ragTraceId,
                                sessionId,
                                fileName: imageEntry?.file?.name,
                                error: imageEntry.error
                            });
                        }
                    }
                }

                const visionCapable = this.selectedModelSupportsVision(activeModelId);
                const imageFilesForVision = queuedImageEntries
                    .filter(entry => entry?.status === 'ready' && entry?.file)
                    .map(entry => entry.file);
                const isDocumentUpload = queuedDocumentEntries.length > 0;
                const shouldIndexUploadedDocumentLocally = isDocumentUpload && this.getCurrentSessionPrivateStoreEnabled(sessionId);
                if (this.localRagEnabled && isDocumentUpload) {
                    // Local RAG mode must keep document processing browser-side only.
                    fileForAgent = null;
                }
                if (visionCapable) {
                    fileForAgent = imageFilesForVision.length > 0 ? imageFilesForVision : null;
                } else {
                    fileForAgent = null;
                }
                // Recompute local document availability after deferred ingestion above.
                const hasSessionPrivateDocsNow = this.getSessionDocumentRefs(sessionId).length > 0;
                const hasWorkspaceSharedDocsNow = this.getWorkspaceDocumentRefs(this.getCurrentWorkspaceIdForSession(sessionId)).length > 0;
                this.ragLog('RAG:postIndexDocRefs', {
                    ragTraceId,
                    sessionId,
                    sessionRefCount: this.getSessionDocumentRefs(sessionId).length,
                    workspaceRefCount: this.getWorkspaceDocumentRefs(this.getCurrentWorkspaceIdForSession(sessionId)).length
                });
                const shouldUseLocalRetrieval = localRagRuntimeReady && (this.localRagEnabled || hasSessionPrivateDocsNow || hasWorkspaceSharedDocsNow || shouldIndexUploadedDocumentLocally);
                if (shouldUseLocalRetrieval) {
                    try {
                        const localResult = await this.buildLocalContextForMessage(
                            query,
                            null,
                            sessionId
                        );
                        if (localResult.ok) {
                            localContext = localResult.context;
                            this.localRagLastModeUsed = 'local';
                            this.localRagStatusText = `Using ${localResult.retrievalMode || 'hybrid-balanced'} (${localResult.usedChunks} chunks)`;
                        } else {
                            this.localRagLastModeUsed = 'local';
                            this.localRagStatusText = `Local retrieval unavailable: ${localResult.reason || 'no-relevant-chunks'}`;
                        }
                    } catch (localError) {
                        console.warn('[ChatApp] Local retrieval failed (no backend fallback for Local RAG mode):', localError);
                        this.localRagLastModeUsed = 'local';
                        this.localRagStatusText = 'Local retrieval failed in browser.';
                    }
                }

                // Ensure retrieved local context is actually passed to the model prompt.
                if (ocrContextSections.length > 0) {
                    const ocrContext = ocrContextSections.join('\n\n');
                    finalQuery = this.buildKnowledgeContextBlock(finalQuery, { localContext: ocrContext });
                }
                if (localContext && localContext.trim()) {
                    finalQuery = this.buildKnowledgeContextBlock(finalQuery, { localContext });
                    this.ragLog('RAG:contextInjected', {
                        ragTraceId,
                        sessionId,
                        usedChunks: (localContext.match(/\[Source:/g) || []).length,
                        contextChars: localContext.length
                    });
                }
                this.ragLog('RAG:agentDispatch', {
                    ragTraceId,
                    sessionId,
                    mode: canUseAgent ? 'agent' : 'ask',
                    fileForAgent: fileForAgent ? 'present' : 'null'
                });

                // Call agent integration (supports file uploads and conversation context)
                const result = await window.askAgent(
                    finalQuery,
                    toolSchemas,
                    activeModelId,
                    conversationHistory,
                    fileForAgent,
                    sessionId,
                    canUseAgent ? 'agent' : 'ask',
                    {
                        thinkingEnabled: this.thinkingEnabled === true,
                        thinkingSupported: this.selectedModelSupportsThinking(activeModelId),
                        abortSignal: requestAbortController.signal,
                        onEvent: (event) => this.handleProviderEvent(event, assistantMessageId, sessionId)
                    }
                );

                if (requestId && this.canceledRequestIds.has(requestId)) {
                    return;
                }
                this.applyFinalProviderResponse(result, assistantMessageId, sessionId);
                this.setModelStatus(activeModelId, 'ready');
                this.uploadedFiles = [];
                this.ragLog('RAG:sendDone', { ragTraceId, sessionId, ok: true });
                
                // Auto-generate session name from first message
                this.autoGenerateSessionName(sessionId);
                
                // Save the complete message
                this.saveSessions(sessionId, { immediate: false });
                
                // Final scroll to bottom
                if (sessionId === this.currentSession) {
                    this.$nextTick(() => {
                        this.scrollToBottom();
                    });
                }
                
            } catch (error) {
                const wasCanceled = requestId && this.canceledRequestIds.has(requestId);
                if (wasCanceled) {
                    const stoppedMessage = assistantMessageId
                        ? this.getMessageById(assistantMessageId, sessionId)
                        : null;
                    if (stoppedMessage && stoppedMessage.role === 'assistant') {
                        stoppedMessage.isStreaming = false;
                        stoppedMessage.isTyping = false;
                        stoppedMessage.finishReason = stoppedMessage.finishReason || 'stopped';
                    }
                    this.saveSessions(sessionId);
                    return;
                }
                console.error('Error sending message:', error);
                this.ragLog('RAG:sendDone', { ragTraceId, sessionId, ok: false, error: error?.message || String(error) });
                const canUseAgent = this.interactionMode === 'agent' && this.modelSupportsAgent(activeModelId);
                this.setModelStatus(activeModelId, 'error');
                const formattedError = this.formatProviderErrorMessage(error, {
                    modelId: activeModelId,
                    canUseAgent
                });
                // Update the existing assistant message with the error
                const targetMessage = assistantMessageId
                    ? this.getMessageById(assistantMessageId, sessionId)
                    : null;
                if (targetMessage && targetMessage.role === 'assistant') {
                    targetMessage.content = `Error: ${formattedError}`;
                    targetMessage.rawText = targetMessage.content;
                    targetMessage.isStreaming = false;
                    targetMessage.isTyping = false;
                } else {
                    // Fallback: add new error message if something went wrong
                    sessionMessages.push({
                        id: makeId('msg'),
                        role: 'assistant',
                        content: `Error: ${formattedError}`
                    });
                }
                this.saveSessions(sessionId);
            } finally {
                if (requestId) {
                    this.unregisterInFlightRequest(sessionId, requestId);
                    this.canceledRequestIds.delete(requestId);
                }
                const noMoreRequests = this.getInFlightRequestCount(sessionId) === 0;
                this.saveSessions(sessionId, { immediate: noMoreRequests ? true : false });
            }
        },

        handleProviderEvent(event, assistantMessageId, sessionId = this.currentSession) {
            const message = this.getMessageById(assistantMessageId, sessionId);
            if (!message) return;

            if (event.type === 'started') {
                return;
            }

            if (event.type === 'delta') {
                if (message.isTyping) {
                    message.content = '';
                    message.rawText = '';
                    message.isTyping = false;
                }

                message.rawText = `${message.rawText || ''}${event.delta || ''}`;
                this.scheduleStreamingMarkdownRender(assistantMessageId, sessionId);
                this.saveSessions(sessionId, { immediate: false });
                if (sessionId === this.currentSession) {
                    this.$nextTick(() => {
                        this.scrollToBottom({ behavior: 'auto' });
                    });
                }
                return;
            }

            if (event.type === 'thinking_delta') {
                const reasoningMessage = this.ensureReasoningMessageForAssistant(assistantMessageId, sessionId);
                if (!reasoningMessage) return;
                reasoningMessage.rawText = `${reasoningMessage.rawText || ''}${event.delta || ''}`;
                reasoningMessage.content = reasoningMessage.rawText;
                this.saveSessions(sessionId, { immediate: false });
                if (sessionId === this.currentSession) {
                    this.$nextTick(() => {
                        this.scrollToBottom({ behavior: 'auto' });
                    });
                }
                return;
            }

            if (event.type === 'completed' || event.type === 'incomplete') {
                message.finishReason = event.finishReason || null;
                message.incompleteReason = event.incompleteReason || null;
                message.usage = event.usage || null;
                this.saveSessions(sessionId, { immediate: false });
                return;
            }

            if (event.type === 'error') {
                message.isTyping = false;
                message.isStreaming = false;
                message.content = `Error: ${event.error}`;
                message.rawText = message.content;
                this.saveSessions(sessionId);
            }
        },

        applyFinalProviderResponse(result, assistantMessageId, sessionId = this.currentSession) {
            const message = this.getMessageById(assistantMessageId, sessionId);
            if (!message) return;
            this.cancelStreamingMarkdownRender(assistantMessageId, sessionId);

            const finalText = typeof result?.text === 'string'
                ? result.text
                : message.rawText || '';

            message.rawText = finalText;
            message.content = finalText;
            message.isStreaming = false;
            message.isTyping = false;
            message.finishReason = result?.finishReason || message.finishReason || null;
            message.incompleteReason = result?.incompleteReason || message.incompleteReason || null;
            message.usage = result?.usage || message.usage || null;

            const finalThinking = typeof result?.thinking === 'string' ? result.thinking : '';
            if (finalThinking) {
                const reasoningMessage = this.ensureReasoningMessageForAssistant(assistantMessageId, sessionId);
                if (reasoningMessage) {
                    reasoningMessage.rawText = finalThinking;
                    reasoningMessage.content = finalThinking;
                }
            }

            const messageIndex = this.findMessageIndexById(assistantMessageId, sessionId);
            if (messageIndex >= 0) {
                this.updateMessageMarkdown(messageIndex, sessionId);
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
        
        updateMessageMarkdown(messageIndex, sessionId = this.currentSession) {
            const messages = this.getSessionMessages(sessionId);
            // Parse markdown ONLY if marked.js is available and content is raw text
            if (window.marked && messages[messageIndex]) {
                try {
                    const rawContent = messages[messageIndex].content;
                    
                    // Check if content is already parsed HTML (contains real HTML block tags)
                    const htmlTagPattern = /<(p|div|h[1-6]|ul|ol|li|pre|code|blockquote|strong|em|a|table|thead|tbody|tr|td|th|br|hr)\b/i;
                    if (htmlTagPattern.test(rawContent)) {
                        console.log('[ChatApp] Content already parsed, skipping markdown');
                        return;
                    }
                    
                    console.log('[ChatApp] Parsing markdown for message:', rawContent.substring(0, 50));
                    messages[messageIndex].content = window.marked.parse(rawContent);
                    if (sessionId !== this.currentSession) {
                        return;
                    }
                    // Inject copy buttons into code blocks after DOM updates
                    this.$nextTick(() => {
                        const container = document.getElementById('messages-container');
                        if (!container) return;
                        container.querySelectorAll('.md-content pre:not([data-copy-added])').forEach(pre => {
                            pre.setAttribute('data-copy-added', '1');
                            const btn = document.createElement('button');
                            btn.className = 'md-copy-btn';
                            btn.title = 'Copy code';
                            const setCopyButtonIcon = (button, iconClass) => {
                                button.replaceChildren();
                                const icon = document.createElement('i');
                                icon.className = iconClass;
                                button.appendChild(icon);
                            };
                            setCopyButtonIcon(btn, 'fas fa-copy');
                            btn.addEventListener('click', () => {
                                const code = pre.querySelector('code');
                                navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => {
                                    setCopyButtonIcon(btn, 'fas fa-check');
                                    btn.style.background = 'var(--accent)';
                                    btn.style.color = '#fff';
                                    const timerMgr = getTimerManager('chat-app-copy-btn');
                                    timerMgr.schedule(() => {
                                        setCopyButtonIcon(btn, 'fas fa-copy');
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
        
        saveSessions(sessionId = this.currentSession, { immediate = true } = {}) {
            // Find the current session and sync messages
            const session = this.sessions.find(s => s.id === sessionId);
            if (session) {
                if (sessionId === this.currentSession && this.messages !== session.messages) {
                    session.messages = Array.isArray(this.messages) ? this.messages : [];
                }
                session.updatedAt = new Date().toISOString();
            }
            if (immediate) {
                if (this.sessionSaveTimerId) {
                    window.clearTimeout(this.sessionSaveTimerId);
                    this.sessionSaveTimerId = null;
                }
                this.pendingSessionSaveIds.clear();
                this.persistAppState();
            } else {
                this.scheduleSessionSave(sessionId);
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
