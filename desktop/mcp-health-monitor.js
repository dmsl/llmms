class MCPHealthMonitor {
  constructor(mcp) {
    this.mcp = mcp;
    this.serverStates = {};
    this.healthCheckInterval = null;
    this.reconnectAttempts = {};
  }

  startHealthChecks(serverUrls = [], intervalMs = 30000) {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(async () => {
      for (const url of serverUrls) {
        await this.checkServerHealth(url);
      }
    }, intervalMs);
  }

  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async checkServerHealth(url) {
    try {
      if (!this.mcp.ws || this.mcp.ws.readyState !== WebSocket.OPEN) {
        this.setServerState(url, 'offline');
        await this.attemptReconnect(url);
        return;
      }

      const tools = await this.mcp.listTools();
      this.setServerState(url, 'online', tools ? tools.length : 0);
    } catch (error) {
      console.warn(`[MCPHealthMonitor] Health check failed for ${url}:`, error);
      this.setServerState(url, 'offline');
      await this.attemptReconnect(url);
    }
  }

  async attemptReconnect(url, maxAttempts = 3) {
    const attempts = this.reconnectAttempts[url] || 0;
    if (attempts >= maxAttempts) return;

    this.reconnectAttempts[url] = attempts + 1;
    console.log(`[MCPHealthMonitor] Reconnect attempt ${attempts + 1} for ${url}`);

    setTimeout(async () => {
      try {
        await this.mcp.connect(url);
        this.reconnectAttempts[url] = 0;
        this.setServerState(url, 'online');
      } catch (error) {
        console.error(`[MCPHealthMonitor] Reconnect failed for ${url}:`, error);
      }
    }, 2000 * (attempts + 1));
  }

  setServerState(url, status, toolCount = 0) {
    const oldState = this.serverStates[url];
    this.serverStates[url] = { status, toolCount, timestamp: Date.now() };

    if (oldState?.status !== status) {
      console.log(`[MCPHealthMonitor] Server ${url} is now ${status}`);
    }
  }

  getServerState(url) {
    return this.serverStates[url] || { status: 'unknown', toolCount: 0, timestamp: 0 };
  }

  getAllServerStates() {
    return this.serverStates;
  }
}

module.exports = MCPHealthMonitor;
