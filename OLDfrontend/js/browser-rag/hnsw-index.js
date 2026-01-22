// hnsw-index.js

/**
 * HNSWIndex - approximate nearest neighbor index
 */
class HNSWIndex {
  constructor(dim) {
    this.dim = dim;
    this.index = new HNSW(200, 16, 1 / Math.log(16), "cosine");
    this.isBuilt = false;
  }

  /**
   * Add a vector to the index
   * @param {string} id
   * @param {number[]} embedding
   */
  add(id, embedding) {
    this.index.addPoint({ id, vector: embedding });
  }

  /**
   * Build the index after all points are added
   */
  async build() {
    await this.index.build();
    this.isBuilt = true;
  }

  /**
   * Search nearest neighbors
   * @param {number[]} queryEmbedding
   * @param {number} k
   * @returns {Array<{id: string, similarity: number}>}
   */
  search(queryEmbedding, k) {
    if (!this.isBuilt) {
      throw new Error("HNSW index not built yet");
    }
    return this.index.searchKNN(queryEmbedding, k);
  }
}
// ✅ Make it globally accessible:
window.HNSWIndex = HNSWIndex;