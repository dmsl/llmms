const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const MCPClient = require('./mcp-client');
const LocalMCPServer = require('./mcp-local-server');
const { runAgent } = require('./agent');
const toolRegistryBridge = require('./tool-registry-bridge');
const MCPHealthMonitor = require('./mcp-health-monitor');
const { UpdateManager, setupUpdateHandlers } = require('./update-manager');
const mcpLogger = require('./mcp-logger');

let mainWindow;
const mcp = new MCPClient();
const localMCPServers = {}; // Store local servers by name
const healthMonitor = new MCPHealthMonitor(mcp);
let updateManager;

// MCP config file setup
const configDir = app.getPath('userData');
const configFile = path.join(configDir, 'mcp.json');

// Initialize config file if it doesn't exist
const initializeConfigFile = () => {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({ servers: [] }, null, 2));
  }
};

// Auto-connect to MCP servers listed in config
async function autoConnectMCPServers() {
  if (!fs.existsSync(configFile)) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!config.servers) return;

  for (const server of config.servers) {
    if (server.autoConnect === true) {
      try {
        if (server.type === 'local') {
          // Handle local stdio-based MCP servers
          const localServer = new LocalMCPServer(server.config);
          
          localServer.setToolsCallback((formattedTools) => {
            // Add server metadata to tools
            const toolsWithServer = formattedTools.map(t => ({
              ...t,
              serverName: server.name,
              serverType: server.type
            }));
            
            toolRegistryBridge.registerMCPTools(toolsWithServer, server.name, server.type);
            mcpLogger.logToolsRegistered(server.name, toolsWithServer.length, toolsWithServer);
            console.log(`[Main] Registered ${toolsWithServer.length} MCP tools from local server: ${server.name}`);
            
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('mcp:tools-registered', {
                serverName: server.name,
                serverType: 'local',
                count: toolsWithServer.length,
                tools: toolsWithServer.map(t => ({ name: t.name, description: t.description }))
              });
            }
          });
          
          await localServer.start();
          localMCPServers[server.name] = localServer;
          mcpLogger.logServerConnected(server.name, 'local', 0);
          console.log('[Main] Started local MCP server:', server.name);
          
        } else {
          // Handle remote WebSocket-based MCP servers
          mcp.setToolsCallback((formattedTools) => {
            // Add server metadata to tools
            const toolsWithServer = formattedTools.map(t => ({
              ...t,
              serverName: server.name,
              serverType: server.type
            }));
            
            toolRegistryBridge.registerMCPTools(toolsWithServer, server.name, server.type);
            mcpLogger.logToolsRegistered(server.name, toolsWithServer.length, toolsWithServer);
            console.log(`[Main] Registered ${toolsWithServer.length} MCP tools from ${server.url}`);
            
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('mcp:tools-registered', {
                serverUrl: server.url,
                serverName: server.name,
                serverType: server.type,
                count: toolsWithServer.length,
                tools: toolsWithServer.map(t => ({ name: t.name, description: t.description }))
              });
            }
          });
          
          await mcp.connect(server.url);
          mcpLogger.logServerConnected(server.name, 'remote', 0);
          console.log('[Main] Auto-connected to MCP server:', server.url);
        }
      } catch (err) {
        mcpLogger.logServerError(server.name || server.url, err);
        console.error('[Main] Failed to connect to MCP server:', server.name || server.url, err);
      }
    }
  }
}

ipcMain.handle('mcp:connect', async (event, url) => {
  // Set up callback to register tools when they're ingested
  mcp.setToolsCallback((formattedTools) => {
    // Add server metadata - use URL as server name for remote servers
    const serverName = new URL(url).hostname;
    const toolsWithServer = formattedTools.map(t => ({
      ...t,
      serverName,
      serverType: 'remote'
    }));
    
    toolRegistryBridge.registerMCPTools(toolsWithServer, serverName, 'remote');
    mcpLogger.logToolsRegistered(serverName, toolsWithServer.length, toolsWithServer);
    console.log(`[Main] Registered ${toolsWithServer.length} MCP tools from ${url}`);
    
    // Notify frontend that tools are available
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('mcp:tools-registered', {
        serverUrl: url,
        serverName,
        serverType: 'remote',
        count: toolsWithServer.length,
        tools: toolsWithServer.map(t => ({ name: t.name, description: t.description }))
      });
    }
  });
  
  // Connect triggers tool ingestion via callback
  await mcp.connect(url);
  mcpLogger.logServerConnected(new URL(url).hostname, 'remote', 0);
  return true;
});

