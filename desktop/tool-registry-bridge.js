/**
 * tool-registry-bridge.js
 * 
 * Bridges MCP-provided tools into the unified tool registry
 * Used by main.js to register MCP tools when the server connects
 * Supports enable/disable toggles for individual tools
 * Organizes tools by server for better grouping in UI
 */

let registeredMCPTools = {}; // Flat registry for tool lookup
let toolsByServer = {};      // Server-grouped registry for UI display
let enabledTools = {};

/**
 * Register MCP tools into local registry with server metadata
 * @param {Array} formattedTools - Array of { name, description, schema, execute, serverName, serverType }
 * @param {String} serverName - Name of the server providing these tools
 * @param {String} serverType - Type of server (local, remote, etc.)
 */
function registerMCPTools(formattedTools, serverName = 'Unknown', serverType = 'unknown') {
  // Build flat registry for tool lookup
  formattedTools.forEach(tool => {
    const toolKey = tool.name;
    registeredMCPTools[toolKey] = {
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      execute: tool.execute,
      enabled: enabledTools[toolKey] !== false,
      serverName: serverName,
      serverType: serverType
    };
  });
  
  // Build grouped registry for UI display
  if (!toolsByServer[serverName]) {
    toolsByServer[serverName] = {
      name: serverName,
      type: serverType,
      tools: []
    };
  }
  
  toolsByServer[serverName].tools = formattedTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    execute: tool.execute,
    enabled: enabledTools[tool.name] !== false,
    serverName: serverName,
    serverType: serverType
  }));
  
  console.log(`[ToolRegistryBridge] Registered ${formattedTools.length} MCP tools from ${serverName}`);
}

/**
 * Get all registered MCP tools
 */
function getMCPTools() {
  return registeredMCPTools;
}

/**
 * Get tools organized by server for UI display (serializable version)
 * Removes execute functions which can't be serialized across IPC
 */
function getToolsByServer() {
  const serializableToolsByServer = {};
  
  for (const serverName in toolsByServer) {
    const server = toolsByServer[serverName];
    serializableToolsByServer[serverName] = {
      name: server.name,
      type: server.type,
      tools: server.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        enabled: tool.enabled,
        serverName: tool.serverName,
        serverType: tool.serverType
        // Note: execute function intentionally omitted as it's not serializable
      }))
    };
  }
  
  return serializableToolsByServer;
}

/**
 * Get only enabled MCP tools (for tool calling)
 */
function getEnabledMCPTools() {
  const enabled = {};
  Object.entries(registeredMCPTools).forEach(([name, tool]) => {
    if (tool.enabled !== false) {
      enabled[name] = tool;
    }
  });
  return enabled;
}

/**
 * Toggle tool enabled/disabled state
 */
function toggleTool(name, enabled) {
  if (registeredMCPTools[name]) {
    registeredMCPTools[name].enabled = enabled;
    enabledTools[name] = enabled;
    console.log(`[ToolRegistryBridge] Tool ${name} is now ${enabled ? 'enabled' : 'disabled'}`);
  }
}

/**
 * Set enabled tools map (for persistence)
 */
function setEnabledToolsMap(toolMap) {
  enabledTools = { ...toolMap };
  Object.entries(registeredMCPTools).forEach(([name, tool]) => {
    tool.enabled = enabledTools[name] !== false;
  });
}

/**
 * Get enabled tools map (for persistence)
 */
function getEnabledToolsMap() {
  return { ...enabledTools };
}

/**
 * Call an MCP tool by name (only if enabled)
 */
async function callMCPTool(name, args) {
  const tool = registeredMCPTools[name];
  if (!tool) {
    throw new Error(`MCP tool not found: ${name}`);
  }
  if (tool.enabled === false) {
    throw new Error(`MCP tool is disabled: ${name}`);
  }
  return await tool.execute(args);
}

/**
 * Get schemas for enabled MCP tools (for LLM)
 */
function getMCPToolSchemas() {
  return Object.entries(registeredMCPTools)
    .filter(([_, tool]) => tool.enabled !== false)
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.schema
    }));
}

module.exports = {
  registerMCPTools,
  getMCPTools,
  getToolsByServer,
  getEnabledMCPTools,
  toggleTool,
  setEnabledToolsMap,
  getEnabledToolsMap,
  callMCPTool,
  getMCPToolSchemas
};
