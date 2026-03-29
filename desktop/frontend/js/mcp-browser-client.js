/**
 * MCP Browser Client
 * Browser-compatible WebSocket client for remote MCP servers
 * No Node.js dependencies - pure browser WebSocket API
 */

class MCPBrowserClient {
  constructor() {
    this.servers = new Map(); // serverName -> { ws, tools, status }
    this.onToolsReceived = null;
    this.messageHandlers = new Map(); // requestId -> { resolve, reject, timeout }
  }

  /**
   * Connect to a remote MCP server — auto-detects SSE (http/https) vs WebSocket (ws/wss)
   * @param {string} serverName - Unique identifier for this server
   * @param {string} url - Server URL
   * @param {Object} connectionParams - Optional connection parameters
   * @returns {Promise<void>}
   */
  async connect(serverName, url, connectionParams = null) {
    const isSSE = url.startsWith('http://') || url.startsWith('https://');
    if (isSSE) return this.connectSSE(serverName, url);
    return this._connectWebSocket(serverName, url, connectionParams);
  }

  /**
   * Connect via HTTP SSE transport (used by @playwright/mcp and other HTTP MCP servers)
   * Each connection gets its own browser/session context on the server side.
   * @param {string} serverName
   * @param {string} baseUrl - e.g. https://chatucy.cs.ucy.ac.cy/mcp/playwright
   */
  async connectSSE(serverName, baseUrl) {
    if (this.servers.has(serverName)) {
      console.log(`[MCP Browser] Server ${serverName} already connected`);
      return;
    }

    return new Promise((resolve, reject) => {
      const serverInfo = { type: 'sse', baseUrl, postUrl: null, eventSource: null, tools: [], status: 'connecting' };
      this.servers.set(serverName, serverInfo);

      const sseUrl = baseUrl.replace(/\/$/, '') + '/sse';
      const es = new EventSource(sseUrl);
      serverInfo.eventSource = es;

      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      const connectTimeout = setTimeout(() => {
        es.close();
        this.servers.delete(serverName);
        settle(reject, new Error(`SSE connect timeout for ${serverName}`));
      }, 15000);

      // Server sends: event: endpoint, data: /message?sessionId=xxx
      es.addEventListener('endpoint', async (event) => {
        const path = event.data.trim();
        // Build absolute POST URL relative to our proxy base (not the server origin)
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;
        serverInfo.postUrl = baseUrl.replace(/\/$/, '') + '/' + cleanPath;
        serverInfo.status = 'connected';

        // Create a fake WebSocket adapter so callTool / listTools work unchanged
        serverInfo.ws = {
          readyState: 1, // WebSocket.OPEN
          send: (data) => {
            fetch(serverInfo.postUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: data
            }).catch(err => console.error(`[MCP Browser] SSE POST failed for ${serverName}:`, err));
          },
          close: () => es.close()
        };

        console.log(`[MCP Browser] SSE connected to ${serverName}, postUrl: ${serverInfo.postUrl}`);

        try { serverInfo.tools = await this.ingestTools(serverName); } catch (e) {
          console.warn(`[MCP Browser] Tool ingestion failed for ${serverName}:`, e);
        }
        clearTimeout(connectTimeout);
        settle(resolve);
      });

      // Server sends tool call responses back over the SSE stream
      es.addEventListener('message', (event) => {
        this._handleMessage({ data: event.data });
      });

      es.onerror = (err) => {
        console.error(`[MCP Browser] SSE error for ${serverName}:`, err);
        serverInfo.status = 'error';
        this.servers.delete(serverName);
        clearTimeout(connectTimeout);
        settle(reject, new Error(`SSE connection error for ${serverName}`));
      };
    });
  }

  /**
   * Connect to a remote MCP server via WebSocket (original implementation)
   * @param {string} serverName
   * @param {string} url - WebSocket URL (ws:// or wss://)
   * @param {Object} connectionParams
   */
  async _connectWebSocket(serverName, url, connectionParams = null) {
    if (this.servers.has(serverName)) {
      console.log(`[MCP Browser] Server ${serverName} already connected`);
      return;
    }
    
    // Append connection parameters as query string if provided
    if (connectionParams) {
      const queryParams = new URLSearchParams();
      if (connectionParams.database) queryParams.set('database', connectionParams.database);
      if (connectionParams.user) queryParams.set('user', connectionParams.user);
      if (connectionParams.password) queryParams.set('password', connectionParams.password);
      
      const queryString = queryParams.toString();
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString;
        console.log(`[MCP Browser] Connecting with custom parameters: ${connectionParams.database || 'default'}`);
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        
        const serverInfo = {
          ws,
          url,
          tools: [],
          status: 'connecting'
        };
        
        this.servers.set(serverName, serverInfo);

        ws.onopen = async () => {
          console.log(`[MCP Browser] Connected to ${serverName} (${url})`);
          serverInfo.status = 'connected';
          
          try {
            // Automatically fetch tools from server
            const tools = await this.ingestTools(serverName);
            serverInfo.tools = tools;
            resolve();
          } catch (error) {
            console.warn(`[MCP Browser] Tool ingestion failed for ${serverName}:`, error);
            resolve(); // Still resolve, tools are optional
          }
        };

        ws.onerror = (error) => {
          console.error(`[MCP Browser] Connection error for ${serverName}:`, error);
          serverInfo.status = 'error';
          reject(new Error(`Failed to connect to ${serverName}: ${error.message || 'Unknown error'}`));
        };

        ws.onclose = () => {
          console.log(`[MCP Browser] Connection closed for ${serverName}`);
          serverInfo.status = 'disconnected';
          this.servers.delete(serverName);
        };

        ws.onmessage = (event) => {
          this._handleMessage(event);
        };

      } catch (error) {
        console.error(`[MCP Browser] Failed to create WebSocket for ${serverName}:`, error);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming messages (WebSocket or SSE)
   * @private
   */
  _handleMessage(event) {
    try {
      const response = JSON.parse(event.data);
      const handler = this.messageHandlers.get(response.id);
      
      if (handler) {
        clearTimeout(handler.timeout);
        this.messageHandlers.delete(response.id);
        
        if (response.error) {
          handler.reject(new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          handler.resolve(response.result);
        }
      }
    } catch (e) {
      console.warn('[MCP Browser] Failed to parse message:', e);
    }
  }

  /**
   * Call a tool on a specific MCP server
   * @param {string} serverName - Server identifier
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   * @returns {Promise<any>}
   */
  async callTool(serverName, toolName, args) {
    const serverInfo = this.servers.get(serverName);
    
    if (!serverInfo) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }
    
    if (serverInfo.status !== 'connected' || serverInfo.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`MCP server '${serverName}' not ready (status: ${serverInfo.status})`);
    }

    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args || {}
        }
      };

      // Set timeout (30 seconds)
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(requestId);
        reject(new Error(`Tool call timeout: ${toolName}`));
      }, 30000);

      this.messageHandlers.set(requestId, { resolve, reject, timeout });
      
      try {
        serverInfo.ws.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        this.messageHandlers.delete(requestId);
        reject(new Error(`Failed to send tool call: ${error.message}`));
      }
    });
  }

  /**
   * List all available tools from a server
   * @param {string} serverName - Server identifier
   * @returns {Promise<Array>}
   */
  async listTools(serverName) {
    const serverInfo = this.servers.get(serverName);
    
    if (!serverInfo) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }
    
    if (serverInfo.status !== 'connected' || serverInfo.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`MCP server '${serverName}' not ready`);
    }

    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: {}
      };

      const timeout = setTimeout(() => {
        this.messageHandlers.delete(requestId);
        reject(new Error('List tools timeout'));
      }, 10000);

      this.messageHandlers.set(requestId, { resolve, reject, timeout });
      
      try {
        serverInfo.ws.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timeout);
        this.messageHandlers.delete(requestId);
        reject(new Error(`Failed to list tools: ${error.message}`));
      }
    });
  }

  /**
   * Fetch and format tools from a server
   * @param {string} serverName - Server identifier
   * @returns {Promise<Array>}
   */
  async ingestTools(serverName) {
    try {
      const result = await this.listTools(serverName);
      const tools = result?.tools || [];
      
      if (tools.length === 0) {
        console.warn(`[MCP Browser] No tools returned from ${serverName}`);
        return [];
      }

      // Convert MCP tools to standardized format
      const formattedTools = tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        schema: tool.inputSchema || {},
        serverName: serverName,
        serverType: 'remote-web'
      }));

      console.log(`[MCP Browser] Ingested ${formattedTools.length} tools from ${serverName}`);

      // Notify callback if registered
      if (this.onToolsReceived) {
        this.onToolsReceived(serverName, formattedTools);
      }

      return formattedTools;
    } catch (error) {
      console.error(`[MCP Browser] Failed to ingest tools from ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Set callback for when tools are received
   * @param {Function} callback - (serverName, tools) => void
   */
  setToolsCallback(callback) {
    this.onToolsReceived = callback;
  }

  /**
   * Get all tools from all connected servers
   * @returns {Array}
   */
  getAllTools() {
    const allTools = [];
    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.tools) {
        allTools.push(...serverInfo.tools);
      }
    }
    return allTools;
  }

  /**
   * Get server status
   * @returns {Object} Map of serverName -> status
   */
  getServerStatus() {
    const status = {};
    for (const [serverName, serverInfo] of this.servers) {
      status[serverName] = {
        status: serverInfo.status,
        url: serverInfo.url,
        toolCount: serverInfo.tools?.length || 0
      };
    }
    return status;
  }

  /**
   * Disconnect from a specific server
   * @param {string} serverName - Server identifier
   */
  disconnect(serverName) {
    const serverInfo = this.servers.get(serverName);
    if (serverInfo) {
      if (serverInfo.type === 'sse' && serverInfo.eventSource) {
        serverInfo.eventSource.close();
      } else if (serverInfo.ws) {
        serverInfo.ws.close();
      }
      this.servers.delete(serverName);
      console.log(`[MCP Browser] Disconnected from ${serverName}`);
    }
  }

  /**
   * Disconnect from all servers
   */
  disconnectAll() {
    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.ws) {
        serverInfo.ws.close();
      }
    }
    this.servers.clear();
    console.log('[MCP Browser] Disconnected from all servers');
  }

  /**
   * Check if a server is connected
   * @param {string} serverName - Server identifier
   * @returns {boolean}
   */
  isConnected(serverName) {
    const serverInfo = this.servers.get(serverName);
    return serverInfo?.status === 'connected' && 
           serverInfo?.ws?.readyState === WebSocket.OPEN;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MCPBrowserClient;
}

// Also expose globally for browser use
if (typeof window !== 'undefined') {
  window.MCPBrowserClient = MCPBrowserClient;
}
