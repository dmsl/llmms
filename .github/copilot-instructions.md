# LLM-MS (LLM Meta Search) - AI Coding Agent Instructions

## Project Overview

**LLM-MS** is a multi-model Large Language Model search engine that dynamically selects and allocates resources across multiple open-source LLMs. The system uses two novel algorithms (OUA and MAB) to balance response quality and computational cost without retraining models.

**Key Innovation**: Instead of fine-tuning a single giant model, LLM-MS dynamically combines multiple independent LLMs and allocates tokens to the best-performing ones on a per-query basis.

## Architecture & Data Flow

### Three-Layer Architecture

1. **Frontend** (`frontend/`) - Static HTML/CSS/JS served by Apache
   - **Modern Stack (Recommended)**: `html/llmms-modern.html` - Alpine.js + Tailwind CSS (~27KB total)
     - Alpine.js (15KB) for reactive state management
     - Tailwind CSS (10KB purged) for utility-first styling
     - No build step required - works via CDN
     - 95% smaller bundle size vs original
   - **Legacy Stack**: `html/llmms.html` + `js/llmms.js` - Bootstrap + jQuery (~520KB total)
   - `html/chat.html` - Standard single-model chat interface
   - Sessions stored in browser `sessionStorage` with privacy controls

2. **Backend** (`backend/app/`) - FastAPI server (port 62828)
   - `main.py` - FastAPI app initialization with CORS and router registration
   - `api/endpoints/` - Route handlers for chat, RAG, and LLM-MS algorithms
   - `metallm/` - Core algorithm implementations (OUA and MAB)
   - `utils/` - Shared utilities for embeddings, file extraction, text processing

3. **External Services** - Managed via systemd
   - **Ollama** (port 11434) - LLM inference daemon managing model execution
   - **ChromaDB** (port 8000) - Vector database for RAG and model selection catalogue

### Critical Data Flows

**LLM-MS Algorithm Flow** (multi-model selection):
```
User Query → /api/send_message_llmms → model_selector.get_suitable_models()
→ LLM_MS_OUA.stream_program_stepwise() OR LLM_MS_MAB.stream_llm_ms_mab()
→ Multiple Ollama models in parallel → Streaming JSON responses → Frontend
```

**RAG Flow** (document-augmented responses):
```
File Upload (base64) → /api/rag_chain → file_extraction.handle_text_extraction()
→ chunk_document() → ChromaDB embedding storage → retrieve_relevant_text()
→ Ollama inference with context → Streaming response
```

**Standard Chat Flow**:
```
User Message → /api/send_message → Ollama.chat() → Streaming text response
```

## Core Components Deep Dive

### Algorithm Implementations (`backend/app/metallm/`)

**LLM_MS_OUA.py** - Overperformers-Underperformers Algorithm:
- Iteratively prunes low-performing models based on cosine similarity scoring
- Uses `ALPHA` (0.7) for question similarity, `BETA` (0.3) for inter-model consensus
- Doubles token allocation each round for surviving models
- Early stopping when best model completes or margin exceeds `DYNAMIC_MARGIN_COEFF`
- **Key Function**: `stream_program_stepwise()` yields JSON chunks with status updates

**LLM_MS_MAB.py** - Multi-Armed Bandit Algorithm:
- UCB1 reinforcement learning strategy for model selection
- Exploration coefficient (`XPLORE_COEFF`) decreases as token budget is consumed
- Tracks per-model statistics: pulls, cumulative reward, average score
- **Key Function**: `stream_llm_ms_mab()` yields JSON with round updates and model states

**model_selector.py** - Intelligent Model Selection:
- Pre-computes model performance catalogue from TruthfulQA benchmark CSV files
- Stores question embeddings in ChromaDB collection `llmms_catalogue`
- `get_suitable_models()` uses semantic search to find historically best models
- Prioritizes retrieval-friendly models (llama3, qwen2) when `use_retrieval=True`

### RAG Implementation (`backend/app/api/endpoints/rag_chain.py`)

**Document Processing Pipeline**:
1. Base64 file decode → `base64_to_file()` converts to FileStorage object
2. Text extraction via `handle_text_extraction()` (supports PDF, DOCX, TXT, images with OCR)
3. Chunking with `chunk_document()` (200 words, 50-word overlap)
4. Embedding generation using `nomic-embed-text` model
5. ChromaDB storage in temporary collection per session
6. Retrieval uses `retrieve_relevant_text()` with top_k=3 semantic search
7. Context injection into LLM prompt with strict instructions to use only provided context

**Local RAG**: `/api/local_rag_chain` accepts pre-computed context from browser-side processing (e.g., PDF.js) to avoid server file uploads.