ipcMain.handle('mcp:startLocalServer', async (event, serverName) => {
  try {
    if (!fs.existsSync(configFile)) {
      throw new Error('MCP config file not found');
    }
    
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const serverConfig = config.servers?.find(s => s.name === serverName && s.type === 'local');
    
    if (!serverConfig) {
      throw new Error(`Local MCP server config not found: ${serverName}`);
    }
    
    if (localMCPServers[serverName]) {
      console.log(`[Main] Local server already running: ${serverName}`);
      return { success: true, message: 'Server already running' };
    }
    
    const localServer = new LocalMCPServer(serverConfig.config);
    
    localServer.setToolsCallback((formattedTools) => {
      // Add server metadata to tools
      const toolsWithServer = formattedTools.map(t => ({
        ...t,
        serverName,
        serverType: 'local'
      }));
      
      toolRegistryBridge.registerMCPTools(toolsWithServer, serverName, 'local');
      mcpLogger.logToolsRegistered(serverName, toolsWithServer.length, toolsWithServer);
      console.log(`[Main] Registered ${toolsWithServer.length} MCP tools from local server: ${serverName}`);
      
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('mcp:tools-registered', {
          serverName: serverName,
          serverType: 'local',
          count: toolsWithServer.length,
          tools: toolsWithServer.map(t => ({ name: t.name, description: t.description }))
        });
      }
    });
    
    await localServer.start();
    localMCPServers[serverName] = localServer;
    mcpLogger.logServerConnected(serverName, 'local', 0);
    
    console.log('[Main] Started local MCP server:', serverName);
    return { success: true, message: `Started ${serverName}` };
    
  } catch (error) {
    mcpLogger.logServerError(serverName, error);
    console.error('[Main] Failed to start local server:', error);
    return { success: false, error: error.message };
  }
});

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false
    }
  });

  // Use the SAME relative path for both dev and packaged modes
  // Dev: __dirname = desktop/, ./frontend/html/chat.html
  // Packaged: __dirname = resources/app/, ../frontend/html/chat.html (via extraResources)
  const isDev = !app.isPackaged;
  const chatPath = isDev 
    ? path.join(__dirname, "./frontend/html/chat.html")
    : path.join(__dirname, "../frontend/html/chat.html");
  
  mainWindow.loadFile(chatPath);

  // Initialize update manager
  updateManager = new UpdateManager(mainWindow);
  updateManager.initialize();
  setupUpdateHandlers(updateManager);

  if (mcp) {
    autoConnectMCPServers();
  }
};

