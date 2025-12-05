const { spawn } = require('child_process');
const path = require('path');

class LocalMCPServer {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.stdout = '';
    this.stderr = '';
    this.isConnected = false;
    this.requestHandlers = new Map();
    this.requestId = 0;
    this.onToolsReceived = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        const { command, args = [] } = this.config;
        
        console.log(`[LocalMCP] Starting server with command: ${command} ${args.join(' ')}`);
        
        this.process = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
          windowsHide: true
        });

        this.process.stdout.on('data', (data) => {
          const message = data.toString();
          console.log('[LocalMCP] Server stdout:', message);
          this.handleMessage(data);
        });

        this.process.stderr.on('data', (data) => {
          console.error('[LocalMCP] Server stderr:', data.toString());
          this.stderr += data.toString();
        });

        this.process.on('error', (error) => {
          console.error('[LocalMCP] Process error:', error);
          this.isConnected = false;
          reject(error);
        });

        this.process.on('exit', (code) => {
          console.log('[LocalMCP] Server process exited with code:', code);
          this.isConnected = false;
        });

        // Give server a moment to start
        setTimeout(() => {
          this.isConnected = true;
          console.log('[LocalMCP] Server marked as connected');
          
          // Ingest tools after server is ready
          this.ingestTools()
            .then(() => {
              console.log('[LocalMCP] Tools ingested successfully');
              resolve();
            })
            .catch((error) => {
              console.warn('[LocalMCP] Tool ingestion failed, continuing:', error);
              resolve();
            });
        }, 1500);

      } catch (error) {
        console.error('[LocalMCP] Failed to start server:', error);
        reject(error);
      }
    });
  }

  handleMessage(data) {
    const messages = data.toString().split('\n');
    for (const line of messages) {
      if (!line.trim()) continue;
      
      try {
        const response = JSON.parse(line);
        console.log('[LocalMCP] Received:', response);
        
        if (response.id && this.requestHandlers.has(response.id)) {
          const handler = this.requestHandlers.get(response.id);
          this.requestHandlers.delete(response.id);
          
          if (response.error) {
            handler.reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            handler.resolve(response.result);
          }
        }
      } catch (e) {
        // Ignore parse errors
        console.warn('[LocalMCP] Failed to parse message:', line);
      }
    }
  }

  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.process) {
        reject(new Error('LocalMCP not connected'));
        return;
      }

      const id = String(++this.requestId);
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.requestHandlers.set(id, { resolve, reject });

      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
        
        // Set timeout for request
        setTimeout(() => {
          if (this.requestHandlers.has(id)) {
            this.requestHandlers.delete(id);
            reject(new Error(`LocalMCP ${method} timeout`));
          }
        }, 10000);
      } catch (error) {
        this.requestHandlers.delete(id);
        reject(error);
      }
    });
  }

  async listTools() {
    const result = await this.sendRequest('tools/list');
    return result?.tools || [];
  }

  async ingestTools() {
    const tools = await this.listTools();
    if (tools && tools.length > 0) {
      const formattedTools = tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        schema: tool.inputSchema || {},
        execute: async (args) => {
          const result = await this.callTool(tool.name, args);
          return result;
        }
      }));

      if (this.onToolsReceived) {
        this.onToolsReceived(formattedTools);
      }

      console.log(`[LocalMCP] Ingested ${formattedTools.length} tools`);
      return formattedTools;
    }
    return [];
  }

  async callTool(name, args) {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args
    });
    return result;
  }

  setToolsCallback(callback) {
    this.onToolsReceived = callback;
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.isConnected = false;
    }
  }
}

module.exports = LocalMCPServer;
