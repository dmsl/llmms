/**
 * MCP Tool Registry
 * 
 * Manages tool schemas from connected MCP servers and tracks which tools are enabled.
 * Web mode does not use this.
 */

const registry = {};

export function registerTools(serverUrl, tools) {
  registry[serverUrl] = {
    tools: tools.map(tool => ({
      ...tool,
      enabled: true  // Default to enabled
    }))
  };
}

export function getEnabledToolSchemas() {
  const enabledTools = [];
  
  for (const serverUrl in registry) {
    const server = registry[serverUrl];
    for (const tool of server.tools) {
      if (tool.enabled) {
        enabledTools.push(tool);
      }
    }
  }
  
  return enabledTools;
}

export function toggleTool(serverUrl, toolName) {
  if (registry[serverUrl]) {
    const tool = registry[serverUrl].tools.find(t => t.name === toolName);
    if (tool) {
      tool.enabled = !tool.enabled;
    }
  }
}

export function getRegistry() {
  return registry;
}