app.on('ready', () => {
  initializeConfigFile();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

ipcMain.handle('mcp:call', async (event, { name, args }) => {
  try {
    // Route to the tool registry bridge which handles both local and remote tools
    return await toolRegistryBridge.callMCPTool(name, args);
  } catch (error) {
    console.error(`[Main] Failed to call MCP tool ${name}:`, error);
    throw error;
  }
});

ipcMain.handle('mcp:writeFile', async (event, { path, content }) => {
  return await mcp.callTool('filesystem.writeFile', { path, content });
});

ipcMain.handle('mcp:getConfig', () => {
  if (!fs.existsSync(configFile)) return { servers: [] };
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
});

ipcMain.handle('mcp:openConfig', () => {
  shell.showItemInFolder(configFile);
  return true;
});

ipcMain.handle('mcp:autoConnect', async () => {
  return await autoConnectMCPServers();
});

ipcMain.handle('mcp:getServerStatus', () => {
  return healthMonitor.getAllServerStates();
});

ipcMain.handle('mcp:startHealthChecks', async (event, serverUrls) => {
  healthMonitor.startHealthChecks(serverUrls, 30000);
  return true;
});

ipcMain.handle('mcp:stopHealthChecks', () => {
  healthMonitor.stopHealthChecks();
  return true;
});

ipcMain.handle('mcp:toggleTool', (event, { toolName, enabled }) => {
  toolRegistryBridge.toggleTool(toolName, enabled);
  
  // Persist to mcp.json
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!config.enabledTools) config.enabledTools = {};
    config.enabledTools[toolName] = enabled;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  
  return true;
});

ipcMain.handle('mcp:getEnabledTools', () => {
  return toolRegistryBridge.getEnabledToolsMap();
});

ipcMain.handle('mcp:getToolsByServer', () => {
  return toolRegistryBridge.getToolsByServer();
});

ipcMain.handle('mcp:getMCPToolSchemas', () => {
  return toolRegistryBridge.getMCPToolSchemas();
});

ipcMain.handle('mcp:setEnabledTools', (event, toolMap) => {
  toolRegistryBridge.setEnabledToolsMap(toolMap);
  
  // Persist to mcp.json
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.enabledTools = toolMap;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  
  return true;
});

ipcMain.handle('agent:run', async (event, payload) => {
  const { userMessage, systemPrompt = '', personality = 'default', model = 'llama3.2', conversationHistory = [] } = payload;
  
  // Always use current ENABLED tool schemas from registry
  const toolSchemas = [];
  try {
    const mcpTools = toolRegistryBridge.getEnabledMCPTools();
    if (mcpTools) {
      toolSchemas.push(...Object.entries(mcpTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.schema
      })));
    }
  } catch (e) {
    console.warn('[Main] Failed to retrieve MCP tools:', e);
  }
  
  // Unified tool runner that handles both local and MCP tools
  const toolRunner = async (name, args) => {
    // Handle filesystem tools
    if (name === 'filesystem.readFile') {
      try {
        const { path: filePath } = args;
        if (!filePath) throw new Error('Missing path argument');
        
        const content = fs.readFileSync(filePath, 'utf8');
        return { success: true, content };
      } catch (error) {
        throw new Error(`Read failed: ${error.message}`);
      }
    }
    
    if (name === 'filesystem.writeFile') {
      try {
        const { path: filePath, content } = args;
        if (!filePath || content === undefined) {
          throw new Error('Missing path or content argument');
        }
        
        fs.writeFileSync(filePath, content, 'utf8');
        return { success: true, message: `Wrote ${filePath}` };
      } catch (error) {
        throw new Error(`Write failed: ${error.message}`);
      }
    }
    
    // All other tools go through MCP tool registry
    try {
      const mcpTools = toolRegistryBridge.getMCPTools();
      if (mcpTools[name]) {
        const result = await toolRegistryBridge.callMCPTool(name, args);
        return result;
      }
      
      // If not in registry, try direct MCP call
      const result = await mcp.callTool(name, args);
      return result;
    } catch (error) {
      console.error(`[Main] Tool call failed for ${name}:`, error);
      throw error;
    }
  };
  
  try {
    const result = await runAgent({ 
      userMessage, 
      toolSchemas, 
      toolRunner,
      systemPrompt,
      personality,
      model,
      conversationHistory
    });
    return { success: true, result };
  } catch (error) {
    console.error('[Main] Agent execution failed:', error);
    
    // Failover to backend-only call without tool calling
    try {
      console.log('[Main] Attempting fallback to backend-only call');
      const fallbackMessages = [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: userMessage }
      ];
      
      const { callBackendLLM } = require('./agent');
      const fallbackResponse = await callBackendLLM(fallbackMessages, [], { model });
      const message = fallbackResponse.choices[0].message;
      
      return { 
        success: true, 
        result: {
          response: message.content || '',
          tokens: fallbackResponse.usage || {},
          toolsExecuted: false,
          fallback: true
        }
      };
    } catch (fallbackError) {
      console.error('[Main] Fallback call also failed:', fallbackError);
      return { 
        success: false, 
        error: error.message,
        fallbackError: fallbackError.message
      };
    }
  }
});

