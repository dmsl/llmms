const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  mcpConnect: (url) => ipcRenderer.invoke('mcp:connect', url),
  mcpCall: (name, args) => ipcRenderer.invoke('mcp:call', { name, args }),
  writeFile: (path, content) => ipcRenderer.invoke('mcp:writeFile', { path, content }),
  getMCPConfig: () => ipcRenderer.invoke('mcp:getConfig'),
  openMCPConfig: () => ipcRenderer.invoke('mcp:openConfig'),
  autoConnect: () => ipcRenderer.invoke('mcp:autoConnect'),
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  getMCPServerStatus: () => ipcRenderer.invoke('mcp:getServerStatus'),
  startHealthChecks: (serverUrls) => ipcRenderer.invoke('mcp:startHealthChecks', serverUrls),
  stopHealthChecks: () => ipcRenderer.invoke('mcp:stopHealthChecks'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  toggleTool: (toolName, enabled) => ipcRenderer.invoke('mcp:toggleTool', { toolName, enabled }),
  getEnabledTools: () => ipcRenderer.invoke('mcp:getEnabledTools'),
  setEnabledTools: (toolMap) => ipcRenderer.invoke('mcp:setEnabledTools', toolMap),
  getToolsByServer: () => ipcRenderer.invoke('mcp:getToolsByServer'),
  getMCPToolSchemas: () => ipcRenderer.invoke('mcp:getMCPToolSchemas')
});

// Forward MCP tools event to window
ipcRenderer.on('mcp:tools', (event, payload) => {
  window.dispatchEvent(new CustomEvent('mcp-tools', { detail: payload }));
});

// Forward MCP tools-registered event (new tools ingested)
ipcRenderer.on('mcp:tools-registered', (event, payload) => {
  window.dispatchEvent(new CustomEvent('mcp-tools-registered', { detail: payload }));
});

// Forward update events
ipcRenderer.on('update:available', () => {
  window.dispatchEvent(new CustomEvent('update-available'));
});

ipcRenderer.on('update:downloaded', () => {
  window.dispatchEvent(new CustomEvent('update-downloaded'));
});

ipcRenderer.on('update:error', (event, error) => {
  window.dispatchEvent(new CustomEvent('update-error', { detail: error }));
});
