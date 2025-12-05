// frontend-features.js
// Frontend integration for all chat UI features
// Works with Alpine.js chat app component

export class FrontendFeatures {
  static initializeSystemPromptUI(chatApp) {
    // Load system prompt and personality from storage
    chatApp.systemPrompt = this.loadSystemPrompt();
    chatApp.currentPersonality = this.loadPersonality();
  }

  static loadSystemPrompt() {
    return sessionStorage.getItem('system_prompt') || '';
  }

  static loadPersonality() {
    return sessionStorage.getItem('personality') || 'default';
  }

  static saveSystemPrompt(prompt) {
    sessionStorage.setItem('system_prompt', prompt);
  }

  static savePersonality(personality) {
    sessionStorage.setItem('personality', personality);
  }

  static validateMessageBeforeSend(message) {
    if (!message || !message.trim()) {
      return { valid: false, error: 'Message cannot be empty' };
    }
    if (message.length > 2500) {
      return { 
        valid: false, 
        error: `Message is ${message.length} characters. Maximum is 2500.` 
      };
    }
    if (/\bdelete\b/i.test(message)) {
      return { requiresConfirmation: true };
    }
    return { valid: true };
  }

  static checkFileSizeWarning(sizeBytes) {
    const ONE_MB = 1048576;
    return sizeBytes > ONE_MB;
  }

  static formatTokenUsage(tokens) {
    if (!tokens || !tokens.total) return '';
    return `📊 ${tokens.prompt || 0}⬇ ${tokens.completion || 0}⬆ (${tokens.total}⟡)`;
  }

  static formatTime(ms) {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  static createToolDebugInfo(toolName, args, result, executionTime) {
    return {
      toolName,
      arguments: JSON.stringify(args, null, 2),
      result: JSON.stringify(result, null, 2),
      executionTime: this.formatTime(executionTime),
      timestamp: new Date().toLocaleTimeString()
    };
  }

  static async exportSessionJSON(messages, sessionName) {
    const data = {
      version: 1,
      exportDate: new Date().toISOString(),
      sessionName,
      messageCount: messages.length,
      messages
    };
    const json = JSON.stringify(data, null, 2);
    this.downloadFile(json, `${sessionName}.json`, 'application/json');
  }

  static async exportSessionMarkdown(messages, sessionName) {
    let md = `# ${sessionName}\n\n`;
    md += `**Exported:** ${new Date().toLocaleString()}\n\n`;

    for (const msg of messages) {
      if (msg.role === 'user') {
        md += `## User\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `## Assistant\n\n${msg.content}\n\n`;
      }
    }

    this.downloadFile(md, `${sessionName}.md`, 'text/markdown');
  }

  static downloadFile(content, filename, mimeType) {
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

  static async importSessionFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (data.version === 1 && data.messages) {
            resolve({
              sessionName: data.sessionName || file.name.replace('.json', ''),
              messages: data.messages
            });
          } else {
            reject(new Error('Invalid session file format'));
          }
        } catch (error) {
          reject(new Error('Failed to parse session file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  static async requestSessionTitle(userMessage, firstResponse) {
    try {
      const response = await fetch('https://chatucy.cs.ucy.ac.cy/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [
            {
              role: 'user',
              content: `Given this conversation, provide a concise 3-5 word title (no quotes): "${userMessage.slice(0, 100)}..."`
            }
          ],
          max_tokens: 20
        })
      });

      if (!response.ok) throw new Error('Failed to generate title');
      const data = await response.json();
      return data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    } catch (error) {
      console.warn('[FrontendFeatures] Title generation failed:', error);
      return null;
    }
  }

  static initVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[FrontendFeatures] Speech Recognition not available');
      return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    return recognition;
  }

  static async initTextToSpeech(text) {
    try {
      const response = await fetch('https://chatucy.cs.ucy.ac.cy/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!response.ok) throw new Error('TTS failed');
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.play();
      return audio;
    } catch (error) {
      console.warn('[FrontendFeatures] TTS failed:', error);
      return null;
    }
  }
}

export default FrontendFeatures;
