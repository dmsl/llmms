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
            this.embeddingModel = await use.load();
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

    /**
     * Extract text from a file based on its type
     * @param {File} file - The file to extract text from
     * @returns {Promise<string>} - Extracted text
     */
    async extractTextFromFile(file) {
        console.log("extractTextFromFile: Processing file of type:", file.type);
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const fileType = file.type.toLowerCase();

            // For text-based files
            if (
                fileType.includes('text') ||
                fileType.includes('javascript') ||
                fileType.includes('json') ||
                fileType.includes('csv') ||
                fileType.includes('html') ||
                fileType === ''
            ) {
                console.log("extractTextFromFile: Detected text-based file");
                reader.onload = (e) => {
                    console.log("extractTextFromFile: Text file loaded successfully");
                    resolve(e.target.result);
                };
                reader.onerror = (e) => {
                    console.error("extractTextFromFile: Error reading text file");
                    reject(new Error('Error reading text file'));
                };
                reader.readAsText(file);
            }
            // For PDFs
            else if (fileType.includes('pdf')) {
                console.log("extractTextFromFile: Detected PDF file, reading as array buffer");
                reader.onload = async (e) => {
                    try {
                        console.log("extractTextFromFile: PDF file loaded, processing PDF data...");
                        const pdfData = new Uint8Array(e.target.result);
                        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
                        let text = '';

                        console.log(`extractTextFromFile: PDF has ${pdf.numPages} pages. Extracting text...`);
                        // Extract text from each page
                        for (let i = 1; i <= pdf.numPages; i++) {
                            console.log(`extractTextFromFile: Processing page ${i}`);
                            const page = await pdf.getPage(i);
                            const content = await page.getTextContent();
                            const pageStrings = content.items.map(item => item.str);
                            // Log the extracted text for this page
                            // console.log(`extractTextFromFile: Extracted text from page ${i}:`, pageStrings.join(' '));
                            text += pageStrings.join(' ') + '\n';
                        }
                        console.log("extractTextFromFile: PDF text extraction complete");
                        resolve(text);
                    } catch (error) {
                        console.error("extractTextFromFile: Error parsing PDF:", error);
                        reject(new Error('Error parsing PDF: ' + error.message));
                    }
                };
                reader.onerror = (e) => {
                    console.error("extractTextFromFile: Error reading PDF file");
                    reject(new Error('Error reading PDF file'));
                };
                reader.readAsArrayBuffer(file);
            }
            // For DOCXs
            else if (
                fileType.includes('officedocument.wordprocessingml.document') ||
                fileType.includes('docx')
            ) {
                console.log("extractTextFromFile: Detected DOCX file, reading as array buffer");
                reader.onload = async (e) => {
                    try {
                        console.log("extractTextFromFile: DOCX file loaded, extracting text using mammoth...");
                        const arrayBuffer = e.target.result;
                        const result = await mammoth.extractRawText({ arrayBuffer });
                        console.log("extractTextFromFile: DOCX text extraction complete");
                        resolve(result.value);
                    } catch (error) {
                        console.error("extractTextFromFile: Error parsing DOCX:", error);
                        reject(new Error('Error parsing DOCX: ' + error.message));
                    }
                };
                reader.onerror = (e) => {
                    console.error("extractTextFromFile: Error reading DOCX file");
                    reject(new Error('Error reading DOCX file'));
                };
                reader.readAsArrayBuffer(file);
            }
            // For images (would require OCR)
            else if (fileType.includes('image')) {
                console.error("extractTextFromFile: Image OCR not supported");
                reject(new Error('Image OCR not supported in browser RAG'));
            }
            // Unsupported file types
            else {
                console.error("extractTextFromFile: Unsupported file type:", fileType);
                reject(new Error(`Unsupported file type: ${fileType}`));
            }
        });
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

                    await this.vectorDB.addDocument({
                        id: `${sourceType}:${workspaceId || 'none'}:${chatId || 'none'}:${fileId}-chunk-${chunkIndex}`,
                        text: chunk,
                        embedding: Array.from(embedding),
                        metadata: {
                            source: sourceName,
                            sourceType,
                            workspaceId,
                            chatId,
                            fileId,
                            chunkIndex,
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
            const results = await this.retrieveRelevantDocuments(query, maxResults, filters);

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
            const candidateLimit = Math.max(
                maxResults,
                options.candidateLimitPerSource || limits.RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE || 20
            );
            const maxPerFile = Math.max(1, options.maxPerFile || limits.RETRIEVAL_MAX_PER_FILE || 2);

            // Generate an embedding for the query text.
            const queryEmbedding = await this.generateEmbedding(query);
            console.log("retrieveRelevantDocuments: Generated embedding:", queryEmbedding.slice(0, 5), "...");

            // Use the vector DB to find similar documents.
            const candidates = await this.vectorDB.findSimilar(Array.from(queryEmbedding), candidateLimit, filters);
            const perFileCounts = new Map();
            const selected = [];

            for (const doc of candidates) {
                const fileId = doc?.metadata?.fileId || '__unknown__';
                const used = perFileCounts.get(fileId) || 0;
                if (used >= maxPerFile) {
                    continue;
                }
                selected.push(doc);
                perFileCounts.set(fileId, used + 1);
                if (selected.length >= maxResults) {
                    break;
                }
            }

            console.log("retrieveRelevantDocuments: Retrieved", selected.length, "documents");

            return selected;
        } catch (error) {
            console.error("Error in retrieveRelevantDocuments:", error);
            return [];
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
