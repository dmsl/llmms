class SessionStorage {
  static setSystemPrompt(systemPrompt) {
    sessionStorage.setItem('system_prompt', systemPrompt);
  }

  static getSystemPrompt() {
    return sessionStorage.getItem('system_prompt') || '';
  }

  static setPersonality(personality) {
    sessionStorage.setItem('personality', personality);
  }

  static getPersonality() {
    return sessionStorage.getItem('personality') || 'default';
  }

  static setLastUserMessage(message) {
    sessionStorage.setItem('last_user_message', message);
  }

  static getLastUserMessage() {
    return sessionStorage.getItem('last_user_message') || '';
  }

  static setLastToolSchemas(schemas) {
    sessionStorage.setItem('last_tool_schemas', JSON.stringify(schemas));
  }

  static getLastToolSchemas() {
    try {
      return JSON.parse(sessionStorage.getItem('last_tool_schemas') || '[]');
    } catch {
      return [];
    }
  }

  static setEnabledTools(toolMap) {
    sessionStorage.setItem('enabled_tools', JSON.stringify(toolMap));
  }

  static getEnabledTools() {
    try {
      return JSON.parse(sessionStorage.getItem('enabled_tools') || '{}');
    } catch {
      return {};
    }
  }

  static setModelMetadata(modelId, metadata) {
    const models = JSON.parse(sessionStorage.getItem('model_metadata') || '{}');
    models[modelId] = metadata;
    sessionStorage.setItem('model_metadata', JSON.stringify(models));
  }

  static getModelMetadata(modelId) {
    const models = JSON.parse(sessionStorage.getItem('model_metadata') || '{}');
    return models[modelId] || {};
  }
}

class MessageValidator {
  static validateBeforeSend(userInput) {
    const errors = [];

    if (!userInput || !userInput.trim()) {
      errors.push('Message cannot be empty');
    }

    if (userInput.length > 2500) {
      errors.push(`Message is ${userInput.length} characters. Maximum is 2500.`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static checkForDeleteKeyword(message) {
    return /\bdelete\b/i.test(message);
  }

  static checkFileSizeWarning(sizeInBytes) {
    const ONE_MB = 1048576;
    return sizeInBytes > ONE_MB;
  }
}

class TokenCounter {
  static parseTokenUsage(response) {
    if (response.tokens) {
      return {
        prompt: response.tokens.prompt_tokens || 0,
        completion: response.tokens.completion_tokens || 0,
        total: response.tokens.total_tokens || 0
      };
    }
    return { prompt: 0, completion: 0, total: 0 };
  }

  static formatTokenCount(tokens) {
    if (!tokens) return '';
    return `${tokens.prompt}↓ ${tokens.completion}↑ (${tokens.total}⟡)`;
  }
}

class ChatExport {
  static exportJSON(messages, sessionName) {
    const data = {
      version: 1,
      exportDate: new Date().toISOString(),
      sessionName,
      messages
    };
    return JSON.stringify(data, null, 2);
  }

  static exportMarkdown(messages, sessionName) {
    let md = `# ${sessionName}\n\n`;
    md += `Exported: ${new Date().toLocaleString()}\n\n`;

    for (const msg of messages) {
      if (msg.role === 'user') {
        md += `## User\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `## Assistant\n\n${msg.content}\n\n`;
        if (msg.tokens) {
          md += `_Tokens: ${msg.tokens.total}_\n\n`;
        }
      }
    }

    return md;
  }

  static downloadFile(content, filename, mimeType = 'application/json') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  static async importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          resolve(data);
        } catch (error) {
          reject(new Error('Invalid JSON format'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }
}

class ToolDebugger {
  static formatToolCall(name, args) {
    return {
      name,
      arguments: args,
      timestamp: new Date().toISOString()
    };
  }

  static formatToolResponse(name, response, executionTimeMs) {
    return {
      toolName: name,
      result: response,
      executionTime: `${executionTimeMs}ms`,
      timestamp: new Date().toISOString()
    };
  }
}

export {
  SessionStorage,
  MessageValidator,
  TokenCounter,
  ChatExport,
  ToolDebugger
};