### Streaming Response Pattern

All LLM endpoints return `StreamingResponse` with chunked JSON/text:
```python
def generate_stream():
    for chunk in ollama.chat(..., stream=True):
        yield chunk  # Yielded data sent immediately to client
```

**Frontend consumes with `ReadableStream`**:

Modern (Alpine.js):
```javascript
async sendMessage() {
    const response = await fetch('/api/send_message_llmms', {...});
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const data = JSON.parse(chunk);
        
        // Alpine reactivity auto-updates UI
        this.messages[this.messages.length - 1].content = data.output;
    }
}
```

Legacy (jQuery):
```javascript
const reader = response.body.getReader();
while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    // Manual DOM manipulation
    $('#chat-history').append(chunk);
}
```

## Development Workflows

### Running the Application

**Automated Setup** (Ubuntu 22.04/24.04):
```bash
./install.sh  # Installs all dependencies, services, and models
```

**Manual Backend Start**:
```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 62828 --reload
```

**Service Management**:
```bash
sudo systemctl status ollama chromadb llmms-api apache2
sudo journalctl -u llmms-api -f  # View backend logs
```

**Testing API Endpoints**:
```bash
# Test Ollama
curl http://localhost:11434

# Test ChromaDB
curl http://localhost:8000/api/v1/heartbeat

# Test FastAPI backend
curl http://localhost:62828/get_models
```

### Debugging Strategies

**Backend Logging**: Uses Python's standard `logging` module:
```python
logger = logging.getLogger(__name__)
logger.info("Processing request")  # Logs go to stdout/systemd journal
```

