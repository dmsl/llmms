/**
 * BrowserRetriever - Client-side RAG implementation
 * Handles document ingestion, chunking, embedding, and retrieval
 */
class BrowserRetriever {
  constructor() {
    // Initialize the vector database
    this.vectorDB = new IndexedDBVectorStore("rag-vector-store", "documents");
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
        fileType.includes("text") ||
        fileType.includes("javascript") ||
        fileType.includes("json") ||
        fileType.includes("csv") ||
        fileType.includes("html") ||
        fileType === ""
      ) {
        console.log("extractTextFromFile: Detected text-based file");
        reader.onload = (e) => {
          console.log("extractTextFromFile: Text file loaded successfully");
          resolve(e.target.result);
        };
        reader.onerror = (e) => {
          console.error("extractTextFromFile: Error reading text file");
          reject(new Error("Error reading text file"));
        };
        reader.readAsText(file);
      }
      // For PDFs
      else if (fileType.includes("pdf")) {
        console.log(
          "extractTextFromFile: Detected PDF file, reading as array buffer"
        );
        reader.onload = async (e) => {
          try {
            console.log(
              "extractTextFromFile: PDF file loaded, processing PDF data..."
            );
            const pdfData = new Uint8Array(e.target.result);
            const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
            let text = "";

            console.log(
              `extractTextFromFile: PDF has ${pdf.numPages} pages. Extracting text...`
            );
            // Extract text from each page
            for (let i = 1; i <= pdf.numPages; i++) {
              console.log(`extractTextFromFile: Processing page ${i}`);
              const page = await pdf.getPage(i);
              const content = await page.getTextContent();
              const pageStrings = content.items.map((item) => item.str);
              // Log the extracted text for this page
              // console.log(`extractTextFromFile: Extracted text from page ${i}:`, pageStrings.join(' '));
              text += pageStrings.join(" ") + "\n";
            }
            console.log("extractTextFromFile: PDF text extraction complete");
            resolve(text);
          } catch (error) {
            console.error("extractTextFromFile: Error parsing PDF:", error);
            reject(new Error("Error parsing PDF: " + error.message));
          }
        };
        reader.onerror = (e) => {
          console.error("extractTextFromFile: Error reading PDF file");
          reject(new Error("Error reading PDF file"));
        };
        reader.readAsArrayBuffer(file);
      }
      // For DOCXs
      else if (
        fileType.includes("officedocument.wordprocessingml.document") ||
        fileType.includes("docx")
      ) {
        console.log(
          "extractTextFromFile: Detected DOCX file, reading as array buffer"
        );
        reader.onload = async (e) => {
          try {
            console.log(
              "extractTextFromFile: DOCX file loaded, extracting text using mammoth..."
            );
            const arrayBuffer = e.target.result;
            const result = await mammoth.extractRawText({ arrayBuffer });
            console.log("extractTextFromFile: DOCX text extraction complete");
            resolve(result.value);
          } catch (error) {
            console.error("extractTextFromFile: Error parsing DOCX:", error);
            reject(new Error("Error parsing DOCX: " + error.message));
          }
        };
        reader.onerror = (e) => {
          console.error("extractTextFromFile: Error reading DOCX file");
          reject(new Error("Error reading DOCX file"));
        };
        reader.readAsArrayBuffer(file);
      }
      // For images (would require OCR)
      else if (fileType.includes("image")) {
        console.error("extractTextFromFile: Image OCR not supported");
        reject(new Error("Image OCR not supported in browser RAG"));
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
  async ingestFile(file) {
    try {
      // Clear any existing documents first
      await this.clearAllDocuments();

      // Extract text from file
      const text = await this.extractTextFromFile(file);

      // Split text into chunks
      const chunks = this.chunkText(text);

      // Process each chunk and store in vector DB
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await this.generateEmbedding(chunk);

        // Store in vector DB
        await this.vectorDB.addDocument({
          id: `${file.name}-chunk-${i}`,
          text: chunk,
          embedding: Array.from(embedding), // Convert to regular array for storage
          metadata: {
            source: file.name,
            chunkIndex: i,
          },
        });
      }
      // ← Add this:
      await this.vectorDB.buildAnnIndex();
      return {
        success: true,
        chunkCount: chunks.length,
      };
    } catch (error) {
      console.error("Error ingesting file:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get relevant context for a query
   * @param {string} query - Query text
   * @param {number} maxResults - Maximum number of results to return
   * @returns {Promise<string>} - Relevant text context
   */
  async getContextForQuery(query, maxResults = 5) {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbedding(query);

      // Retrieve most similar documents
      const results = await this.vectorDB.findSimilar(
        Array.from(queryEmbedding),
        maxResults
      );

      // Combine results into a single context string
      let context = "";
      results.forEach((doc, index) => {
        context += `[Source: ${doc.metadata.source}, Chunk: ${
          doc.metadata.chunkIndex + 1
        }]\n${doc.text}\n\n`;
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
      await this.vectorDB.buildAnnIndex(); // now empty
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
  async retrieveRelevantDocuments(query, maxResults = 5) {
    console.log("retrieveRelevantDocuments: Received query:", query);
    try {
      // Generate an embedding for the query text.
      const queryEmbedding = await this.generateEmbedding(query);
      console.log(
        "retrieveRelevantDocuments: Generated embedding:",
        queryEmbedding.slice(0, 5),
        "..."
      );

      // Use the vector DB to find similar documents.
      const results = await this.vectorDB.findSimilar(
        Array.from(queryEmbedding),
        maxResults
      );
      console.log(
        "retrieveRelevantDocuments: Retrieved",
        results.length,
        "documents"
      );

      return results; // Returns an array of document objects.
    } catch (error) {
      console.error("Error in retrieveRelevantDocuments:", error);
      return [];
    }
  }
}
