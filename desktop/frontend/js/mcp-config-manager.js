/**
 * MCP Configuration Manager for Web Browser
 * Manages remote MCP server configurations using localStorage
 * Web alternative to Electron's mcp.json file
 */

class MCPConfigManager {
  constructor() {
    this.storageKey = 'mcp_browser_config';
    this.initializeStorage();
    this._migrate();
  }

  /**
   * Migrate old configs (e.g. wss:// playwright URL → https:// SSE URL)
   * Runs on every page load; idempotent.
   * @private
   */
  _migrate() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const config = JSON.parse(raw);
      let dirty = false;
      for (const s of (config.servers || [])) {
        if (s.name === 'playwright' && (s.url.startsWith('ws://') || s.url.startsWith('wss://'))) {
          s.url  = 'https://chatucy.cs.ucy.ac.cy/mcp/playwright';
          s.type = 'sse';
          dirty = true;
        }

        if (typeof s.enabled !== 'boolean') {
          s.enabled = false;
          dirty = true;
        }

        if (typeof s.autoConnect !== 'boolean') {
          s.autoConnect = false;
          dirty = true;
        }

        if (!s.toolStates || typeof s.toolStates !== 'object' || Array.isArray(s.toolStates)) {
          s.toolStates = {};
          dirty = true;
        }
      }
      if (dirty) {
        localStorage.setItem(this.storageKey, JSON.stringify(config));
        console.log('[MCP Config] Migrated playwright server to SSE transport');
      }
    } catch (e) {
      console.warn('[MCP Config] Migration error:', e);
    }
  }

  /**
   * Initialize localStorage with default structure if not exists
   */
  initializeStorage() {
    if (!localStorage.getItem(this.storageKey)) {
      const defaultConfig = {
        servers: [
          {
            name: 'playwright',
            url: 'https://chatucy.cs.ucy.ac.cy/mcp/playwright',
            type: 'sse',
            autoConnect: false,
            enabled: false,
            toolStates: {}
          }
        ],
        version: '1.0'
      };
      localStorage.setItem(this.storageKey, JSON.stringify(defaultConfig));
      console.log('[MCP Config] Initialized default configuration');
    }
  }

  /**
   * Get all MCP server configurations
   * @returns {Array} Array of server configs
   */
  getServers() {
    try {
      const config = JSON.parse(localStorage.getItem(this.storageKey));
      return config?.servers || [];
    } catch (error) {
      console.error('[MCP Config] Failed to parse configuration:', error);
      return [];
    }
  }

  /**
   * Get a specific server configuration by name
   * @param {string} serverName - Server identifier
   * @returns {Object|null}
   */
  getServer(serverName) {
    const servers = this.getServers();
    return servers.find(s => s.name === serverName) || null;
  }

  /**
   * Add or update a server configuration
   * @param {Object} serverConfig - Server configuration
   * @param {string} serverConfig.name - Unique server name
   * @param {string} serverConfig.url - WebSocket URL (ws:// or wss://)
   * @param {boolean} serverConfig.autoConnect - Auto-connect on page load
   * @param {string} serverConfig.description - Optional description
   */
  saveServer(serverConfig) {
    if (!serverConfig.name || !serverConfig.url) {
      throw new Error('Server name and URL are required');
    }

    try {
      const config = JSON.parse(localStorage.getItem(this.storageKey));
      const servers = config.servers || [];
      
      // Check if server exists
      const existingIndex = servers.findIndex(s => s.name === serverConfig.name);
      
      if (existingIndex >= 0) {
        // Update existing server
        servers[existingIndex] = {
          ...servers[existingIndex],
          ...serverConfig,
          enabled: typeof serverConfig.enabled === 'boolean'
            ? serverConfig.enabled
            : !!servers[existingIndex].enabled,
          autoConnect: !!serverConfig.autoConnect,
          toolStates: {
            ...(servers[existingIndex].toolStates || {}),
            ...(serverConfig.toolStates || {})
          },
          updatedAt: new Date().toISOString()
        };
        console.log(`[MCP Config] Updated server: ${serverConfig.name}`);
      } else {
        // Add new server
        servers.push({
          ...serverConfig,
          autoConnect: !!serverConfig.autoConnect,
          enabled: typeof serverConfig.enabled === 'boolean' ? serverConfig.enabled : false,
          toolStates: serverConfig.toolStates || {},
          createdAt: new Date().toISOString(),
          type: 'remote-web' // Web version only supports remote servers
        });
        console.log(`[MCP Config] Added new server: ${serverConfig.name}`);
      }
      
      config.servers = servers;
      localStorage.setItem(this.storageKey, JSON.stringify(config));
      
      return true;
    } catch (error) {
      console.error('[MCP Config] Failed to save server:', error);
      throw error;
    }
  }

  /**
   * Remove a server configuration
   * @param {string} serverName - Server identifier
   * @returns {boolean} Success status
   */
  removeServer(serverName) {
    try {
      const config = JSON.parse(localStorage.getItem(this.storageKey));
      const servers = config.servers || [];
      
      const filteredServers = servers.filter(s => s.name !== serverName);
      
      if (filteredServers.length === servers.length) {
        console.warn(`[MCP Config] Server not found: ${serverName}`);
        return false;
      }
      
      config.servers = filteredServers;
      localStorage.setItem(this.storageKey, JSON.stringify(config));
      
      console.log(`[MCP Config] Removed server: ${serverName}`);
      return true;
    } catch (error) {
      console.error('[MCP Config] Failed to remove server:', error);
      throw error;
    }
  }

  /**
   * Get servers with autoConnect enabled
   * @returns {Array}
   */
  getAutoConnectServers() {
    const servers = this.getServers();
    return servers.filter(s => s.autoConnect === true && s.enabled === true);
  }

  /**
   * Enable or disable a server.
   * @param {string} serverName
   * @param {boolean} enabled
   */
  setServerEnabled(serverName, enabled) {
    const server = this.getServer(serverName);
    if (!server) return false;

    return this.saveServer({
      ...server,
      enabled: !!enabled,
      autoConnect: !!server.autoConnect && !!enabled
    });
  }

  /**
   * Set one tool enablement state for a server.
   * @param {string} serverName
   * @param {string} toolName
   * @param {boolean} enabled
   */
  setToolState(serverName, toolName, enabled) {
    const server = this.getServer(serverName);
    if (!server) return false;

    const toolStates = {
      ...(server.toolStates || {}),
      [toolName]: !!enabled
    };

    return this.saveServer({
      ...server,
      toolStates
    });
  }

  /**
   * Merge discovered tool names into persisted state without overwriting
   * explicit user preferences. Newly discovered tools default to enabled.
   * @param {string} serverName
   * @param {string[]} toolNames
   * @param {boolean} defaultEnabled
   * @returns {Object}
   */
  syncToolStates(serverName, toolNames = [], defaultEnabled = true) {
    const server = this.getServer(serverName);
    if (!server) return {};

    const nextToolStates = { ...(server.toolStates || {}) };
    let changed = false;

    for (const toolName of toolNames) {
      if (!toolName) continue;
      if (typeof nextToolStates[toolName] !== 'boolean') {
        nextToolStates[toolName] = !!defaultEnabled;
        changed = true;
      }
    }

    if (changed) {
      this.saveServer({
        ...server,
        toolStates: nextToolStates
      });
    }

    return nextToolStates;
  }

  /**
   * Enable all provided tools for a server.
   * @param {string} serverName
   * @param {string[]} toolNames
   */
  enableAllTools(serverName, toolNames = []) {
    const server = this.getServer(serverName);
    if (!server) return false;

    const toolStates = { ...(server.toolStates || {}) };
    for (const toolName of toolNames) {
      if (toolName) {
        toolStates[toolName] = true;
      }
    }

    return this.saveServer({
      ...server,
      enabled: true,
      toolStates
    });
  }

  /**
   * Return tool state map for a server.
   * @param {string} serverName
   * @returns {Object}
   */
  getToolStates(serverName) {
    const server = this.getServer(serverName);
    return server?.toolStates || {};
  }

  /**
   * Clear all server configurations
   */
  clearAll() {
    const config = {
      servers: [],
      version: '1.0'
    };
    localStorage.setItem(this.storageKey, JSON.stringify(config));
    console.log('[MCP Config] Cleared all server configurations');
  }

  /**
   * Export configuration as JSON
   * @returns {string} JSON string
   */
  exportConfig() {
    const config = localStorage.getItem(this.storageKey);
    return config || '{}';
  }

  /**
   * Import configuration from JSON
   * @param {string} jsonString - JSON configuration string
   */
  importConfig(jsonString) {
    try {
      const config = JSON.parse(jsonString);
      
      // Validate structure
      if (!config.servers || !Array.isArray(config.servers)) {
        throw new Error('Invalid configuration format');
      }
      
      // Validate each server
      for (const server of config.servers) {
        if (!server.name || !server.url) {
          throw new Error('Each server must have name and url');
        }
      }
      
      localStorage.setItem(this.storageKey, jsonString);
      console.log('[MCP Config] Imported configuration successfully');
      return true;
    } catch (error) {
      console.error('[MCP Config] Failed to import configuration:', error);
      throw error;
    }
  }

  /**
   * Validate URL format
   * @param {string} url - WebSocket URL to validate
   * @returns {boolean}
   */
  static isValidWebSocketUrl(url) {
    try {
      const parsed = new URL(url);
      return ['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MCPConfigManager;
}

// Also expose globally for browser use
if (typeof window !== 'undefined') {
  window.MCPConfigManager = MCPConfigManager;
}
