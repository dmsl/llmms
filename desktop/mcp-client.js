class MCPClient {
  constructor() {
    this.ws = null;
    this.onToolsReceived = null;  // Callback for tool ingestion
  }

  async connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = async () => {
        try {
          // Automatically fetch and register tools from the server
          await this.ingestTools();
          resolve();
        } catch (error) {
          console.warn('[MCP] Tool ingestion failed, continuing anyway:', error);
          resolve(); // Still resolve, tools are optional
        }
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onmessage = (event) => {
        // Message handling will be done per-request
      };
    });
  }

  async callTool(name, args) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('MCP not connected'));
        return;
      }

      const requestId = Math.random().toString(36).substring(7);
      const request = {
        id: requestId,
        method: 'tools/call',
        params: {
          name,
          arguments: args
        }
      };

      const messageHandler = (event) => {
        try {
          const response = JSON.parse(event.data);
          if (response.id === requestId) {
            this.ws.removeEventListener('message', messageHandler);
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result);
            }
          }
        } catch (e) {
          // Ignore parse errors, continue listening
        }
      };

      this.ws.addEventListener('message', messageHandler);
      this.ws.send(JSON.stringify(request));

      // 30 second timeout
      setTimeout(() => {
        this.ws.removeEventListener('message', messageHandler);
        reject(new Error('MCP tool call timeout'));
      }, 30000);
    });
  }

  async ingestTools() {
    const tools = await this.listTools();
    if (tools && tools.length > 0) {
      // Convert MCP tools to tool-registry format with execute() wrapper
      const formattedTools = tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        schema: tool.inputSchema || {},
        execute: async (args) => {
          // Executor function for tool-registry
          const result = await this.callTool(tool.name, args);
          return result;
        }
      }));

      // Notify callback if registered
      if (this.onToolsReceived) {
        this.onToolsReceived(formattedTools);
      }

      console.log(`[MCP] Ingested ${formattedTools.length} tools from server`);
      return formattedTools;
    }
    return [];
  }

  setToolsCallback(callback) {
    this.onToolsReceived = callback;
  }

  async listTools() {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('MCP not connected'));
        return;
      }

      const requestId = Math.random().toString(36).substring(7);
      const request = {
        id: requestId,
        method: 'tools/list',
        params: {}
      };

      const messageHandler = (event) => {
        try {
          const response = JSON.parse(event.data);
          if (response.id === requestId) {
            this.ws.removeEventListener('message', messageHandler);
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result?.tools || []);
            }
          }
        } catch (e) {
          // Ignore parse errors, continue listening
        }
      };

      this.ws.addEventListener('message', messageHandler);
      this.ws.send(JSON.stringify(request));

      // 10 second timeout
      setTimeout(() => {
        this.ws.removeEventListener('message', messageHandler);
        reject(new Error('MCP list tools timeout'));
      }, 10000);
    });
  }
}

module.exports = MCPClient;