**Frontend Debugging**: Open browser DevTools Console:
- Network tab shows streaming responses
- Console logs show algorithm status updates
- **Modern Frontend**: Alpine DevTools extension shows reactive state
  - Install: [Alpine.js DevTools](https://github.com/alpine-collective/alpinejs-devtools)
  - Inspect component state: `$data` in console
- **Legacy Frontend**: SessionStorage inspection: `sessionStorage.getItem('settings')`

**Common Issues**:
- Model pruning conflicts: Set changes during iteration in OUA/MAB algorithms (handled with try/except RuntimeError)
- ChromaDB connection failures: Check `CHROMA_HOST` and `CHROMA_PORT` environment variables
- Streaming incomplete: Look for `done: true` in final JSON chunks

### Testing Multi-Model Selection

**Enable Model Catalogue Initialization**:
```python
# In model_selector.py
initialize_once(reset=True)  # Rebuilds ChromaDB catalogue from CSV files
```

**CSV File Requirements** (`truthful_qa/generation/*v2.csv`):
- Columns: `question`, `reward`, `tokens_used`
- Used to pre-compute model performance rankings
- Sorted by reward/tokens_used ratio per question

## Project-Specific Conventions

### Configuration Management

**Backend Config** (`backend/app/config.py`):
- Simple constants: `MAX_CONTENT_LENGTH`, `ALLOWED_EXTENSIONS`
- Environment variables read at module level (e.g., `CHROMA_HOST`)

**Frontend Config**:
- **Modern (Alpine.js)**: Reactive state in `x-data` component, synced to `sessionStorage`
  - Single source of truth: `chatApp()` function
  - `config` object: algorithm parameters (alpha, beta, token budgets)
  - `sessions` array: chat history per session
- **Legacy** (`frontend/js/llmms.js`): Global variables with `sessionStorage` sync
  - `settings` object for UI preferences
  - `llmMsConfig` object for algorithm parameters

### API Parameter Patterns

**LLM-MS Endpoints** accept `config` dict:
```json
{
  "algorithm_type": "stepwise",  // or "mab"
  "config": {
    "MAX_TOKENS": 1024,
    "ALPHA": 0.7,
    "BETA": 0.3,
    "DYNAMIC_MARGIN_COEFF": 0.5,
    "MODELS": ["llama3.1", "mistral", "qwen2.5"],
    "EMBEDDING_MODEL": "nomic-embed-text"
  }
}
```

**Messages Format** (OpenAI-compatible):
```json
[
  {"role": "system", "content": "You are a helpful assistant"},
  {"role": "user", "content": "What is 2+2?"},
  {"role": "assistant", "content": "4"}
]
```

### Naming Conventions

- **Algorithms**: `LLM_MS_OUA` and `LLM_MS_MAB` (uppercase with underscores)
- **Endpoints**: Snake_case functions, kebab-case routes (`/send_message_llmms`)
- **Frontend**: 
  - **Modern (Alpine.js)**: camelCase for JS functions, kebab-case for HTML attributes (`x-data`, `@click`)
  - **Legacy**: camelCase JavaScript, kebab-case HTML IDs (`model-button`)
- **Collections**: ChromaDB uses descriptive names (`llmms_catalogue`, `temp_collection_{uuid}`)

### Error Handling Patterns

**Backend** - Always yield error JSON in streaming contexts:
```python
try:
    # ... processing
except Exception as e:
    yield json.dumps({"status": "error", "error": str(e), "done": True})
```

**Frontend** - Check for `status: "error"` in streamed chunks:
```javascript
const chunk = JSON.parse(line);
if (chunk.status === "error") {
    showError(chunk.error);
}
```

## Integration Points

### Ollama Integration
- Uses `ollama` Python SDK for model inference
- Streaming via `ollama.chat(..., stream=True)` or `ollama.generate(..., stream=True)`
- Embedding generation: `ollama.embed(model="nomic-embed-text", input=text)`
- No direct HTTP calls - SDK handles connection to daemon on port 11434

### ChromaDB Integration
- `chromadb.HttpClient(host="localhost", port=8000)` for persistent storage
- Collections are NOT auto-deleted except temporary RAG collections
- Embedding dimension: 768 (nomic-embed-text model)
- Uses cosine similarity for retrieval

### Apache/FastAPI Proxy Setup
- Apache serves static files from `frontend/` directory
- Proxy configuration: `/api/*` → `http://127.0.0.1:62828/*`
- WebSocket support via `proxy_wstunnel` module for streaming responses

## Critical Gotchas

1. **Model Names**: Use base names without tags in algorithm configs (`llama3.1` not `llama3.1:latest`), but full names with tags when calling Ollama directly.

2. **Streaming Completion**: Always check `done: true` in JSON responses; don't rely on connection close alone.

3. **ChromaDB Initialization**: First call to `model_selector` triggers catalogue population - expect 30-60 second delay on cold start.

4. **Token Allocation**: OUA doubles tokens each round; MAB allocates dynamically. Ensure `MAX_TOKENS` budget accounts for multiple rounds.

5. **Message History**: Always pass full message array to maintain context; system prompt must be first message with `role: "system"`.

6. **File Uploads**: RAG endpoint expects base64-encoded file data in JSON, not multipart/form-data.

## Key Files for Common Tasks

**Add new algorithm**: 
- Create `backend/app/metallm/LLM_MS_NEW.py` with `stream_*` generator function
- Register in `backend/app/api/endpoints/llmms.py` `send_message_llmms()` dispatcher

**Modify scoring weights**:
- Backend defaults in `LLM_MS_OUA.py` and `LLM_MS_MAB.py` global variables
- **Modern Frontend**: Update Alpine.js `config` object in `html/llmms-modern.html`
- **Legacy Frontend**: Update settings modal in `frontend/html/llmms.html`
- Config passed in API request overrides all defaults

**Add supported model**:
- **Modern Frontend**: Update model selector in Alpine.js template
- **Legacy Frontend**: Update `frontend/js/llmms.js` `availableModels` array
- Ensure model is pulled via `ollama pull model-name`
- Add to CSV evaluation files for catalogue inclusion

**Update UI styling**:
- **Modern Frontend**: Modify Tailwind classes inline or update `tailwind.config` in `<script>` tag
  - Color palette: `primary` shades use `#6a42c2`
  - No separate CSS file needed
- **Legacy Frontend**: Edit `frontend/css/chat.css`
  - Uses Bootstrap utilities + custom CSS

**Debug streaming issues**:
- Check browser Network tab for response stream
- Backend: `sudo journalctl -u llmms-api -f`
- **Modern Frontend**: Alpine DevTools or `console.log(this.$data)` in methods
- **Legacy Frontend**: Console logs show chunk-by-chunk status updates

---

## Frontend Migration Notes

**Modern Stack Benefits** (see `FRONTEND_MIGRATION.md`):
- 95% smaller bundle size (27KB vs 520KB)
- 60% faster initial load time
- Zero build step for development (CDN-based)
- Alpine.js provides reactive state without jQuery/Bootstrap bloat
- Tailwind CSS maintains exact color palette with utility classes
- 100% API-compatible with existing backend

**Migration Path**:
1. Test modern version: `http://localhost/html/llmms-modern.html`
2. Verify all features: streaming, file upload, settings, sessions
3. Optional production build: `npx tailwindcss build --minify`
4. Swap filenames: `mv llmms-modern.html llmms.html`

---

**When making changes**: Test locally with `uvicorn --reload`, verify streaming responses in browser, and check all three service logs (ollama, chromadb, llmms-api) for errors. For frontend changes, test both modern and legacy versions if migration is in progress.
