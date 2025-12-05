# Browser RAG

A client-side Retrieval-Augmented Generation (RAG) system implemented in Rust and compiled to WebAssembly.

## Features

- Fully client-side document processing
- Vector similarity search
- Text chunking and embedding generation
- Persistence with IndexedDB
- WebAssembly acceleration

## Building

### Prerequisites

If you have an existing Rust installation, you'll need to remove it first:

```bash
sudo apt remove rust-all rustc cargo
sudo apt autoremove
```

1. Install the Rust toolchain:
   ```bash
   curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
   source "$HOME/.cargo/env"
   ```
2. Ensure you have Rust 1.81 or newer:
   ```bash
   rustup update stable
   ```
3. Install wasm-pack:
   ```bash
   cargo install wasm-pack --locked
   ```
4. Build the project:
   ```bash
   wasm-pack build --target web
   ```

### Troubleshooting

If you encounter issues installing Rust:

- If you see "cannot install while Rust is installed", follow the prerequisites steps above
- After installation, ensure your PATH is correctly set by running: `source "$HOME/.cargo/env"`
- Verify installation with: `rustc --version`

If you encounter issues installing wasm-pack:

- Make sure you have Rust 1.81 or newer installed (`rustc --version`)
- Try installing with the `--locked` flag
- If the installation still fails, you may need to clean cargo cache:
  ```bash
  cargo clean
  rm -rf ~/.cargo/registry/cache
  ```

## Integration with JavaScript

```javascript
// Import the generated wasm module
import init, { RagProcessor, init_panic_hook } from "./pkg/browser_rag.js";

async function initRag() {
  // Initialize the wasm module
  await init();

  // Set up panic hook for better error messages
  init_panic_hook();

  // Create a new RAG processor
  const processor = new RagProcessor(200, 50); // chunkSize, chunkOverlap

  // Initialize the database
  await processor.initialize_db();

  return processor;
}

// Example usage
async function processDocument(file) {
  const sessionId = "user-session-123";
  const processor = await initRag();

  // Read file content
  const text = await file.text();

  // Process the document
  const docId = await processor.store_document(
    file.name,
    text,
    file.type,
    file.size,
    sessionId
  );

  console.log(`Document processed with ID: ${docId}`);

  // Search for relevant chunks
  const query = "What is the main topic?";
  const results = await processor.search_relevant_chunks(query, sessionId, 3);

  console.log("Search results:", results);
}
```

## Integration with document-processor.js

To use this with the existing document-processor.js, you can replace the vector operations
and IndexedDB handling with calls to this WebAssembly module.
