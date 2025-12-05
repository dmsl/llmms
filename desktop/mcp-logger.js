const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class MCPLogger {
  constructor() {
    this.logsDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logsDir, 'mcp-connections.log');
    this.ensureLogsDirectory();
  }

  ensureLogsDirectory() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  formatLogEntry(level, category, message, data = null) {
    const entry = {
      timestamp: this.getTimestamp(),
      level,
      category,
      message,
      ...(data && { data })
    };
    return JSON.stringify(entry);
  }

  write(level, category, message, data = null) {
    try {
      const logEntry = this.formatLogEntry(level, category, message, data);
      fs.appendFileSync(this.logFile, logEntry + '\n', 'utf8');
      
      // Also log to console
      const prefix = `[${category}]`;
      if (level === 'error') {
        console.error(prefix, message, data || '');
      } else if (level === 'warn') {
        console.warn(prefix, message, data || '');
      } else {
        console.log(prefix, message, data || '');
      }
    } catch (error) {
      console.error('[MCPLogger] Failed to write log:', error);
    }
  }

  info(category, message, data = null) {
    this.write('info', category, message, data);
  }

  warn(category, message, data = null) {
    this.write('warn', category, message, data);
  }

  error(category, message, data = null) {
    this.write('error', category, message, data);
  }

  logServerConnected(serverName, serverType, toolCount) {
    this.info('MCP-SERVER', `Connected to ${serverType} server`, {
      serverName,
      serverType,
      toolCount
    });
  }

  logServerDisconnected(serverName, serverType, reason = null) {
    this.info('MCP-SERVER', `Disconnected from ${serverType} server`, {
      serverName,
      serverType,
      reason
    });
  }

  logToolsRegistered(serverName, toolCount, tools) {
    this.info('MCP-TOOLS', `Registered ${toolCount} tools from server`, {
      serverName,
      toolCount,
      toolNames: tools.map(t => t.name)
    });
  }

  logToolCalled(toolName, serverName, args = null) {
    this.info('MCP-CALL', `Tool called: ${toolName}`, {
      toolName,
      serverName,
      ...(args && { argsKeys: Object.keys(args) })
    });
  }

  logToolError(toolName, serverName, error) {
    this.error('MCP-CALL', `Tool call failed: ${toolName}`, {
      toolName,
      serverName,
      error: error.message
    });
  }

  logServerError(serverName, error) {
    this.error('MCP-SERVER', `Server error: ${serverName}`, {
      serverName,
      error: error.message,
      stack: error.stack
    });
  }

  getLogFile() {
    return this.logFile;
  }

  clearLogs() {
    try {
      fs.writeFileSync(this.logFile, '', 'utf8');
      this.info('MCP-LOGGER', 'Logs cleared');
    } catch (error) {
      console.error('[MCPLogger] Failed to clear logs:', error);
    }
  }

  getRecentLogs(lines = 100) {
    try {
      if (!fs.existsSync(this.logFile)) {
        return [];
      }
      const content = fs.readFileSync(this.logFile, 'utf8');
      const allLines = content.trim().split('\n').filter(l => l);
      return allLines.slice(-lines).map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    } catch (error) {
      console.error('[MCPLogger] Failed to read logs:', error);
      return [];
    }
  }
}

// Singleton instance
const mcpLogger = new MCPLogger();

module.exports = mcpLogger;
