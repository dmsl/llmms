import { sanitizeHTML } from '../utils/html-safe.js';

const STORAGE_KEYS = {
    sessions: 'llmms_sessions_v3',
    config: 'llmms_config_v3',
    selectedModels: 'llmms_selected_models_v3'
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
    modelsText: ''
};

const ALLOWED_API_MODELS = [
    'qwen3-vl:8b',
    'gemma3n:e2b',
    // 'granite4.1:8b',
    'lfm2.5:latest',
    'qwen3.5:2b'
];

const THINKING_API_MODELS = new Set([
    'qwen3-vl:8b',
    'lfm2.5:latest',
    'qwen3.5:2b'
]);

const ALGORITHMS = {
    stepwise: {
        id: 'stepwise',
        label: 'LLM-MS-OUA',
        shortLabel: 'OUA',
        name: 'Overperformers-Underperformers',
        description: 'Round-robin generation with score-based underperformer pruning.'
    },
    mab: {
        id: 'mab',
        label: 'LLM-MS-MAB',
        shortLabel: 'MAB',
        name: 'Multi-Armed Bandit',
        description: 'Adaptive pulls toward high-reward models under a token budget.'
    }
};

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function formatNumber(value, digits = 3) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function uniqueModels(models) {
    return [...new Set((models || []).map(model => String(model || '').trim()).filter(Boolean))];
}

