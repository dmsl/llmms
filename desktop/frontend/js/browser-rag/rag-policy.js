(function initRagPolicy(globalScope) {
    const RAG_LIMITS = {
        MAX_FILE_SIZE_BYTES: 15 * 1024 * 1024,
        MAX_FILES_PER_WORKSPACE: 15,
        MAX_CHUNKS_PER_FILE: 200,
        MAX_CHUNKS_PER_WORKSPACE: 1000,
        MAX_CHUNKS_GLOBAL: 3000,

        MAX_EXTRACTED_TEXT_BYTES_PER_FILE: 2 * 1024 * 1024,
        MAX_ESTIMATED_BYTES_PER_WORKSPACE: 10 * 1024 * 1024,
        MAX_ESTIMATED_BYTES_GLOBAL: 30 * 1024 * 1024,

        WARN_THRESHOLD_RATIO: 0.8,
        BLOCK_THRESHOLD_RATIO: 1.0,

        ESTIMATED_BYTES_PER_CHUNK: 4096,

        EMBEDDING_BATCH_SIZE: 8,
        RETRIEVAL_TOP_K: 5,
        RETRIEVAL_MAX_PER_FILE: 2,
        RETRIEVAL_CANDIDATE_LIMIT_PER_SOURCE: 20,

        MAX_BATCH_FAILURES: 2,
        MAX_BATCH_DURATION_MS: 15000,
        MAX_SLOW_BATCHES: 2
    };

    function estimateChunkBytes(chunkText) {
        const textBytes = new TextEncoder().encode(chunkText || '').length;
        const metadataBytes = 320;
        const embeddingBytes = 512 * 4;
        const overheadBytes = 512;
        return textBytes + metadataBytes + embeddingBytes + overheadBytes;
    }

    function estimateChunksBytes(chunks) {
        if (!Array.isArray(chunks) || chunks.length === 0) return 0;
        return chunks.reduce((sum, chunk) => sum + estimateChunkBytes(chunk), 0);
    }

    globalScope.RAG_LIMITS = RAG_LIMITS;
    globalScope.estimateRagChunkBytes = estimateChunkBytes;
    globalScope.estimateRagChunksBytes = estimateChunksBytes;
})(window);
