import { sanitizeHTML } from '../utils/html-safe.js';

const STORAGE_KEYS = {
    sessions: 'llmms_sessions_v2',
    config: 'llmms_config_v2',
    selectedModel: 'llmms_selected_model_v2'
};

const DEFAULT_CONFIG = {
    algorithmType: 'stepwise',
    startTokens: 256,
    maxRounds: 10,
    maxTokens: 1024,
    alpha: 0.7,
    beta: 0.3,
    dynamicMarginCoeff: 0.5,
    xploreCoeff: 0.3,
    embeddingModel: 'nomic-embed-text',
    modelsText: 'llama3.1,mistral,qwen2.5'
};

const MODEL_TO_ALGO = {
    'LLM-MS-OUA': 'stepwise',
    'LLM-MS-MAB': 'mab'
};

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseModels(modelsText) {
    return String(modelsText || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function extractJsonObjects(buffer) {
    const objects = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let start = -1;

    for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (ch === '\\') {
            escape = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                objects.push(buffer.slice(start, i + 1));
                start = -1;
            }
        }
    }

    const remainder = depth > 0 && start !== -1 ? buffer.slice(start) : '';
    return { objects, remainder };
}

function renderMarkdown(text, isUser = false) {
    const raw = String(text || '');
    if (!window.marked) {
        return sanitizeHTML(raw).replace(/\n/g, '<br>');
    }

    try {
        const parsed = window.marked.parse(raw);
        const safe = sanitizeHTML(parsed);
        return `<div class="md-content ${isUser ? 'md-content--user' : ''}">${safe}</div>`;
    } catch {
        return sanitizeHTML(raw).replace(/\n/g, '<br>');
    }
}

