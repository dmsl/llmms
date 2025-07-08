/**
 * IndexedDBVectorStore - A simple vector database using IndexedDB for storage
 * Supports adding documents, searching by similarity, and clearing data
 */


class HNSWIndex {
  constructor(dim) {
    this.dim = dim;
    this.vectors = []; // store {id, vector}
    this.isBuilt = false;
  }

  add(id, embedding) {
    if (embedding.length !== this.dim) {
      throw new Error(`Embedding dimension mismatch (expected ${this.dim})`);
    }
    this.vectors.push({ id, vector: embedding });
  }

  async build() {
    // A real HNSW would build a graph here. We'll just mark it as built.
    this.isBuilt = true;
  }

  search(queryEmbedding, k) {
    if (!this.isBuilt) {
      throw new Error("HNSW index not built yet");
    }

    const similarities = this.vectors.map((item) => {
      const sim = cosineSimilarity(item.vector, queryEmbedding);
      return { id: item.id, similarity: sim };
    });

    // Sort descending by similarity
    similarities.sort((a, b) => b.similarity - a.similarity);

    return similarities.slice(0, k);
  }
}

// Helper: cosine similarity
function cosineSimilarity(vec1, vec2) {
  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

class IndexedDBVectorStore {
  /**
   * Create a new vector store backed by IndexedDB
   * @param {string} dbName - Name of the IndexedDB database
   * @param {string} storeName - Name of the object store for document vectors
   * @param {number} vectorDim - Dimensionality of your embeddings
   */
  constructor(dbName, storeName, vectorDim) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
    this.vectorDim = vectorDim;
    this.annIndex = new HNSWIndex(vectorDim);

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
   * @param {Object} document - Document with id, text, embedding, and metadata
   * @returns {Promise<string>} - The document ID
   */
  async addDocument(document) {
    await this.ensureDB();

    // Normalize the vector for cosine similarity
    document.embedding = this.normalizeVector(document.embedding);

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");

      transaction.onerror = (event) => {
        reject("Error adding document: " + event.target.error);
      };

      const store = transaction.objectStore(this.storeName);
      const request = store.put(document);

      request.onsuccess = () => {
        // Also add to HNSW index
        this.annIndex.add(document.id, document.embedding);
        resolve(document.id);
      };
    });
  }

  /**
   * After adding documents, you must build the ANN index.
   * @returns {Promise<void>}
   */
  async buildAnnIndex() {
    await this.annIndex.build();
  }

  /**
   * Find documents similar to the given embedding vector
   * @param {Array<number>} queryEmbedding - Query embedding vector
   * @param {number} limit - Maximum number of results to return
   * @returns {Promise<Array<Object>>} - Array of similar documents
   */
  async findSimilar(queryEmbedding, limit = 5) {
    await this.ensureDB();

    // normalize query embedding
    const normalizedQuery = this.normalizeVector(queryEmbedding);

    // Search the ANN index for top N neighbors
    const neighbors = this.annIndex.search(normalizedQuery, limit);

    const results = [];

    for (const neighbor of neighbors) {
      const doc = await this.getDocumentById(neighbor.id);
      if (doc) {
        doc.similarity = neighbor.similarity;
        results.push(doc);
      }
    }

    // sort descending by similarity
    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  }

  /**
   * Retrieve a document from the store by ID
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getDocumentById(id) {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(id);

      request.onsuccess = (event) => {
        resolve(event.target.result || null);
      };

      request.onerror = (event) => {
        reject("Error retrieving document: " + event.target.error);
      };
    });
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array<number>} vecA
   * @param {Array<number>} vecB
   * @returns {number}
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
   * Normalize a vector to unit length
   * @param {Array<number>} vec
   * @returns {Array<number>}
   */
  normalizeVector(vec) {
    let norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vec : vec.map((v) => v / norm);
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
        // Also reset ANN index
        this.annIndex = new HNSWIndex(this.vectorDim);
        resolve();
      };
    });
  }
}