function allowedModels(models) {
    const allowed = new Set(ALLOWED_API_MODELS);
    return uniqueModels(models).filter(model => allowed.has(model));
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

function renderMath(element) {
    if (!element || typeof window.renderMathInElement !== 'function') return;
    window.renderMathInElement(element, {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        strict: false
    });
}

function createModelCard(model) {
    return {
        model,
        status: 'waiting',
        statusLabel: 'Waiting',
        rawOutput: '',
        content: '',
        rawThinking: '',
        score: null,
        qSimilarity: null,
        interSimilarity: null,
        tokens: 0,
        pulls: 0,
        round: null,
        reason: '',
        done: false,
        chosen: false,
        active: true,
        pruned: false,
        error: ''
    };
}

function createRunMessage({ algorithmType, models }) {
    const modelList = uniqueModels(models);
    const modelCards = {};
    modelList.forEach(model => {
        modelCards[model] = createModelCard(model);
    });

    return {
        id: makeId('run'),
        role: 'assistant',
        type: 'llmms-run',
        algorithm: algorithmType,
        algorithmLabel: ALGORITHMS[algorithmType]?.label || 'LLM-MS',
        models: modelList,
        modelCards,
        rounds: [],
        rawEvents: [],
        currentRound: 0,
        usedTokens: 0,
        tokenBudget: 0,
        tokenAllocation: 0,
        selectedModel: '',
        finalResult: null,
        isStreaming: true,
        error: ''
    };
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
        config: { ...DEFAULT_CONFIG },
        installedModels: [],
        selectedModels: [],
        modelLoadStatus: 'idle',
        modelLoadError: '',

        init() {
            this.loadState();
            if (!this.sessions.length) this.newChat();
            this.loadInstalledModels();

            this.$watch('userInput', () => this.autoResizeTextarea());
            this.$watch('selectedModels', () => this.persistSelectedModels());

            this.$nextTick(() => {
                this.autoResizeTextarea();
                renderMath(document.getElementById('chat-history'));
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

            if (!ALGORITHMS[this.config.algorithmType]) {
                this.config.algorithmType = DEFAULT_CONFIG.algorithmType;
            }

            try {
                const savedModels = JSON.parse(localStorage.getItem(STORAGE_KEYS.selectedModels) || '[]');
                this.selectedModels = allowedModels(Array.isArray(savedModels) ? savedModels : []);
            } catch {
                this.selectedModels = [];
            }

            if (this.sessions.length > 0) {
                this.currentSession = this.sessions[0].id;
                this.messages = Array.isArray(this.sessions[0].messages) ? this.sessions[0].messages : [];
            }
        },

        async loadInstalledModels() {
            this.modelLoadStatus = 'loading';
            this.modelLoadError = '';

            try {
                const response = await fetch('/api/tags', { cache: 'no-store' });
                if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
                const payload = await response.json();
                const availableModels = Array.isArray(payload?.models)
                    ? payload.models.map(model => model?.name || model?.model || model?.id)
                    : [];
                const availableModelSet = new Set(uniqueModels(availableModels));
                const models = ALLOWED_API_MODELS.filter(model => availableModelSet.has(model));

                this.installedModels = uniqueModels(models);
                if (!this.selectedModels.length && this.installedModels.length) {
                    this.selectedModels = [...this.installedModels];
                } else if (this.selectedModels.length && this.installedModels.length) {
                    const installed = new Set(this.installedModels);
                    const stillInstalled = this.selectedModels.filter(model => installed.has(model));
                    this.selectedModels = stillInstalled.length ? stillInstalled : [...this.installedModels];
                } else if (!this.installedModels.length) {
                    this.selectedModels = [];
                }

                this.config.modelsText = this.selectedModels.join(',');

                this.modelLoadStatus = this.installedModels.length ? 'ready' : 'empty';
                this.saveSettings();
                this.persistSelectedModels();
            } catch (error) {
                this.modelLoadStatus = 'error';
                this.modelLoadError = error?.message || 'Unable to load Ollama models';
                this.installedModels = [];
                this.selectedModels = [];
                this.config.modelsText = '';
                this.persistSelectedModels();
            }
        },

        saveState() {
            this.saveSessions();
            this.saveSettings();
            this.persistSelectedModels();
        },

        saveSessions() {
            const idx = this.sessions.findIndex(session => session.id === this.currentSession);
            if (idx >= 0) {
                this.sessions[idx].messages = this.messages;
                if (!this.sessions[idx].name || this.sessions[idx].name.startsWith('Research Run ')) {
                    const firstUser = this.messages.find(message => message.role === 'user');
                    if (firstUser?.rawText) {
                        this.sessions[idx].name = firstUser.rawText.slice(0, 34) || this.sessions[idx].name;
                    }
                }
            }
            localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(this.sessions));
        },

        saveSettings() {
            localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(this.config));
        },

        persistSelectedModels() {
            this.selectedModels = allowedModels(this.selectedModels);
            localStorage.setItem(STORAGE_KEYS.selectedModels, JSON.stringify(this.selectedModels));
        },

        newChat() {
            const session = {
                id: makeId('session'),
                name: `Research Run ${this.sessions.length + 1}`,
                messages: []
            };
            this.sessions.unshift(session);
            this.currentSession = session.id;
            this.messages = [];
            this.userInput = '';
            this.saveState();
            this.$nextTick(() => this.scrollToBottom());
        },

        selectSession(sessionId) {
            const session = this.sessions.find(item => item.id === sessionId);
            if (!session) return;
            this.currentSession = session.id;
            this.messages = Array.isArray(session.messages) ? session.messages : [];
            this.sidebarOpen = false;
            this.$nextTick(() => this.scrollToBottom());
        },

        deleteSession(sessionId) {
            this.sessions = this.sessions.filter(session => session.id !== sessionId);
            if (this.currentSession === sessionId) {
                if (this.sessions.length) {
                    this.currentSession = this.sessions[0].id;
                    this.messages = Array.isArray(this.sessions[0].messages) ? this.sessions[0].messages : [];
                } else {
                    this.currentSession = null;
                    this.messages = [];
                    this.newChat();
                    return;
                }
            }
            this.saveState();
        },

        clearAllSessions() {
            if (!window.confirm('Clear all LLM-MS sessions? This cannot be undone.')) return;
            this.sessions = [];
            this.messages = [];
            this.currentSession = null;
            localStorage.removeItem(STORAGE_KEYS.sessions);
            this.newChat();
        },

        setAlgorithm(type) {
            if (!ALGORITHMS[type] || this.isLoading) return;
            this.config.algorithmType = type;
            this.saveSettings();
        },

        toggleModel(model) {
            if (this.isLoading) return;
            if (!this.installedModels.includes(model) || !ALLOWED_API_MODELS.includes(model)) return;
            if (this.selectedModels.includes(model)) {
                this.selectedModels = this.selectedModels.filter(item => item !== model);
            } else {
                this.selectedModels = [...this.selectedModels, model];
            }
            this.config.modelsText = this.selectedModels.join(',');
            this.saveSettings();
            this.persistSelectedModels();
        },

        selectAllModels() {
            this.selectedModels = [...this.installedModels];
            this.config.modelsText = this.selectedModels.join(',');
            this.saveState();
        },

        handleEnter(event) {
            if (event.shiftKey) return;
            event.preventDefault();
            this.sendMessage();
        },

        autoResizeTextarea() {
            const textarea = this.$refs?.composerInput;
            if (!textarea) return;
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
        },

        scrollToBottom() {
            const chatHistory = document.getElementById('chat-history');
            if (!chatHistory) return;
            chatHistory.scrollTop = chatHistory.scrollHeight;
        },

        getCurrentModels() {
            const installed = new Set(this.installedModels);
            return allowedModels(this.selectedModels).filter(model => installed.has(model));
        },

        getCleanMessagesForApi() {
            return this.messages
                .map(message => {
                    if (message.role === 'user') {
                        return { role: 'user', content: message.rawText || '' };
                    }

                    if (message.type === 'llmms-run' && message.finalResult?.output) {
                        return { role: 'assistant', content: message.finalResult.output };
                    }

                    return null;
                })
                .filter(Boolean);
        },

        buildConfigPayload() {
            const models = this.getCurrentModels();
            return {
                START_TOKENS: asNumber(this.config.startTokens, DEFAULT_CONFIG.startTokens),
                MAX_ROUNDS: asNumber(this.config.maxRounds, DEFAULT_CONFIG.maxRounds),
                MAX_TOKENS: asNumber(this.config.maxTokens, DEFAULT_CONFIG.maxTokens),
                ALPHA: asNumber(this.config.alpha, DEFAULT_CONFIG.alpha),
                BETA: asNumber(this.config.beta, DEFAULT_CONFIG.beta),
                DYNAMIC_MARGIN_COEFF: asNumber(this.config.dynamicMarginCoeff, DEFAULT_CONFIG.dynamicMarginCoeff),
                XPLORE_COEFF: asNumber(this.config.xploreCoeff, DEFAULT_CONFIG.xploreCoeff),
                EMBEDDING_MODEL: String(this.config.embeddingModel || DEFAULT_CONFIG.embeddingModel).trim(),
                MODELS: models
            };
        },

        async sendMessage() {
            if (!this.userInput.trim() || this.isLoading) return;

            const models = this.getCurrentModels();
            if (!models.length) {
                this.modelLoadError = 'Select at least one model before starting an LLM-MS run.';
                return;
            }

            const rawUserText = this.userInput.trim();
            const userMessage = {
                id: makeId('msg'),
                role: 'user',
                rawText: rawUserText,
                content: renderMarkdown(rawUserText, true)
            };

            this.messages.push(userMessage);
            this.userInput = '';
            this.isLoading = true;

            const runMessage = createRunMessage({
                algorithmType: this.config.algorithmType,
                models
            });
            runMessage.tokenBudget = asNumber(this.config.maxTokens, DEFAULT_CONFIG.maxTokens);
            this.messages.push(runMessage);

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

                const response = await fetch('/llmms-api/send_message_llmms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok || !response.body) {
                    throw new Error(`Request failed with status ${response.status}`);
                }

                await this.consumeRunStream(response, runMessage);
            } catch (error) {
                runMessage.error = error?.message || 'Unable to get response.';
                runMessage.isStreaming = false;
            } finally {
                runMessage.isStreaming = false;
                this.isLoading = false;
                this.saveState();
                this.$nextTick(() => this.scrollToBottom());
            }
        },

        async consumeRunStream(response, runMessage) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffered = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffered += decoder.decode(value, { stream: true });
                const parsed = extractJsonObjects(buffered);
                buffered = parsed.remainder;

                parsed.objects.forEach(objText => {
                    try {
                        const data = JSON.parse(objText);
                        this.applyRunEvent(runMessage, data);
                    } catch {
                        runMessage.rawEvents.push({ status: 'parse_error', raw: objText });
                    }
                });

                this.$nextTick(() => this.scrollToBottom());
            }

            buffered += decoder.decode();
            const parsed = extractJsonObjects(buffered);
            parsed.objects.forEach(objText => {
                try {
                    const data = JSON.parse(objText);
                    this.applyRunEvent(runMessage, data);
                } catch {
                    runMessage.rawEvents.push({ status: 'parse_error', raw: objText });
                }
            });
        },

        applyRunEvent(run, data) {
            const status = String(data?.status || '').trim();
            run.rawEvents.push(data);

            if (typeof data?.round === 'number') {
                run.currentRound = Math.max(run.currentRound || 0, data.round);
            }
            if (typeof data?.used_tokens === 'number') run.usedTokens = data.used_tokens;
            if (typeof data?.token_allocation === 'number') run.tokenAllocation = data.token_allocation;
            if (typeof data?.per_model_chunk_tokens === 'number') run.tokenAllocation = data.per_model_chunk_tokens;
            if (typeof data?.lambda_pull === 'number') run.tokenAllocation = data.lambda_pull;
            if (typeof data?.chosen_model === 'string') run.selectedModel = data.chosen_model;

            switch (status) {
                case 'initialized':
                    this.handleInitialized(run, data);
                    break;
                case 'round_start':
                    this.handleRoundStart(run, data);
                    break;
                case 'model_progress':
                    this.handleModelProgress(run, data);
                    break;
                case 'model_scored':
                    this.handleModelScored(run, data);
                    break;
                case 'model_pruned':
                    this.handleModelPruned(run, data);
                    break;
                case 'model_finished':
                    this.handleModelFinished(run, data);
                    break;
                case 'model_error':
                    this.handleModelError(run, data);
                    break;
                case 'model_embedding_failed':
                    this.handleEmbeddingFailed(run, data);
                    break;
                case 'round_summary':
                    this.handleRoundSummary(run, data);
                    break;
                case 'final_result':
                    this.handleFinalResult(run, data);
                    break;
                case 'error':
                    run.error = data.error || data.message || 'LLM-MS backend returned an error.';
                    run.isStreaming = false;
                    break;
                default:
                    if (data?.done === true && data?.error) {
                        run.error = data.error;
                        run.isStreaming = false;
                    }
            }

            this.$nextTick(() => renderMath(document.getElementById('chat-history')));
        },

        handleInitialized(run, data) {
            const models = uniqueModels(data.models || run.models);
            run.models = models;
            models.forEach(model => this.ensureCard(run, model));
            run.tokenBudget = data.max_tokens || data.total_token_budget || run.tokenBudget;
            run.algorithmLabel = ALGORITHMS[run.algorithm]?.label || run.algorithmLabel;
        },

        handleRoundStart(run, data) {
            run.rounds.push({
                round: data.round,
                chosenModel: data.chosen_model || '',
                activeModels: data.active_models || [],
                usedTokens: data.used_tokens || 0,
                gamma: data.gamma ?? null,
                ucb: data.ucb ?? null
            });

            Object.values(run.modelCards).forEach(card => {
                card.chosen = false;
                if (Array.isArray(data.active_models)) {
                    card.active = data.active_models.includes(card.model);
                }
            });

            if (data.chosen_model) {
                const card = this.ensureCard(run, data.chosen_model);
                card.chosen = true;
                card.status = 'active';
                card.statusLabel = 'Chosen';
                card.round = data.round;
            }
        },

        handleModelProgress(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = data.done ? 'done' : 'streaming';
            card.statusLabel = data.done ? 'Done' : 'Streaming';
            card.rawOutput = data.partial_output || card.rawOutput;
            card.content = renderMarkdown(card.rawOutput);
            card.rawThinking = data.partial_thinking || card.rawThinking;
            card.tokens = data.tokens ?? card.tokens;
            card.round = data.round ?? card.round;
            card.reason = data.reason || card.reason;
            card.done = !!data.done;
            card.error = '';
        },

        handleModelScored(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = card.done ? 'done' : 'scored';
            card.statusLabel = card.done ? 'Done' : 'Scored';
            card.score = data.score ?? card.score;
            card.qSimilarity = data.q_similarity ?? card.qSimilarity;
            card.interSimilarity = data.inter_similarity ?? card.interSimilarity;
            card.pulls = data.pulls ?? card.pulls;
            card.round = data.round ?? card.round;
            if (data.metrics?.tokens !== undefined) card.tokens = data.metrics.tokens;
            if (data.metrics?.done !== undefined) card.done = !!data.metrics.done;
        },

        handleModelPruned(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = 'pruned';
            card.statusLabel = 'Pruned';
            card.pruned = true;
            card.active = false;
            card.reason = data.reason || 'underperformer_pruned';
            card.round = data.round ?? card.round;
        },

        handleModelFinished(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = 'done';
            card.statusLabel = 'Finished';
            card.done = true;
            card.reason = data.reason || 'finished';
            card.tokens = data.tokens ?? card.tokens;
            card.round = data.round ?? card.round;
        },

        handleModelError(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = 'error';
            card.statusLabel = 'Error';
            card.done = true;
            card.error = data.error || 'Model error';
            card.round = data.round ?? card.round;
        },

        handleEmbeddingFailed(run, data) {
            const card = this.ensureCard(run, data.model);
            card.status = 'warning';
            card.statusLabel = 'Embedding failed';
            card.reason = data.reason || 'embedding_generation_failed';
            card.round = data.round ?? card.round;
        },

        handleRoundSummary(run, data) {
            if (Array.isArray(data.active_models)) {
                Object.values(run.modelCards).forEach(card => {
                    if (!card.done && !card.pruned && card.status !== 'error') {
                        card.active = data.active_models.includes(card.model);
                    }
                });
            }

            if (data.scores && typeof data.scores === 'object') {
                Object.entries(data.scores).forEach(([model, score]) => {
                    const card = this.ensureCard(run, model);
                    card.score = score;
                });
            }
        },

        handleFinalResult(run, data) {
            const bestModel = data.best_model || data.model || '';
            run.finalResult = {
                bestModel,
                output: data.output || data.response || '',
                content: renderMarkdown(data.output || data.response || ''),
                thinking: data.thinking || '',
                score: data.score ?? null,
                tokens: data.tokens ?? null,
                reason: data.reason || '',
                round: data.round ?? run.currentRound
            };
            run.isStreaming = false;

            if (bestModel) {
                const card = this.ensureCard(run, bestModel);
                card.status = 'winner';
                card.statusLabel = 'Selected';
                card.score = data.score ?? card.score;
                card.tokens = data.tokens ?? card.tokens;
                card.rawOutput = data.output || card.rawOutput;
                card.content = renderMarkdown(card.rawOutput);
                card.rawThinking = data.thinking || card.rawThinking;
                card.done = true;
            }
        },

        ensureCard(run, model) {
            const modelName = String(model || 'unknown').trim() || 'unknown';
            if (!run.modelCards[modelName]) {
                run.modelCards[modelName] = createModelCard(modelName);
                if (!run.models.includes(modelName)) run.models.push(modelName);
            }
            return run.modelCards[modelName];
        },

        getRunCards(run) {
            return (run.models || []).map(model => run.modelCards[model]).filter(Boolean);
        },

        getStatusClass(card) {
            const status = card?.status || 'waiting';
            if (status === 'winner') return 'llmms-card--winner';
            if (status === 'error') return 'llmms-card--error';
            if (status === 'pruned') return 'llmms-card--pruned';
            if (status === 'streaming' || status === 'active') return 'llmms-card--active';
            if (status === 'warning') return 'llmms-card--warning';
            return '';
        },

        getAlgorithmMeta(type = this.config.algorithmType) {
            return ALGORITHMS[type] || ALGORITHMS.stepwise;
        },

        modelSupportsThinking(model) {
            return THINKING_API_MODELS.has(model);
        },

        formatNumber,

        formatModelsLabel() {
            const count = this.getCurrentModels().length;
            return `${count} model${count === 1 ? '' : 's'}`;
        }
    };
}
