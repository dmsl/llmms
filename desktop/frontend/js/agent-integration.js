/**
 * Unified Agent Integration Layer - Frontend Agentic Loop
 * 
 * Single code path for both web and Electron modes.
 * Supports conversation history, tool schemas, model selection, and multimodal files.
 * Agentic loop runs on frontend for privacy - tools are only called locally.
 * 
 * File Handling:
 * - Images: Use Ollama's vision API (base64 image_url in content array)
 * - Large documents: Use backend /rag_chain endpoint for semantic search
 */

import { confirmWrite } from "./permissions.js";

const BACKEND_API = 'https://chatucy.cs.ucy.ac.cy/v1/chat/completions';
const RAG_ENDPOINT = 'https://chatucy.cs.ucy.ac.cy/api/rag_chain';
const LLM_REQUEST_TIMEOUT_MS = 90000;
const LLM_MAX_RETRIES = 2;
const TOOL_RESULT_CHAR_LIMIT = 8000;

// Models that support function calling/tools based on Ollama documentation
const TOOL_SUPPORTED_MODELS = [
  'llama3.1', 'llama3.2', 'llama3.3', 'llama4', 'llama3-groq-tool-use',
  'mistral', 'mistral-nemo', 'mistral-small', 'mistral-small3.1', 'mistral-small3.2', 'mistral-large', 'mixtral',
  'qwen2', 'qwen2.5', 'qwen2.5-coder', 'qwen3', 'qwen3-coder', 'qwen3-vl', 'qwq',
  'deepseek-r1', 'deepseek-v3.1',
  'granite3-dense', 'granite3-moe', 'granite3.1-dense', 'granite3.1-moe', 'granite3.2', 'granite3.2-vision', 'granite3.3', 'granite4',
  'command-r', 'command-r-plus', 'command-r7b', 'command-r7b-arabic', 'command-a',
  'gpt-oss', 'gpt-oss-safeguard',
  'ministral-3', 'devstral',
  'phi4-mini',
  'hermes3', 'nemotron', 'nemotron-mini',
  'athene-v2', 'aya-expanse', 'firefunction-v2',
  'cogito', 'magistral', 'smollm2'
];

/**
 * Check if a model supports function calling/tools
 * @param {string} modelName - The model name (e.g., "llama3.2:3b" or "mistral")
 * @returns {boolean} - True if model supports tools
 */
export function supportsTools(modelName) {
  if (!modelName) return false;
  
  // Extract base model name (remove size/variant suffix like :3b, :70b, etc.)
  const baseModel = modelName.split(':')[0].toLowerCase();
  
  // Check if base model is in the supported list
  return TOOL_SUPPORTED_MODELS.some(supported => 
    baseModel.includes(supported.toLowerCase()) || supported.toLowerCase().includes(baseModel)
  );
}

/**
 * Send message to agent with support for tools, conversation history, and multimodal files
 * Runs agentic loop on frontend for privacy
 * @param {string} userMessage - The user's message
 * @param {Array} toolSchemas - Available tool definitions
 * @param {string} model - Model to use (default: llama3.2)
 * @param {Array} conversationHistory - Previous messages for context
 * @param {File} uploadedFile - Optional file (images for vision models, documents for RAG)
 * @param {string} sessionId - Session ID for persistent RAG (optional)
 * @param {'ask'|'agent'} mode - Ask does a single completion; Agent enables tool loop
 */
