/**
 * Conversation Manager - Handles chat history summarization and context management
 * 
 * Features:
 * - Automatic conversation summarization when approaching context limits
 * - Smart chunking of conversation history
 * - Efficient token counting and management
 * - Visual indicators for summarized content
 */

export class ConversationManager {
    constructor(apiBaseUrl = 'https://chatucy.cs.ucy.ac.cy/api') {
        this.apiBaseUrl = apiBaseUrl;
        this.lastSummarizedIndex = 0;
        this.hiddenSummary = null;
        this.modelContextLimits = this.loadContextLimits();
    }

    /**
     * Load model context limits from localStorage or use defaults
     */
    loadContextLimits() {
        const stored = localStorage.getItem('modelContextLimits');
        return stored ? JSON.parse(stored) : {
            'llama3.2': 8192,
            'llama3.1': 131072,
            'mistral': 8192,
            'qwen2.5': 32768,
            'deepseek-r1': 64000,
            'gemma2': 8192,
            'default': 8192
        };
    }

    /**
     * Get context limit for a specific model
     */
    getContextLimit(modelId) {
        return this.modelContextLimits[modelId] || this.modelContextLimits['default'];
    }

    /**
     * Estimate token count for messages (rough approximation)
     * More accurate than character count, faster than actual tokenization
     */
    estimateTokenCount(messages) {
        let totalTokens = 0;
        for (const message of messages) {
            // Rough estimation: ~4 characters per token
            const contentLength = typeof message.content === 'string' 
                ? message.content.length 
                : JSON.stringify(message.content).length;
            totalTokens += Math.ceil(contentLength / 4);
            // Add overhead for message structure
            totalTokens += 10;
        }
        return totalTokens;
    }

    /**
     * Check if conversation needs summarization
     */
    needsSummarization(messages, modelId) {
        const contextLimit = this.getContextLimit(modelId);
        const estimatedTokens = this.estimateTokenCount(messages);
        const threshold = contextLimit * 0.75; // Summarize at 75% capacity
        
        console.log('[ConversationManager] Token check:', {
            estimated: estimatedTokens,
            limit: contextLimit,
            threshold: threshold,
            needsSummary: estimatedTokens > threshold
        });

        return estimatedTokens > threshold;
    }

    /**
     * Summarize conversation history via API
     */
    async summarizeConversation(messages, modelId) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/manage_history`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: messages,
                    max_tokens: this.getContextLimit(modelId)
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            
            if (data.messages) {
                this.hiddenSummary = data.messages;
                console.log('[ConversationManager] Conversation summarized successfully');
                return {
                    success: true,
                    summary: data.messages,
                    originalMessageCount: messages.length
                };
            }

            return { success: false, error: 'No summary returned' };
        } catch (error) {
            console.error('[ConversationManager] Summarization failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get messages to send to the API
     * Combines hidden summary with recent messages
     */
    getMessagesForAPI(allMessages, modelId) {
        // Get messages since last summarization
        const recentMessages = allMessages.slice(this.lastSummarizedIndex);
        
        // Combine with hidden summary if it exists
        const messagesToSend = this.hiddenSummary 
            ? [this.hiddenSummary, ...recentMessages]
            : recentMessages;

        // Check if we need to summarize
        if (this.needsSummarization(messagesToSend, modelId)) {
            console.log('[ConversationManager] Context limit approaching, summarization recommended');
            return {
                messages: messagesToSend,
                needsSummarization: true
            };
        }

        return {
            messages: messagesToSend,
            needsSummarization: false
        };
    }

    /**
     * Process and manage conversation after a new message
     */
    async manageConversation(allMessages, modelId) {
        const { messages, needsSummarization } = this.getMessagesForAPI(allMessages, modelId);

        if (needsSummarization) {
            const result = await this.summarizeConversation(messages, modelId);
            
            if (result.success) {
                this.lastSummarizedIndex = allMessages.length;
                return {
                    summarized: true,
                    hiddenSummary: this.hiddenSummary,
                    lastSummarizedIndex: this.lastSummarizedIndex,
                    originalCount: result.originalMessageCount
                };
            }
        }

        return {
            summarized: false,
            hiddenSummary: this.hiddenSummary,
            lastSummarizedIndex: this.lastSummarizedIndex
        };
    }

    /**
     * Reset conversation state (for new chat)
     */
    reset() {
        this.lastSummarizedIndex = 0;
        this.hiddenSummary = null;
        console.log('[ConversationManager] State reset');
    }

    /**
     * Load state from saved session data
     */
    loadState(sessionData) {
        this.lastSummarizedIndex = sessionData.lastSummarizedIndex || 0;
        this.hiddenSummary = sessionData.hiddenSummary || null;
        console.log('[ConversationManager] State loaded:', {
            lastSummarizedIndex: this.lastSummarizedIndex,
            hasSummary: !!this.hiddenSummary
        });
    }

    /**
     * Get state to save with session
     */
    getState() {
        return {
            lastSummarizedIndex: this.lastSummarizedIndex,
            hiddenSummary: this.hiddenSummary
        };
    }

    /**
     * Create a visual indicator for summarized content
     */
    createSummaryIndicator(messageCount) {
        return `
            <div class="flex items-center gap-2 px-3 py-2 mb-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                <i class="fas fa-compress-alt"></i>
                <span class="font-medium">Previous conversation summarized</span>
                <span class="text-blue-600">(${messageCount} messages compressed)</span>
            </div>
        `;
    }
}

// Export singleton instance
export const conversationManager = new ConversationManager();
