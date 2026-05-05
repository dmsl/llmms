/**
 * BrowserRetriever - Client-side RAG implementation
 * Handles document ingestion, chunking, embedding, and retrieval
 */
class BrowserRetriever {
    constructor() {
        // Initialize the vector database
        this.vectorDB = new IndexedDBVectorStore('rag-vector-store', 'documents');
        this.embeddingModel = null;
        this.chunkSize = 500; // Default chunk size
        this.chunkOverlap = 125; // Default overlap between chunks

        // Initialize TensorFlow model
        this.initializeEmbeddingModel();
    }

    /**
     * Initialize the TensorFlow Universal Sentence Encoder
     */

    async initializeEmbeddingModel() {
        try {
            // Load the Universal Sentence Encoder
            this.embeddingModel = await use.load(this.getUseLoadConfig());
            console.log("Embedding model loaded successfully");
        } catch (error) {
            console.error("Failed to load embedding model:", error);
            throw new Error("Failed to initialize embedding model");
        }
    }

    /**
     * Generate embeddings for text using TensorFlow USE model
     * @param {string} text - Text to generate embeddings for
     * @returns {Promise<Float32Array>} - Embedding vector
     */
    async generateEmbedding(text) {
        if (!this.embeddingModel) {
            await this.initializeEmbeddingModel();
        }
        try {
            // Generate embedding for the given text
            const embeddings = await this.embeddingModel.embed([text]);
            // Convert tensor to array; assuming a single embedding is returned
            const embeddingArray = embeddings.arraySync()[0];
            embeddings.dispose(); // Free memory
            return embeddingArray;
        } catch (error) {
            console.error("Error generating embedding:", error);
            throw error;
        }
    }

    async generateEmbeddingsBatch(texts) {
        if (!this.embeddingModel) {
            await this.initializeEmbeddingModel();
        }
        try {
            const embeddings = await this.embeddingModel.embed(texts);
            const embeddingArray = embeddings.arraySync();
            embeddings.dispose();
            return embeddingArray;
        } catch (error) {
            console.error("Error generating batch embeddings:", error);
            throw error;
        }
    }

    getRagLimits() {
        const scope = typeof globalThis !== 'undefined' ? globalThis : window;
        return scope.RAG_LIMITS || {
            MAX_CHUNKS_PER_FILE: 200,
            MAX_CHUNKS_PER_WORKSPACE: 1000,
            MAX_CHUNKS_GLOBAL: 3000,
            MAX_EXTRACTED_TEXT_BYTES_PER_FILE: 2 * 1024 * 1024,
            MAX_ESTIMATED_BYTES_PER_WORKSPACE: 10 * 1024 * 1024,
            MAX_ESTIMATED_BYTES_GLOBAL: 30 * 1024 * 1024,
            EMBEDDING_BATCH_SIZE: 8,
            MAX_BATCH_FAILURES: 2,
            MAX_BATCH_DURATION_MS: 15000,
            MAX_SLOW_BATCHES: 2,
            RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE: 20,
            RETRIEVAL_MAX_PER_FILE: 2,
            RETRIEVAL_TOP_K: 5,
            ESTIMATED_BYTES_PER_CHUNK: 4096
        };
    }

    getUseLoadConfig() {
        const scope = typeof globalThis !== 'undefined' ? globalThis : window;
        const urls = scope.RAG_ASSET_URLS || {};
        const config = {};

        if (urls.useModelUrl) {
            config.modelUrl = urls.useModelUrl;
        }

        if (urls.useVocabUrl) {
            config.vocabUrl = urls.useVocabUrl;
        }

        return config;
    }

    /**
     * Extract text from a file based on its type
     * @param {File} file - The file to extract text from
     * @returns {Promise<string>} - Extracted text
     */
    async extractTextFromFile(file) {
        console.log("extractTextFromFile: Processing file of type:", file.type);
        if (!globalThis.ChatUcyDocumentParser?.extractText) {
            throw new Error('Document extraction runtime is not loaded');
        }
        return globalThis.ChatUcyDocumentParser.extractText(file);
    }