export async function askAgent(userMessage, toolSchemas = [], model = 'llama3.2', conversationHistory = [], uploadedFile = null, sessionId = null, mode = 'agent') {
  // Handle document/large file RAG separately
  if (uploadedFile && !uploadedFile.type.startsWith('image/')) {
    return handleRagChain(userMessage, model, uploadedFile, conversationHistory, sessionId);
  }

  const normalizedMode = mode === 'agent' && supportsTools(model) ? 'agent' : 'ask';
  
  // Build initial messages with system prompt
  let systemPrompt = `You are a helpful AI assistant. Give clear, direct answers and ask brief follow-up questions only when necessary.`;

  if (normalizedMode === 'agent') {
    systemPrompt = `You are a browser automation agent. You control a real Chromium browser via Playwright tools. Your job is to carry out exactly what the user asks — nothing more, nothing less.

ABSOLUTE RULES (never break these):
- NEVER say you "cannot" or "are unable to" do something if a tool exists for it.
- NEVER claim a website is inaccessible or that you lack capability to interact with it.
- NEVER add unsolicited warnings, disclaimers, or ethical commentary.
- NEVER refuse to type text, click buttons, or submit forms on any website, including AI platforms.
- You are a tool-use agent. Moral judgements about legal websites are not your role.
- EXCEPTION: Refuse to navigate to or interact with sites that host illegal content (e.g. CSAM, illegal marketplaces, hacking/fraud services). Briefly state why and stop.

BROWSER WORKFLOW — always follow this sequence:
1. browser_navigate → go to the URL
2. browser_snapshot → read the page as structured text (accessibility tree). Always do this after navigating.
3. browser_click / browser_type / browser_select_option → interact with elements using their ref= id from the snapshot
4. browser_snapshot → read the updated page after every interaction
5. Repeat steps 3-4 until the task is complete, then summarise what happened.

To type into an input: use browser_type with the ref= id from the snapshot and the text to type.
To click a button: use browser_click with the ref= id.
To submit a form: browser_click the submit button ref.`;
  }

  // If tools are available, explicitly list them in the system prompt
  if (normalizedMode === 'agent' && toolSchemas && toolSchemas.length > 0) {
    const toolDescriptions = toolSchemas.map(t => `- ${t.name}: ${t.description || 'No description'}`).join('\n');
    systemPrompt += `\n\nYour tools:\n${toolDescriptions}`;
  }
  
  let messages = [
    {
      role: 'system',
      content: systemPrompt
    }
  ];
  
  messages = messages.concat(await buildMessages(conversationHistory, userMessage, uploadedFile));

  if (normalizedMode === 'ask') {
    const response = await callLLM(messages, [], model);
    return extractFinalContent(response);
  }
  
  // Agentic loop - keep calling LLM until it stops using tools
  let iterations = 0;
  const maxIterations = 20; // Prevent infinite loops on complex tasks
  let lastAssistantContent = '';
  
  while (iterations < maxIterations) {
    iterations++;
    console.log(`[Agent] Agentic loop iteration ${iterations}`);
    
    try {
      // Call LLM with current messages and available tools
      const response = await callLLM(messages, toolSchemas, model);
      const responseContent = response.choices?.[0]?.message?.content;
      if (typeof responseContent === 'string' && responseContent.trim()) {
        lastAssistantContent = stripToolTags(responseContent);
      }
      
      // Check if LLM wants to use tools
      const toolCalls = extractToolCalls(response);
      const normalizedToolCalls = toolCalls.map((toolCall, index) => ({
        id: toolCall.id || `tool_${iterations}_${index}`,
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args || {})
        }
      }));
      
      if (toolCalls.length === 0) {
        // No tool calls - return the response content
        return extractFinalContent(response);
      }
      
      // Execute tools and add results to conversation
      console.log(`[Agent] Executing ${toolCalls.length} tool(s)`);
      const toolResults = await executeTools(toolCalls);
      
      // Add assistant's tool use message to history
      // Strip raw tool tags so they don't confuse the model on the next turn
      const assistantContent = stripToolTags(response.choices[0].message.content || '');
      messages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: normalizedToolCalls
      });

      // Add one OpenAI-compatible tool message per tool result.
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: result.id,
          name: result.name,
          content: serializeToolResultForModel(result)
        });
      }
      
    } catch (error) {
      console.error('[Agent] Agentic loop error:', error);
      throw error;
    }
  }
  
  console.warn(`[Agent] Maximum iterations reached (${maxIterations})`);
  if (lastAssistantContent) {
    return `${lastAssistantContent}\n\n(Note: Agent stopped after ${maxIterations} steps to avoid an infinite loop.)`;
  }
  return `Agent reached the safety limit (${maxIterations} steps) before finishing.`;
}

