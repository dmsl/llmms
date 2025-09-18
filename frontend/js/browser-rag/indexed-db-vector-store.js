/**
 * IndexedDBVectorStore - A simple vector database using IndexedDB for storage
 * Supports adding documents, searching by similarity, and clearing data
 */
class IndexedDBVectorStore {
    /**
     * Create a new vector store backed by IndexedDB
     * @param {string} dbName - Name of the IndexedDB database
     * @param {string} storeName - Name of the object store for document vectors
     */
    constructor(dbName, storeName) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;

        // Initialize the database
        this.initDB();
    }

    /**
     * Initialize the IndexedDB database
     * @returns {Promise<IDBDatabase>} - The initialized database
     */
    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = (event) => {
                console.error("Error opening IndexedDB:", event);
                reject("Error opening database");
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object store for documents if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: "id" });
                    store.createIndex("embedding", "embedding", { unique: false });
                }
            };
        });
    }

    /**
     * Ensure the database is initialized
     */
    async ensureDB() {
        if (!this.db) {
            await this.initDB();
        }
    }

    /**
     * Add a document to the vector store
     * @param {Object} document - Document to add with id, text, embedding, and metadata
     * @returns {Promise<string>} - The document ID
     */
    async addDocument(document) {
        await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");

            transaction.onerror = (event) => {
                reject("Error adding document: " + event.target.error);
            };

            const store = transaction.objectStore(this.storeName);
            const request = store.put(document);

            request.onsuccess = () => {
                resolve(document.id);
            };
        });
    }

    /**
     * Find documents similar to the given embedding vector
     * @param {Array<number>} queryEmbedding - Query embedding vector
     * @param {number} limit - Maximum number of results to return
     * @returns {Promise<Array<Object>>} - Array of similar documents
     */
    async findSimilar(queryEmbedding, limit = 5) {
        await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = (event) => {
                reject("Error finding similar documents: " + event.target.error);
            };

            request.onsuccess = (event) => {
                const documents = event.target.result;

                // Calculate cosine similarity for each document
                const results = documents.map(doc => {
                    const similarity = this.cosineSimilarity(queryEmbedding, doc.embedding);
                    return {
                        ...doc,
                        similarity
                    };
                });

                // Sort by similarity (highest first) and limit results
                results.sort((a, b) => b.similarity - a.similarity);
                resolve(results.slice(0, limit));
            };
        });
    }

    /**
     * Calculate cosine similarity between two vectors
     * @param {Array<number>} vecA - First vector
     * @param {Array<number>} vecB - Second vector
     * @returns {number} - Cosine similarity (-1 to 1)
     */
    cosineSimilarity(vecA, vecB) {
        if (vecA.length !== vecB.length) {
            throw new Error("Vectors must have the same dimensions");
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        normA = Math.sqrt(normA);
        normB = Math.sqrt(normB);

        if (normA === 0 || normB === 0) {
            return 0;
        }

        return dotProduct / (normA * normB);
    }

    /**
     * Get the number of documents in the store
     * @returns {Promise<number>} - Document count
     */
    async size() {
        await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.count();

            request.onerror = (event) => {
                reject("Error getting count: " + event.target.error);
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };
        });
    }

    /**
     * Clear all documents from the store
     * @returns {Promise<void>}
     */
    async clear() {
        await this.ensureDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();

            request.onerror = (event) => {
                reject("Error clearing store: " + event.target.error);
            };

            request.onsuccess = () => {
                resolve();
            };
        });
    }
}
