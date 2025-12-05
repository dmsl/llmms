// ui-components.js
// Reusable UI components for chat interface

export const UIComponents = {
  // System Prompt & Personality Panel
  createSystemPromptPanel: (systemPrompt, personality, personalities) => {
    return {
      id: 'system-prompt-panel',
      template: `
        <div class="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-center justify-center" @click="showSystemPromptPanel = false">
          <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" @click.stop>
            <h3 class="text-lg font-semibold mb-4">System Prompt & Personality</h3>
            
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">System Prompt</label>
                <textarea 
                  x-model="systemPrompt"
                  class="w-full h-32 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary outline-none text-sm"
                  placeholder="Enter custom system prompt..."></textarea>
              </div>
              
              <div>
                <label class="block text-sm font-medium mb-2">Personality</label>
                <select x-model="currentPersonality" class="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary outline-none">
                  <option value="default">Default</option>
                  <option value="expert">Expert</option>
                  <option value="creative">Creative</option>
                  <option value="concise">Concise</option>
                </select>
              </div>
              
              <div class="flex gap-3">
                <button @click="showSystemPromptPanel = false" class="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">Cancel</button>
                <button @click="saveSystemPromptSettings(); showSystemPromptPanel = false" class="flex-1 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors">Save</button>
              </div>
            </div>
          </div>
        </div>
      `
    };
  },

  // Token Usage Display
  createTokenDisplay: (tokenUsage) => {
    if (!tokenUsage || !tokenUsage.total) return '';
    return `<span class="text-xs text-gray-500 ml-2">📊 ${tokenUsage.prompt}⬇ ${tokenUsage.completion}⬆ (${tokenUsage.total}⟡)</span>`;
  },

  // Tool Debug Viewer
  createToolDebugViewer: (toolCall, result, executionTime) => {
    return {
      id: `tool-debug-${toolCall.id}`,
      template: `
        <div class="bg-gray-50 rounded-lg p-3 mt-2 border border-gray-200" x-data="{ expanded: false }">
          <button @click="expanded = !expanded" class="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-primary transition-colors">
            <i :class="expanded ? 'fas fa-chevron-down' : 'fas fa-chevron-right'"></i>
            <span>🔧 Tool: ${toolCall.name}</span>
          </button>
          
          <div x-show="expanded" class="mt-3 space-y-2 text-xs">
            <div>
              <strong>Arguments:</strong>
              <pre class="bg-white p-2 rounded border border-gray-200 overflow-x-auto">${JSON.stringify(toolCall.args, null, 2)}</pre>
            </div>
            <div>
              <strong>Result:</strong>
              <pre class="bg-white p-2 rounded border border-gray-200 overflow-x-auto">${JSON.stringify(result, null, 2)}</pre>
            </div>
            <div class="text-gray-500">⏱ ${executionTime}ms</div>
          </div>
        </div>
      `
    };
  },

  // MCP Server Status Indicator
  createMCPStatusIndicator: (serverUrl, status) => {
    const statusColor = status === 'online' ? 'bg-green-500' : 'bg-red-500';
    const statusText = status === 'online' ? 'Online' : 'Offline';
    return `
      <div class="flex items-center gap-2 text-xs">
        <div class="w-2 h-2 ${statusColor} rounded-full animate-pulse"></div>
        <span class="text-gray-600">${statusText}</span>
      </div>
    `;
  },

  // Tool Enable/Disable Toggle
  createToolToggle: (toolName, enabled) => {
    return {
      id: `tool-toggle-${toolName}`,
      template: `
        <div class="flex items-center gap-2 p-2 hover:bg-gray-50 rounded">
          <input 
            type="checkbox" 
            ${enabled ? 'checked' : ''} 
            @change="toggleMCPTool('${toolName}', $event.target.checked)"
            class="w-4 h-4 rounded border-gray-300 text-primary focus:ring-2 focus:ring-primary cursor-pointer">
          <span class="text-sm text-gray-700">${toolName}</span>
        </div>
      `
    };
  },

  // Tool Execution Activity Indicator
  createToolActivityIndicator: (toolName) => {
    return `
      <div class="flex items-center gap-2 bg-blue-50 p-3 rounded-lg border-l-4 border-blue-500 mb-3">
        <div class="inline-block">
          <div class="flex gap-1">
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
          </div>
        </div>
        <span class="text-sm text-blue-700">Running tool: ${toolName}…</span>
      </div>
    `;
  },

  // Retry Button
  createRetryButton: (messageId) => {
    return `
      <button 
        @click="retryMessage('${messageId}')"
        class="text-xs px-3 py-1 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-full transition-colors flex items-center gap-1">
        <i class="fas fa-redo"></i> Retry
      </button>
    `;
  },

  // Error Debug Panel
  createErrorDebugPanel: (error, response) => {
    return {
      id: 'error-debug-panel',
      template: `
        <div class="bg-red-50 border-l-4 border-red-500 p-3 rounded-r-lg mt-2" x-data="{ showDetails: false }">
          <button @click="showDetails = !showDetails" class="flex items-center gap-2 text-sm text-red-700 font-medium hover:text-red-800">
            <i :class="showDetails ? 'fas fa-chevron-down' : 'fas fa-chevron-right'"></i>
            <span>🐛 Debug Information</span>
          </button>
          
          <div x-show="showDetails" class="mt-3 space-y-2 text-xs">
            <div>
              <strong>Error:</strong>
              <pre class="bg-white p-2 rounded border border-red-200 overflow-x-auto text-red-700">${error}</pre>
            </div>
            <div x-show="response">
              <strong>HTTP Response:</strong>
              <pre class="bg-white p-2 rounded border border-red-200 overflow-x-auto">${JSON.stringify(response, null, 2)}</pre>
            </div>
          </div>
        </div>
      `
    };
  },

  // Model Metadata Panel
  createModelMetadataPanel: (modelId, metadata) => {
    return {
      id: 'model-metadata-panel',
      template: `
        <div class="bg-gray-50 rounded-lg p-3 border border-gray-200" x-data="{ showDetails: false }">
          <button @click="showDetails = !showDetails" class="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-primary transition-colors">
            <i :class="showDetails ? 'fas fa-chevron-down' : 'fas fa-chevron-right'"></i>
            <span>📋 Model Details</span>
          </button>
          
          <div x-show="showDetails" class="mt-3 space-y-2">
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div><strong>Model:</strong> ${modelId}</div>
              <div><strong>Version:</strong> ${metadata.version || 'N/A'}</div>
              <div><strong>Context:</strong> ${metadata.context_length ? metadata.context_length.toLocaleString() + ' tokens' : 'N/A'}</div>
              <div><strong>Temperature:</strong> 
                <input 
                  type="range" 
                  min="0" 
                  max="2" 
                  step="0.1" 
                  :value="metadata.temperature || 0.7"
                  @change="updateModelTemperature('${modelId}', $event.target.value)"
                  class="w-full">
              </div>
            </div>
          </div>
        </div>
      `
    };
  },

  // Streaming UI Effects
  createStreamingShimmer: () => {
    return `
      <style>
        @keyframes shimmer {
          0% { background-position: -1000px 0; }
          100% { background-position: 1000px 0; }
        }
        .shimmer-loading {
          background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
          background-size: 1000px 100%;
          animation: shimmer 2s infinite;
          border-radius: 4px;
          height: 20px;
          margin: 4px 0;
        }
      </style>
      <div class="space-y-2">
        <div class="shimmer-loading" style="width: 80%"></div>
        <div class="shimmer-loading" style="width: 60%"></div>
        <div class="shimmer-loading" style="width: 90%"></div>
      </div>
    `;
  },

  // Update Notification Modal
  createUpdateNotificationModal: (updateInfo) => {
    return {
      id: 'update-notification',
      template: `
        <div class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
          <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <h3 class="text-lg font-semibold mb-2">✨ Update Available</h3>
            <p class="text-gray-600 mb-4">A new version of ChatUCY Desktop is available. Download and install it now?</p>
            
            <div class="flex gap-3">
              <button @click="closeUpdateModal()" class="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">Later</button>
              <button @click="installUpdate()" class="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors">Update Now</button>
            </div>
          </div>
        </div>
      `
    };
  },

  // File Write Permission Modal
  createFileWriteConfirmation: (filePath, fileSize) => {
    const warning = fileSize > 1048576 ? '⚠️ File is larger than 1MB' : '';
    return {
      id: 'file-write-modal',
      template: `
        <div class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
          <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
            <h3 class="text-lg font-semibold mb-4">Confirm File Write</h3>
            
            <div class="bg-gray-50 p-3 rounded-lg mb-4 text-sm">
              <div><strong>File:</strong> ${filePath}</div>
              <div><strong>Size:</strong> ${(fileSize / 1024).toFixed(2)} KB</div>
              ${warning ? `<div class="text-orange-600 mt-2">${warning}</div>` : ''}
            </div>
            
            <div class="flex gap-3">
              <button @click="denyFileWrite()" class="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">Cancel</button>
              <button @click="allowFileWrite()" class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors">Allow Write</button>
            </div>
          </div>
        </div>
      `
    };
  }
};

export default UIComponents;