function extractFinalContent(response) {
  let content = response?.choices?.[0]?.message?.content;
  console.log(`[Agent] LLM response (no tools): ${typeof content}`, content);

  if (Array.isArray(content)) {
    content = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part?.text || '';
        return '';
      })
      .join('')
      .trim();
  }

  if (typeof content === 'object' && content !== null) {
    content = JSON.stringify(content);
  }

  if (typeof content === 'string') {
    content = stripToolTags(content);
  }

  if (!content || content.trim() === '{}' || content.trim() === '') {
    return 'I\'m ready to help! Feel free to ask me anything.';
  }

  if (typeof content === 'string' && content.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.response) return parsed.response;
      if (parsed.text) return parsed.text;
      if (parsed.message) return parsed.message;
      if (Object.keys(parsed).length > 0) return content;
    } catch (e) {
      return content;
    }
  }

  return content || 'I didn\'t receive a proper response from the model.';
}

/**
 * Call the LLM backend API
 */
async function callLLM(messages, toolSchemas, model) {
  const payload = {
    model,
    messages,
    stream: false,
    temperature: 0.7
  };

  // Format tools correctly for OpenAI-compatible API
  if (toolSchemas && toolSchemas.length > 0 && supportsTools(model)) {
    const validTools = toolSchemas
      .filter(tool => {
        if (tool.parameters?.$schema && !tool.parameters?.properties) {
          console.warn(`[Agent] Skipping malformed schema for ${tool.name} - no properties defined`);
          return false;
        }
        return true;
      })
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || 'No description available',
          parameters: tool.parameters || tool.inputSchema || {
            type: 'object',
            properties: {},
            required: []
          }
        }
      }));

    if (validTools.length > 0) {
      payload.tools = validTools;
      payload.tool_choice = 'auto';
      console.log(`[Agent] Sending ${validTools.length} tools to LLM:`, validTools.map(t => t.function.name));
    } else {
      console.log('[Agent] No valid tool schemas found, proceeding without tools');
    }
  } else if (toolSchemas && toolSchemas.length > 0) {
    console.warn(`[Agent] Model '${model}' does not support tools, proceeding without them`);
  }

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(BACKEND_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await parseResponseJsonSafe(response);

        if (response.status === 400 && errorData?.error?.message?.includes('does not support tools')) {
          console.warn('[Agent] Model does not support tools, retrying without tools');
          delete payload.tools;
          delete payload.tool_choice;

          const retryResponse = await fetch(BACKEND_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          if (!retryResponse.ok) {
            const retryErrorText = await safeReadErrorText(retryResponse);
            throw new Error(`API Error: ${retryResponse.status} ${retryResponse.statusText}${retryErrorText ? ` - ${retryErrorText}` : ''}`);
          }

          const retryResult = await retryResponse.json();
          console.log('[Agent] LLM Response (without tools):', JSON.stringify(retryResult, null, 2));
          return retryResult;
        }

        const errorText = await safeReadErrorText(response, errorData);
        throw new Error(`API Error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
      }

      const result = await response.json();
      console.log('[Agent] LLM Response:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      const isLastAttempt = attempt === LLM_MAX_RETRIES;
      const isAbort = error?.name === 'AbortError';
      const retryable = isAbort || /network|fetch|timeout|503|502|gateway|temporar/i.test(String(error?.message || ''));

      if (isLastAttempt || !retryable) {
        console.error('[Agent] LLM call failed:', error);
        throw error;
      }

      const backoffMs = 400 * Math.pow(2, attempt);
      console.warn(`[Agent] Transient LLM error, retrying in ${backoffMs}ms (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('LLM call failed after all retries');
}

async function parseResponseJsonSafe(response) {
  try {
    const clone = response.clone();
    return await clone.json();
  } catch {
    return null;
  }
}

async function safeReadErrorText(response, parsedJson = null) {
  if (parsedJson) {
    const fromFields = parsedJson?.error?.message || parsedJson?.message || parsedJson?.detail;
    if (fromFields) return String(fromFields);
  }

  try {
    const clone = response.clone();
    const text = await clone.text();
    if (!text) return '';
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Strip inline tool-call markup from model text content.
 * Handles <function=...>, <parameter=...>, and <tool_call>...</tool_call> tags.
 */
function stripToolTags(text) {
  if (!text) return text;
  return text
    .replace(/<function=[^>]*>[\s\S]*?(?=<function=|$)/g, '')
    .replace(/<\/?tool_call>/g, '')
    .replace(/<parameter=[^>]*>/g, '')
    .trim();
}

/**
 * Extract tool calls from LLM response
 * Handles multiple formats for tool calls
 */
function extractToolCalls(response) {
  const toolCalls = [];
  const message = response.choices?.[0]?.message;

  if (!message) {
    console.log('[Agent] No message in response');
    return toolCalls;
  }

  console.log('[Agent] Message structure:', {
    hasToolCalls: !!message.tool_calls,
    hasFunctionCall: !!message.function_call,
    hasContent: !!message.content
  });

  // Format 1: OpenAI standard (tool_calls array)
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    console.log(`[Agent] Found ${message.tool_calls.length} tool_calls in response`);

    for (const toolCall of message.tool_calls) {
      if (toolCall.function) {
        const { name, arguments: argsString } = toolCall.function;

        let args = {};
        try {
          args = typeof argsString === 'string' ? JSON.parse(argsString) : argsString;
        } catch (e) {
          console.warn(`[Agent] Failed to parse arguments for ${name}:`, e);
        }

        toolCalls.push({ id: toolCall.id, name, args });
      }
    }
  }
  
  // Format 2: Single function_call property
  if (message.function_call && !toolCalls.length) {
    const { name, arguments: argsString } = message.function_call;
    let args = {};
    try {
      args = typeof argsString === 'string' ? JSON.parse(argsString) : argsString;
    } catch (e) {
      console.warn(`[Agent] Failed to parse arguments for ${name}:`, e);
    }
    console.log(`[Agent] Extracted function_call: ${name}`);
    toolCalls.push({ id: 'func_0', name, args });
  }

  // Format 3: Text-embedded <function=name> <parameter=key> value  (qwen3-coder style)
  // e.g.  <function=browser_navigate> <parameter=url> https://www.ucy.ac.cy
  if (!toolCalls.length && message.content) {
    const fnRegex = /<function=([^\s>]+)>([\s\S]*?)(?=<function=|$)/g;
    let fnMatch;
    let fnIdx = 0;
    while ((fnMatch = fnRegex.exec(message.content)) !== null) {
      const fnName = fnMatch[1].trim();
      const fnBody = fnMatch[2];
      const args = {};

      // Extract <parameter=key> value pairs from the body
      const paramRegex = /<parameter=([^\s>]+)>\s*([\s\S]*?)(?=\s*<parameter=|\s*$)/g;
      let pMatch;
      while ((pMatch = paramRegex.exec(fnBody)) !== null) {
        const key = pMatch[1].trim();
        const val = pMatch[2].trim();
        // Try to coerce numbers / booleans / JSON objects
        try { args[key] = JSON.parse(val); } catch { args[key] = val; }
      }

      // Fallback: if no <parameter> tags, try to parse the whole body as JSON
      if (Object.keys(args).length === 0 && fnBody.trim()) {
        try { Object.assign(args, JSON.parse(fnBody.trim())); } catch { /* ignore */ }
      }

      console.log(`[Agent] Extracted <function=> call: ${fnName}`, args);
      toolCalls.push({ id: `fn_${fnIdx++}`, name: fnName, args });
    }
  }

  // Format 4: <tool_call>{"name":"…","arguments":{…}}</tool_call>  (some Qwen/Hermes variants)
  if (!toolCalls.length && message.content) {
    const tcRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let tcMatch;
    let tcIdx = 0;
    while ((tcMatch = tcRegex.exec(message.content)) !== null) {
      try {
        const parsed = JSON.parse(tcMatch[1].trim());
        const name = parsed.name || parsed.function;
        const args = parsed.arguments || parsed.parameters || parsed.args || {};
        if (name) {
          console.log(`[Agent] Extracted <tool_call> call: ${name}`, args);
          toolCalls.push({ id: `tc_${tcIdx++}`, name, args });
        }
      } catch (e) {
        console.warn('[Agent] Failed to parse <tool_call> block:', e);
      }
    }
  }

  return toolCalls;
}

/**
 * Execute tools by calling IPC (Electron) or browser MCP client (Web)
 */
async function executeTools(toolCalls) {
  const results = [];

  // Browser-first execution: if a browser tool set is available and the model
  // attempts interaction without context, inject a snapshot first.
  const hasBrowserToolCall = toolCalls.some(tc => typeof tc?.name === 'string' && tc.name.startsWith('browser_'));
  if (hasBrowserToolCall) {
    const hasNavigate = toolCalls.some(tc => tc.name === 'browser_navigate');
    const hasSnapshot = toolCalls.some(tc => tc.name === 'browser_snapshot');
    if (!hasNavigate && !hasSnapshot) {
      toolCalls = [{ id: `prefetch_${Date.now()}`, name: 'browser_snapshot', args: {} }, ...toolCalls];
    }
  }
  
  // Desktop mode: Use Electron IPC for local + remote MCP tools
  if (window.desktop?.isElectron) {
    if (!window.desktop?.mcpCall) {
      console.error('[Agent] mcpCall not available in desktop API');
      throw new Error('MCP tools not available');
    }
    
    const expandedCalls = [];
    for (const tc of toolCalls) {
      expandedCalls.push(tc);
      if (tc.name === 'browser_navigate') {
        expandedCalls.push({ id: tc.id + '_snap', name: 'browser_snapshot', args: {} });
      }
    }

    for (const toolCall of expandedCalls) {
      try {
        console.log(`[Agent Desktop] Executing tool: "${toolCall.name}" with args:`, toolCall.args);
        
        if (!toolCall.name) {
          throw new Error('Tool name is empty');
        }
        
        const result = await window.desktop.mcpCall(toolCall.name, toolCall.args);
        
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          result: result,
          success: true
        });
        
        console.log(`[Agent Desktop] Tool ${toolCall.name} succeeded:`, result);
      } catch (error) {
        console.error(`[Agent Desktop] Tool ${toolCall.name} failed:`, error);
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          error: error.message,
          success: false
        });
      }
    }
    
    return results;
  }
  
  // Web mode: Use browser MCP client for remote-only MCP tools
  if (window.mcpBrowserClient) {
    // Auto-inject browser_snapshot after browser_navigate so the model always gets page text
    const expandedCalls = [];
    for (const tc of toolCalls) {
      expandedCalls.push(tc);
      if (tc.name === 'browser_navigate') {
        expandedCalls.push({ id: tc.id + '_snap', name: 'browser_snapshot', args: {} });
      }
    }

    for (const toolCall of expandedCalls) {
      try {
        console.log(`[Agent Web] Executing tool: "${toolCall.name}" with args:`, toolCall.args);
        
        if (!toolCall.name) {
          throw new Error('Tool name is empty');
        }
        
        // Find which server hosts this tool
        const allTools = window.mcpBrowserClient.getAllTools();
        const toolInfo = allTools.find(t => t.name === toolCall.name);
        
        if (!toolInfo) {
          throw new Error(`Tool '${toolCall.name}' not found in any connected MCP server`);
        }
        
        const result = await window.mcpBrowserClient.callTool(
          toolInfo.serverName,
          toolCall.name,
          toolCall.args
        );
        
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          result: result,
          success: true
        });
        
        console.log(`[Agent Web] Tool ${toolCall.name} succeeded:`, result);
      } catch (error) {
        console.error(`[Agent Web] Tool ${toolCall.name} failed:`, error);
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          error: error.message,
          success: false
        });
      }
    }
    
    return results;
  }
  
  // No MCP available
  console.error('[Agent] No MCP system available (not in Electron and no browser MCP client)');
  throw new Error('Tool execution not available - MCP not initialized');
}

