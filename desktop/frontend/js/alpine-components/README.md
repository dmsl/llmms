# Alpine.js Components

This folder contains extracted Alpine.js components and related JavaScript functionality from the HTML files.

## Files

### Configuration

**`tailwind-config.js`**
- Tailwind CSS configuration
- Used by: All HTML pages
- Purpose: Centralized styling configuration

### Alpine.js Components

**`chat-app.js`**
- Used by: `chat.html`
- Purpose: Standard chat interface with RAG support
- Features: Session management, file uploads, model selection, markdown rendering

**`llmms-chat-app.js`**
- Used by: `llmms.html`
- Purpose: LLM Meta Search chat interface
- Features: Multi-model coordination, advanced algorithm configuration

**`contact-form.js`**
- Used by: `index.html`
- Purpose: Contact form handling
- Features: Form validation, submission handling

### Utility Scripts

**`new-chat-toggle.js`**
- Purpose: LLM-MS toggle functionality
- Exports: `toggleLlmMs()`, `initializeLlmMsToggle()`
- Used by: Chat interfaces with LLM-MS functionality

**`advanced-settings.js`**
- Purpose: Advanced settings modal management
- Features: Algorithm selection, parameter tuning, model configuration
- Used by: LLM-MS chat interfaces

## Usage Pattern

1. Load Alpine.js CDN
2. Load Tailwind CSS and configuration
3. Load specific component script(s)
4. Initialize component with `x-data="componentName()"`

## Example

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <!-- Alpine.js -->
    <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
    
    <!-- Tailwind CSS -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="../js/alpine-components/tailwind-config.js"></script>
</head>
<body x-data="chatApp()">
    <!-- Your HTML here -->
    
    <!-- Component Script -->
    <script src="../js/alpine-components/chat-app.js"></script>
</body>
</html>
```

## Component Functions

### chatApp() - Standard Chat
- `init()` - Initialize component
- `newChat()` - Create new session
- `selectSession(id)` - Switch sessions
- `sendMessage()` - Send chat message
- `loadModels()` - Load available models
- `handleFileUpload(event)` - Process file uploads

### chatApp() - LLM-MS
- `init()` - Initialize component
- `newChat()` - Create new session
- `sendMessage()` - Send message with LLM-MS
- `saveSettings()` - Persist configuration
- `selectModel(model)` - Change algorithm

### contactForm()
- `submitForm()` - Handle form submission

## Global Functions

From `new-chat-toggle.js`:
- `window.toggleLlmMs(isOn)` - Toggle LLM-MS mode
- `window.initializeLlmMsToggle()` - Initialize toggle state

## Notes

- All components use Alpine.js reactive data binding
- Session storage is used for persistence
- Components are self-contained and can be used independently
- External dependencies: Alpine.js, Tailwind CSS, Marked.js (for markdown)