export default function chatApp() {
    return {
        sidebarOpen: false,
        settingsOpen: false,
        userInput: '',
        messages: [],
        sessions: [],
        currentSession: null,
        isLoading: false,
        selectedModel: 'LLM-MS-OUA',
        config: { ...DEFAULT_CONFIG },
        selectedFile: null,

        init() {
            this.loadState();
            if (!this.sessions.length) this.newChat();

            this.$watch('userInput', () => {
                this.autoResizeTextarea();
            });

            this.$nextTick(() => {
                this.autoResizeTextarea();
                this.scrollToBottom();
            });
        },

        loadState() {
            try {
                const savedSessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.sessions) || '[]');
                this.sessions = Array.isArray(savedSessions) ? savedSessions : [];
            } catch {
                this.sessions = [];
            }

            try {
                const savedConfig = JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || '{}');
                this.config = { ...DEFAULT_CONFIG, ...savedConfig };
            } catch {
                this.config = { ...DEFAULT_CONFIG };
            }

            const savedModel = localStorage.getItem(STORAGE_KEYS.selectedModel);
            if (savedModel && MODEL_TO_ALGO[savedModel]) {
                this.selectedModel = savedModel;
                this.config.algorithmType = MODEL_TO_ALGO[savedModel];
            } else {
                this.syncModelFromAlgorithm();
            }

            if (this.sessions.length > 0) {
                this.currentSession = this.sessions[0].id;
                this.messages = Array.isArray(this.sessions[0].messages) ? this.sessions[0].messages : [];
            }
        },

        saveState() {
            this.saveSessions();
            this.saveSettings();
            localStorage.setItem(STORAGE_KEYS.selectedModel, this.selectedModel);
        },

        saveSessions() {
            const idx = this.sessions.findIndex(s => s.id === this.currentSession);
            if (idx >= 0) {
                this.sessions[idx].messages = this.messages;
                if (!this.sessions[idx].name || this.sessions[idx].name.startsWith('Chat ')) {
                    const firstUser = this.messages.find(m => m.role === 'user');
                    if (firstUser?.rawText) {
                        this.sessions[idx].name = firstUser.rawText.slice(0, 28) || this.sessions[idx].name;
                    }
                }
            }
            localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(this.sessions));
        },

        saveSettings() {
            localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(this.config));
            this.syncModelFromAlgorithm();
            localStorage.setItem(STORAGE_KEYS.selectedModel, this.selectedModel);
        },

        syncModelFromAlgorithm() {
            this.selectedModel = this.config.algorithmType === 'mab' ? 'LLM-MS-MAB' : 'LLM-MS-OUA';
        },

        newChat() {
            const chatNumber = this.sessions.length + 1;
            const session = {
                id: makeId('session'),
                name: `Chat ${chatNumber}`,
                messages: []
            };
            this.sessions.unshift(session);
            this.currentSession = session.id;
            this.messages = [];
            this.selectedFile = null;
            this.userInput = '';
            this.saveState();
            this.$nextTick(() => this.scrollToBottom());
        },

        selectSession(sessionId) {
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            this.currentSession = session.id;
            this.messages = Array.isArray(session.messages) ? session.messages : [];
            this.sidebarOpen = false;
            this.$nextTick(() => this.scrollToBottom());
        },

        clearAllSessions() {
            if (!window.confirm('Clear all sessions? This cannot be undone.')) return;
            this.sessions = [];
            this.messages = [];
            this.currentSession = null;
            localStorage.removeItem(STORAGE_KEYS.sessions);
            this.newChat();
        },

        selectModel(model) {
            this.selectedModel = model;
            this.config.algorithmType = MODEL_TO_ALGO[model] || 'stepwise';
            localStorage.setItem(STORAGE_KEYS.selectedModel, this.selectedModel);
            this.saveSettings();
        },

        handleEnter(event) {
            if (event.shiftKey) return;
            event.preventDefault();
            this.sendMessage();
        },

        autoResizeTextarea() {
            const textarea = this.$el.querySelector('textarea');
            if (!textarea) return;
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
        },

        scrollToBottom() {
            const chatHistory = document.getElementById('chat-history');
            if (!chatHistory) return;
            chatHistory.scrollTop = chatHistory.scrollHeight;
        },

        getCleanMessagesForApi() {
            return this.messages.map(message => ({
                role: message.role,
                content: message.rawText || String(message.content || '').replace(/<[^>]+>/g, '')
            }));
        },

        buildConfigPayload() {
            return {
                START_TOKENS: asNumber(this.config.startTokens, DEFAULT_CONFIG.startTokens),
                MAX_ROUNDS: asNumber(this.config.maxRounds, DEFAULT_CONFIG.maxRounds),
                MAX_TOKENS: asNumber(this.config.maxTokens, DEFAULT_CONFIG.maxTokens),
                ALPHA: asNumber(this.config.alpha, DEFAULT_CONFIG.alpha),
                BETA: asNumber(this.config.beta, DEFAULT_CONFIG.beta),
                DYNAMIC_MARGIN_COEFF: asNumber(this.config.dynamicMarginCoeff, DEFAULT_CONFIG.dynamicMarginCoeff),
                XPLORE_COEFF: asNumber(this.config.xploreCoeff, DEFAULT_CONFIG.xploreCoeff),
                EMBEDDING_MODEL: String(this.config.embeddingModel || DEFAULT_CONFIG.embeddingModel).trim(),
                MODELS: parseModels(this.config.modelsText)
            };
        },

        async readSelectedFileAsContext() {
            if (!this.selectedFile) return '';

            const file = this.selectedFile;
            const header = `\n\nAttached file: ${file.name} (${file.type || 'unknown'})`;
            if (!file.type.startsWith('text/') && !file.name.toLowerCase().endsWith('.txt') && !file.name.toLowerCase().endsWith('.md')) {
                return `${header}\nBinary file attached. Please reference it by filename in your answer.`;
            }

            try {
                const text = await file.text();
                const clipped = text.length > 20000 ? `${text.slice(0, 20000)}\n...[truncated]` : text;
                return `${header}\n\nFile content:\n${clipped}`;
            } catch {
                return `${header}\nFile content could not be read in browser.`;
            }
        },

        async sendMessage() {
            if (!this.userInput.trim() || this.isLoading) return;

            const typedText = this.userInput.trim();
            const fileContext = await this.readSelectedFileAsContext();
            const rawUserText = `${typedText}${fileContext}`;

            const userMessage = {
                id: makeId('msg'),
                role: 'user',
                rawText: rawUserText,
                content: renderMarkdown(rawUserText, true)
            };

            this.messages.push(userMessage);
            this.userInput = '';
            this.isLoading = true;

            const assistantMessage = {
                id: makeId('msg'),
                role: 'assistant',
                rawText: '',
                content: '',
                model: this.selectedModel
            };
            this.messages.push(assistantMessage);
            this.$nextTick(() => {
                this.autoResizeTextarea();
                this.scrollToBottom();
            });

            try {
                const payload = {
                    messages: this.getCleanMessagesForApi(),
                    algorithm_type: this.config.algorithmType,
                    config: this.buildConfigPayload()
                };

                const response = await fetch('/api/send_message_llmms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok || !response.body) {
                    throw new Error(`Request failed with status ${response.status}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffered = '';
                let hasFinalOutput = false;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffered += decoder.decode(value, { stream: true });
                    const parsed = extractJsonObjects(buffered);
                    buffered = parsed.remainder;

                    for (const objText of parsed.objects) {
                        let data;
                        try {
                            data = JSON.parse(objText);
                        } catch {
                            continue;
                        }

                        if (data.model) assistantMessage.model = data.model;

                        if (typeof data.output === 'string') {
                            assistantMessage.rawText = data.output;
                            hasFinalOutput = true;
                        } else if (typeof data.response === 'string') {
                            assistantMessage.rawText = data.response;
                            hasFinalOutput = true;
                        } else if (typeof data.partial_output === 'string') {
                            assistantMessage.rawText = data.partial_output;
                        } else if (typeof data.message === 'string' && data.status === 'error') {
                            assistantMessage.rawText = `Error: ${data.message}`;
                            hasFinalOutput = true;
                        }

                        assistantMessage.content = renderMarkdown(assistantMessage.rawText);

                        if (data.done === true && data.status === 'error' && !assistantMessage.rawText) {
                            assistantMessage.rawText = `Error: ${data.error || 'Unknown server error'}`;
                            assistantMessage.content = renderMarkdown(assistantMessage.rawText);
                            hasFinalOutput = true;
                        }
                    }

                    this.$nextTick(() => this.scrollToBottom());
                }

                if (!hasFinalOutput && !assistantMessage.rawText.trim()) {
                    assistantMessage.rawText = 'No response content was returned by the LLM-MS backend.';
                    assistantMessage.content = renderMarkdown(assistantMessage.rawText);
                }
            } catch (error) {
                assistantMessage.rawText = `Error: Unable to get response. ${error.message || ''}`.trim();
                assistantMessage.content = renderMarkdown(assistantMessage.rawText);
            } finally {
                this.isLoading = false;
                this.selectedFile = null;
                if (this.$refs.fileInput) this.$refs.fileInput.value = '';
                this.saveState();
                this.$nextTick(() => this.scrollToBottom());
            }
        },

        handleFileUpload(event) {
            const file = event?.target?.files?.[0] || null;
            this.selectedFile = file;
        },

        removeSelectedFile() {
            this.selectedFile = null;
            if (this.$refs.fileInput) this.$refs.fileInput.value = '';
        }
    };
}