/**
 * Build tool results message for conversation
 */
function buildToolResultsMessage(toolResults) {
  const toolResultsContent = toolResults.map(result => {
    if (result.success) {
      return `Tool: ${result.name}\nResult: ${JSON.stringify(result.result, null, 2)}`;
    } else {
      return `Tool: ${result.name}\nError: ${result.error}`;
    }
  }).join('\n\n');
  
  return `Tool execution results:\n\n${toolResultsContent}`;
}

function serializeToolResultForModel(result) {
  const compact = result.success
    ? { ok: true, result: sanitizeToolPayload(result.result) }
    : { ok: false, error: result.error || 'Unknown tool error' };

  let text;
  try {
    text = JSON.stringify(compact);
  } catch {
    text = JSON.stringify({ ok: false, error: 'Failed to serialize tool output' });
  }

  if (text.length <= TOOL_RESULT_CHAR_LIMIT) {
    return text;
  }

  return JSON.stringify({
    ok: compact.ok,
    truncated: true,
    note: `Tool output exceeded ${TOOL_RESULT_CHAR_LIMIT} chars and was truncated`,
    preview: text.slice(0, TOOL_RESULT_CHAR_LIMIT)
  });
}

function sanitizeToolPayload(payload) {
  if (payload == null) return payload;

  if (typeof payload === 'string') {
    return payload.length > TOOL_RESULT_CHAR_LIMIT ? payload.slice(0, TOOL_RESULT_CHAR_LIMIT) : payload;
  }

  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= TOOL_RESULT_CHAR_LIMIT) {
      return payload;
    }
    return {
      truncated: true,
      preview: serialized.slice(0, TOOL_RESULT_CHAR_LIMIT)
    };
  } catch {
    return { truncated: true, preview: String(payload).slice(0, TOOL_RESULT_CHAR_LIMIT) };
  }
}

