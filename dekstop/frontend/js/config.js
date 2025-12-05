/**
 * MCP Configuration Handler
 * 
 * Handles loading and UI for MCP server configuration.
 * Web mode does not use this.
 */

export async function loadMCPConfig() {
  const isDesktop = !!window.desktop?.isElectron;
  
  if (isDesktop && window.desktop?.getMCPConfig) {
    return await window.desktop.getMCPConfig();
  }
  
  return { servers: [] };
}

export function showOpenConfigButton() {
  const isDesktop = !!window.desktop?.isElectron;
  
  if (!isDesktop) {
    return;
  }

  const btn = document.getElementById('open-config-btn');
  if (!btn) {
    return;
  }

  btn.style.display = 'block';
  btn.onclick = async () => {
    try {
      await window.desktop.openMCPConfig();
    } catch (error) {
      console.error('Error opening MCP config:', error);
      alert('Failed to open MCP config file');
    }
  };
}

export async function initializeAutoMCP() {
  if (window.desktop?.isElectron && window.desktop?.autoConnect) {
    try {
      await window.desktop.autoConnect();
      console.log('[MCP] Auto-connect initialized');
    } catch (error) {
      console.error('[MCP] Auto-connect error:', error);
    }
  }
}