    /**
     * Split text into chunks with overlap
     * @param {string} text - Text to chunk
     * @returns {Array<string>} - Array of text chunks
     */
    chunkText(text) {
        const chunks = [];
        const textLength = text.length;
        let startIndex = 0;

        // Simple chunking by character count
        while (startIndex < textLength) {
            const endIndex = Math.min(startIndex + this.chunkSize, textLength);
            chunks.push(text.substring(startIndex, endIndex));
            startIndex += this.chunkSize - this.chunkOverlap;
        }

        // If we have very short text, just return it as a single chunk
        if (chunks.length === 0) {
            chunks.push(text);
        }

        return chunks;
    }

    tokenize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9@\.\-\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
    }

    estimateTokenCount(text) {
        return this.tokenize(text).length;
    }

    inferSectionHint(chunkText) {
        const lines = String(chunkText || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
        const first = lines[0] || '';
        const m = first.match(/^(slide|page|section|chapter)\s*[:#]?\s*\d*/i);
        return m ? m[0] : '';
    }

    expandRetrievalQuery(query) {
        const q = String(query || '').trim();
        const low = q.toLowerCase();
        const pronounLike = /\b(this|that|it|these|those|who did this|who made this)\b/.test(low);
        if (!pronounLike) return { query: q, expanded: false, terms: [] };
        const terms = ['author', 'credits', 'presented by', 'created by', 'contact', 'email', 'university', 'team'];
        return { query: `${q} ${terms.join(' ')}`, expanded: true, terms };
    }

    lexicalScore(queryTokens, text) {
        const docTokens = this.tokenize(text);
        if (!queryTokens.length || !docTokens.length) return 0;
        const tf = new Map();
        for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
        let score = 0;
        for (const t of queryTokens) {
            const v = tf.get(t) || 0;
            if (v > 0) score += 1 + Math.log(1 + v);
        }
        return score / Math.sqrt(docTokens.length + 4);
    }

    normalizeScores(items, key, outKey) {
        const vals = items.map(x => Number(x[key]) || 0);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const span = max - min;
        for (const item of items) {
            const v = Number(item[key]) || 0;
            item[outKey] = span > 1e-9 ? (v - min) / span : 0;
        }
    }

    rerankWithDiversity(items, { maxResults, maxPerFile, diversityLambda }) {
        const selected = [];
        const perFileCounts = new Map();
        const remaining = [...items];

        const sim = (a, b) => {
            const sameFile = a?.metadata?.fileId && b?.metadata?.fileId && a.metadata.fileId === b.metadata.fileId;
            const posA = Number(a?.metadata?.docPosition || 0);
            const posB = Number(b?.metadata?.docPosition || 0);
            const posSim = sameFile ? (1 - Math.min(1, Math.abs(posA - posB) * 4)) : 0;
            return Math.max(0, posSim);
        };

        while (selected.length < maxResults && remaining.length > 0) {
            let bestIdx = -1;
            let bestScore = -Infinity;
            for (let i = 0; i < remaining.length; i += 1) {
                const cand = remaining[i];
                const fileId = cand?.metadata?.fileId || '__unknown__';
                const used = perFileCounts.get(fileId) || 0;
                if (used >= maxPerFile) continue;
                const relevance = Number(cand.hybridScore || 0);
                let penalty = 0;
                for (const s of selected) penalty = Math.max(penalty, sim(cand, s));
                const mmr = relevance - (diversityLambda * penalty);
                if (mmr > bestScore) {
                    bestScore = mmr;
                    bestIdx = i;
                }
            }
            if (bestIdx === -1) break;
            const chosen = remaining.splice(bestIdx, 1)[0];
            selected.push(chosen);
            const fileId = chosen?.metadata?.fileId || '__unknown__';
            perFileCounts.set(fileId, (perFileCounts.get(fileId) || 0) + 1);
        }
        return selected;
    }

    /**
     * Process a file and store its chunks in the vector DB
     * @param {File} file - The file to ingest
     * @returns {Promise<Object>} - Result of ingestion
     */
    async ingestFile(file, options = {}) {
        try {
            const fileId = options.fileId || `${file.name}-${file.size || 0}-${file.lastModified || 0}`;
            const sourceType = options.sourceType || 'chatAttachment';
            const workspaceId = options.workspaceId ?? null;
            const chatId = options.chatId ?? null;
            const sourceName = options.source || file.name;
            const replaceExisting = options.replaceExisting !== false;

            // Extract text from file
            const text = await this.extractTextFromFile(file);
            return this.ingestText(text, {
                fileId,
                sourceType,
                workspaceId,
                chatId,
                sourceName,
                replaceExisting
            }, options);
        } catch (error) {
            console.error("Error ingesting file:", error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async ingestText(text, descriptor = {}, options = {}) {
        try {
            const limits = options.limits || this.getRagLimits();
            const scope = typeof globalThis !== 'undefined' ? globalThis : window;
            const fileId = descriptor.fileId || `text-${Date.now()}`;
            const sourceType = descriptor.sourceType || 'chatAttachment';
            const workspaceId = descriptor.workspaceId ?? null;
            const chatId = descriptor.chatId ?? null;
            const sourceName = descriptor.sourceName || descriptor.source || 'document';
            const replaceExisting = descriptor.replaceExisting !== false;
            const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

            if (replaceExisting) {
                await this.vectorDB.deleteDocumentsByFilter({
                    fileId,
                    sourceType,
                    workspaceId,
                    chatId
                });
            }

            const extractedTextBytes = descriptor.extractedTextBytes || new TextEncoder().encode(text || '').length;
            if (extractedTextBytes > limits.MAX_EXTRACTED_TEXT_BYTES_PER_FILE) {
                return {
                    success: false,
                    error: `Extracted text exceeds limit (${limits.MAX_EXTRACTED_TEXT_BYTES_PER_FILE} bytes)`
                };
            }

            const chunks = this.chunkText(text);
            if (chunks.length > limits.MAX_CHUNKS_PER_FILE) {
                return {
                    success: false,
                    error: `Chunk limit per file exceeded (${limits.MAX_CHUNKS_PER_FILE})`
                };
            }

            const workspaceChunkCount = await this.vectorDB.countByFilter({ workspaceId });
            const globalChunkCount = await this.vectorDB.size();
            if (workspaceChunkCount + chunks.length > limits.MAX_CHUNKS_PER_WORKSPACE) {
                return {
                    success: false,
                    error: `Workspace chunk limit exceeded (${limits.MAX_CHUNKS_PER_WORKSPACE})`
                };
            }
            if (globalChunkCount + chunks.length > limits.MAX_CHUNKS_GLOBAL) {
                return {
                    success: false,
                    error: `Global chunk limit exceeded (${limits.MAX_CHUNKS_GLOBAL})`
                };
            }

            const estimatedBytesFromChunks = scope.estimateRagChunksBytes
                ? scope.estimateRagChunksBytes(chunks)
                : chunks.length * (limits.ESTIMATED_BYTES_PER_CHUNK || 4096);
            const workspaceEstimatedBytes = await this.vectorDB.sumEstimatedBytesByFilter({ workspaceId });
            const globalEstimatedBytes = await this.vectorDB.sumEstimatedBytesByFilter({});
            if (workspaceEstimatedBytes + estimatedBytesFromChunks > limits.MAX_ESTIMATED_BYTES_PER_WORKSPACE) {
                return {
                    success: false,
                    error: `Workspace byte limit exceeded (${limits.MAX_ESTIMATED_BYTES_PER_WORKSPACE} bytes)`
                };
            }
            if (globalEstimatedBytes + estimatedBytesFromChunks > limits.MAX_ESTIMATED_BYTES_GLOBAL) {
                return {
                    success: false,
                    error: `Global byte limit exceeded (${limits.MAX_ESTIMATED_BYTES_GLOBAL} bytes)`
                };
            }

            const batchSize = Math.max(1, limits.EMBEDDING_BATCH_SIZE || 8);
            const maxBatchFailures = Math.max(1, limits.MAX_BATCH_FAILURES || 2);
            const maxSlowBatches = Math.max(1, limits.MAX_SLOW_BATCHES || 2);
            const slowBatchMs = Math.max(1000, limits.MAX_BATCH_DURATION_MS || 15000);
            let failureCount = 0;
            let slowBatchCount = 0;

            for (let i = 0; i < chunks.length; i += batchSize) {
                if (shouldAbort()) {
                    return {
                        success: false,
                        error: 'Indexing canceled'
                    };
                }

                const batchChunks = chunks.slice(i, i + batchSize);
                const startedAt = performance.now();
                let batchEmbeddings = null;
                try {
                    batchEmbeddings = await this.generateEmbeddingsBatch(batchChunks);
                    failureCount = 0;
                } catch (error) {
                    failureCount += 1;
                    if (failureCount >= maxBatchFailures) {
                        return {
                            success: false,
                            error: 'Indexing stopped due to repeated embedding failures'
                        };
                    }
                    continue;
                }

                const durationMs = performance.now() - startedAt;
                if (durationMs > slowBatchMs) {
                    slowBatchCount += 1;
                    if (slowBatchCount >= maxSlowBatches) {
                        return {
                            success: false,
                            error: 'Indexing stopped due to device performance constraints'
                        };
                    }
                } else {
                    slowBatchCount = 0;
                }

                for (let j = 0; j < batchChunks.length; j++) {
                    const chunkIndex = i + j;
                    const chunk = batchChunks[j];
                    const embedding = batchEmbeddings[j] || [];
                    const estimatedBytes = scope.estimateRagChunkBytes
                        ? scope.estimateRagChunkBytes(chunk)
                        : (limits.ESTIMATED_BYTES_PER_CHUNK || 4096);
                    const chunkId = `${fileId}-chunk-${chunkIndex}`;
                    const totalChunks = chunks.length;
                    const docPosition = totalChunks > 1 ? (chunkIndex / (totalChunks - 1)) : 0;
                    const sectionHint = this.inferSectionHint(chunk);
                    const tokenCount = this.estimateTokenCount(chunk);

                    await this.vectorDB.addDocument({
                        id: `${sourceType}:${workspaceId || 'none'}:${chatId || 'none'}:${chunkId}`,
                        text: chunk,
                        embedding: Array.from(embedding),
                        metadata: {
                            chunkId,
                            source: sourceName,
                            sourceType,
                            workspaceId,
                            chatId,
                            fileId,
                            chunkText: chunk,
                            chunkIndex,
                            sectionHint,
                            docPosition,
                            tokenCount,
                            extractionHints: {
                                sourceName
                            },
                            estimatedBytes,
                            extractedTextBytes
                        }
                    });
                }

                if (onProgress) {
                    onProgress({
                        processedChunks: Math.min(chunks.length, i + batchChunks.length),
                        totalChunks: chunks.length
                    });
                }

                await new Promise(resolve => setTimeout(resolve, 0));
            }

            return {
                success: true,
                chunkCount: chunks.length,
                fileId,
                extractedTextBytes,
                estimatedBytes: estimatedBytesFromChunks
            };
        } catch (error) {
            console.error('Error ingesting text:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get relevant context for a query
     * @param {string} query - Query text
     * @param {number} maxResults - Maximum number of results to return
     * @returns {Promise<string>} - Relevant text context
     */
    async getContextForQuery(query, maxResults = 5, filters = {}) {
        try {
            const retrieval = await this.retrieveRelevantDocuments(query, maxResults, filters);
            const results = Array.isArray(retrieval) ? retrieval : (retrieval?.docs || []);

            // Combine results into a single context string
            let context = '';
            results.forEach((doc, index) => {
                context += `[Source: ${doc.metadata.source}, Chunk: ${doc.metadata.chunkIndex + 1}]\n${doc.text}\n\n`;
            });

            return context;
        } catch (error) {
            console.error("Error retrieving context:", error);
            return "";
        }
    }

    /**
     * Clear all documents from the vector DB
     */
    async clearAllDocuments() {
        try {
            await this.vectorDB.clear();
            console.log("Vector DB cleared");
            return true;
        } catch (error) {
            console.error("Error clearing documents:", error);
            return false;
        }
    }
    async hasDocuments() {
        try {
            console.log("Checking if vectorDB has documents...");
            const count = await this.vectorDB.size();
            console.log("Document count:", count);
            return count > 0;
        } catch (error) {
            console.error("Error in hasDocuments:", error);
            return false;
        }
    }
    async retrieveRelevantDocuments(query, maxResults = 5, filters = {}, options = {}) {
        console.log("retrieveRelevantDocuments: Received query:", query);
        try {
            const limits = this.getRagLimits();
            const mode = options.mode || limits.HYBRID_MODE || 'balanced';
            const semanticWeight = Number(options.semanticWeight ?? limits.HYBRID_SEMANTIC_WEIGHT ?? 0.62);
            const lexicalWeight = Number(options.lexicalWeight ?? limits.HYBRID_LEXICAL_WEIGHT ?? 0.38);
            const diversityLambda = Number(options.diversityLambda ?? limits.HYBRID_DIVERSITY_LAMBDA ?? 0.18);
            const candidateLimit = Math.max(
                maxResults,
                options.candidateLimitPerSource || limits.RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE || 20
            );
            const maxPerFile = Math.max(1, options.maxPerFile || limits.RETRIEVAL_MAX_PER_FILE || 2);
            const expanded = this.expandRetrievalQuery(query);
            const retrievalQuery = expanded.query;

            // Generate an embedding for the query text.
            const queryEmbedding = await this.generateEmbedding(retrievalQuery);
            console.log("retrieveRelevantDocuments: Generated embedding:", queryEmbedding.slice(0, 5), "...");

            // Stage A: semantic candidates.
            const semanticCandidates = await this.vectorDB.findSimilar(Array.from(queryEmbedding), candidateLimit, filters);

            // Stage A: lexical candidates.
            const allDocs = await this.vectorDB.getAllDocuments();
            const filteredDocs = allDocs.filter(doc => this.vectorDB.matchesMetadataFilters(doc, filters));
            const queryTokens = this.tokenize(retrievalQuery);
            const lexicalCandidates = filteredDocs
                .map(doc => ({ ...doc, lexical: this.lexicalScore(queryTokens, doc.text) }))
                .sort((a, b) => b.lexical - a.lexical)
                .slice(0, candidateLimit);

            // Stage B: merge + score fusion.
            const merged = new Map();
            for (const doc of semanticCandidates) {
                merged.set(doc.id, { ...doc, semantic: Number(doc.similarity || 0), lexical: 0 });
            }
            for (const doc of lexicalCandidates) {
                const prev = merged.get(doc.id);
                if (prev) {
                    prev.lexical = Math.max(Number(prev.lexical || 0), Number(doc.lexical || 0));
                } else {
                    merged.set(doc.id, { ...doc, semantic: 0, lexical: Number(doc.lexical || 0) });
                }
            }
            const candidates = [...merged.values()];
            if (candidates.length === 0) {
                return {
                    docs: [],
                    diagnostics: {
                        mode,
                        expandedQuery: expanded.expanded,
                        expansionTerms: expanded.terms,
                        candidateCounts: { semantic: 0, lexical: 0, merged: 0 }
                    }
                };
            }

            this.normalizeScores(candidates, 'semantic', 'semanticNorm');
            this.normalizeScores(candidates, 'lexical', 'lexicalNorm');
            for (const c of candidates) {
                c.hybridScore = (semanticWeight * c.semanticNorm) + (lexicalWeight * c.lexicalNorm);
                const t = String(retrievalQuery || '').toLowerCase();
                const roleIntent = /\bwho\b|\bauthor\b|\bcreated\b|\bpresented\b/.test(t);
                if (roleIntent && /\b(author|credits|presented by|created by|contact|email)\b/i.test(String(c.text || ''))) {
                    c.hybridScore += 0.12;
                }
            }
            candidates.sort((a, b) => b.hybridScore - a.hybridScore);
            const selected = this.rerankWithDiversity(candidates, {
                maxResults,
                maxPerFile,
                diversityLambda
            });

            console.log("retrieveRelevantDocuments: Retrieved", selected.length, "documents");
            return {
                docs: selected,
                diagnostics: {
                    mode: `hybrid-${mode}`,
                    expandedQuery: expanded.expanded,
                    expansionTerms: expanded.terms,
                    candidateCounts: {
                        semantic: semanticCandidates.length,
                        lexical: lexicalCandidates.length,
                        merged: candidates.length
                    },
                    weights: { semanticWeight, lexicalWeight, diversityLambda },
                    scoreSummary: {
                        topHybrid: Number(selected[0]?.hybridScore || 0),
                        bottomHybrid: Number(selected[selected.length - 1]?.hybridScore || 0)
                    },
                    diversity: {
                        uniqueFileCount: new Set(selected.map(d => d?.metadata?.fileId).filter(Boolean)).size,
                        positionCoverage: selected.map(d => Number(d?.metadata?.docPosition ?? -1))
                    }
                }
            };
        } catch (error) {
            console.error("Error in retrieveRelevantDocuments:", error);
            return { docs: [], diagnostics: { error: error.message || String(error) } };
        }
    }

    async deleteDocumentsByFilters(filters = {}) {
        try {
            return await this.vectorDB.deleteDocumentsByFilter(filters);
        } catch (error) {
            console.error("Error deleting filtered documents:", error);
            return 0;
        }
    }



}