/**
 * Build message array with optional vision image support
 */
async function buildMessages(conversationHistory, userMessage, uploadedFile = null) {
  const messages = conversationHistory.map(msg => ({
    role: msg.role,
    content: msg.content
  }));
  
  let userContent = userMessage;
  
  // If image is uploaded, create multimodal content for vision models
  if (uploadedFile && uploadedFile.type.startsWith('image/')) {
    // Vision image: create array content with text + image
    userContent = [
      {
        type: "text",
        text: userMessage
      }
    ];
    
    // Convert image to base64 data URI
    const base64 = await fileToBase64(uploadedFile);
    const mimeType = uploadedFile.type;
    
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${base64}`
      }
    });
    
    console.log(`[Agent] Vision request with image: ${uploadedFile.name}`);
  }
  
  messages.push({
    role: 'user',
    content: userContent
  });
  
  return messages;
}

/**
 * Handle document RAG chain through backend
 * For large PDFs, Word docs, etc. - uses semantic search via backend
 */
async function handleRagChain(userMessage, model, file, conversationHistory = [], sessionId = null) {
  try {
    console.log(`[Agent] RAG chain request with document: ${file.name}`);
    
    // Convert file to base64 for transmission
    const base64 = await fileToBase64(file);
    
    // Generate session ID if not provided
    if (!sessionId) {
      sessionId = `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // Build message history
    const messages = conversationHistory.length > 0 
      ? conversationHistory 
      : [{ role: 'user', content: userMessage }];
    
    const payload = {
      model: model,
      messages: messages,
      sessionId: sessionId,
      fileData: base64,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream'
    };
    
    const response = await fetch(RAG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`RAG Error: ${response.status} ${response.statusText}`);
    }
    
    // Backend returns streaming text (text/event-stream), not JSON
    // Read the entire stream as text
    const text = await response.text();
    return text;
  } catch (error) {
    console.error('[Agent] RAG chain call failed:', error);
    throw error;
  }
}

/**
 * Convert File to base64 string
 * @param {File} file - File to convert
 * @returns {Promise<string>} Base64 encoded file content
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Extract base64 string (remove data URI prefix)
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

