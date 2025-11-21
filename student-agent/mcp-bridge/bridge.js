#!/usr/bin/env node

/**
 * MCP Bridge - Node.js client for connecting to MCP servers
 * This runs locally inside the Tauri desktop app and handles MCP protocol
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class MCPBridge {
  constructor() {
    this.client = null;
    this.transport = null;
    this.tools = [];
  }

  /**
   * Connect to an MCP server via WebSocket
   * @param {string} url - WebSocket URL (e.g., ws://localhost:8765)
   */
  async connectWebSocket(url) {
    try {
      this.transport = new WebSocketClientTransport(new URL(url));
      this.client = new Client(
        {
          name: 'chatucy-desktop',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      await this.client.connect(this.transport);
      
      // List available tools
      const response = await this.client.listTools();
      this.tools = response.tools || [];
      
      return {
        success: true,
        tools: this.tools,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Connect to an MCP server via stdio (for local process-based MCP servers)
   * @param {string} command - Command to spawn
   * @param {string[]} args - Command arguments
   */
  async connectStdio(command, args = []) {
    try {
      this.transport = new StdioClientTransport({
        command,
        args,
      });
      
      this.client = new Client(
        {
          name: 'chatucy-desktop',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      await this.client.connect(this.transport);
      
      // List available tools
      const response = await this.client.listTools();
      this.tools = response.tools || [];
      
      return {
        success: true,
        tools: this.tools,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Call an MCP tool
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   */
  async callTool(name, args) {
    if (!this.client) {
      throw new Error('Not connected to MCP server');
    }

    try {
      const result = await this.client.callTool({
        name,
        arguments: args,
      });
      
      return {
        success: true,
        result: result.content,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * List all available tools
   */
  async listTools() {
    if (!this.client) {
      throw new Error('Not connected to MCP server');
    }

    try {
      const response = await this.client.listTools();
      this.tools = response.tools || [];
      return {
        success: true,
        tools: this.tools,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
      this.tools = [];
    }
  }
}

// Handle command-line usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = new MCPBridge();
  
  // Read commands from stdin (JSON-RPC style)
  process.stdin.setEncoding('utf8');
  
  let buffer = '';
  
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    
    // Try to parse complete JSON messages
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const message = JSON.parse(line);
        const { id, method, params } = message;
        
        let result;
        
        switch (method) {
          case 'connect':
            result = await bridge.connectWebSocket(params.url);
            break;
          
          case 'connect_stdio':
            result = await bridge.connectStdio(params.command, params.args);
            break;
          
          case 'callTool':
            result = await bridge.callTool(params.name, params.arguments);
            break;
          
          case 'listTools':
            result = await bridge.listTools();
            break;
          
          case 'disconnect':
            await bridge.disconnect();
            result = { success: true };
            break;
          
          default:
            result = { success: false, error: `Unknown method: ${method}` };
        }
        
        // Send response
        process.stdout.write(JSON.stringify({ id, result }) + '\n');
        
      } catch (error) {
        process.stderr.write(`Error processing message: ${error.message}\n`);
      }
    }
  });
  
  process.stdin.on('end', async () => {
    await bridge.disconnect();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await bridge.disconnect();
    process.exit(0);
  });
}

export default MCPBridge;
