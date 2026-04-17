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
import { TimerManager, getTimerManager } from '../utils/timer-manager.js';

const DEFAULT_OLLAMA_BASE_URL = 'https://chatucy.cs.ucy.ac.cy/v1';
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
  console.log(`[Agent] Using frontend-only LLM path via ${resolveLLMApiUrl()}`);
  
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
      const assistantMessage = getAssistantMessageFromResponse(response);
      const responseContent = assistantMessage?.content;
      if (typeof responseContent === 'string' && responseContent.trim()) {
        lastAssistantContent = stripToolTags(responseContent);
      }
      
      // Check if LLM wants to use tools
      const toolCalls = extractToolCalls(response, toolSchemas);
      const executionPlan = buildExecutionPlan(toolCalls);
      const normalizedToolCalls = executionPlan.map((toolCall) => ({
        id: toolCall.id,
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
      console.log(`[Agent] Executing ${executionPlan.length} planned tool call(s)`);
      const toolResults = await executeTools(executionPlan, { alreadyPlanned: true });
      
      // Add assistant's tool use message to history
      // Strip raw tool tags so they don't confuse the model on the next turn
      const assistantContent = stripToolTags(getMessageContentText(assistantMessage?.content));
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

function resolveLLMApiUrl() {
  const candidates = [
    window.OLLAMA_BASE_URL,
    window.OLLAMA_API_URL,
    window.desktop?.ollamaBaseUrl,
    window.desktop?.ollamaApiUrl,
    localStorage.getItem('llm_base_url_v1'),
    localStorage.getItem('ollama_api_url'),
    localStorage.getItem('ollama_base_url'),
    localStorage.getItem('openai_api_url')
  ].filter(Boolean);

  const rawUrl = candidates.length > 0 ? String(candidates[0]).trim() : DEFAULT_OLLAMA_BASE_URL;
  if (!rawUrl) {
    return `${DEFAULT_OLLAMA_BASE_URL}/v1/chat/completions`;
  }

  if (/\/v1\/chat\/completions\/?$/i.test(rawUrl)) {
    return rawUrl.replace(/\/?$/, '');
  }

  const normalized = rawUrl.replace(/\/$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }

  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/v1/chat/completions`;
}

/**
 * Call the LLM server directly from the frontend.
 * This keeps ask/agent browser-first and removes the FastAPI hop.
 */
async function callLLM(messages, toolSchemas, model) {
  const llmApiUrl = resolveLLMApiUrl();
  const payload = {
    model,
    messages,
    stream: false,
    temperature: 0.7
  };

  // Format tools correctly for OpenAI-compatible API
  if (toolSchemas && toolSchemas.length > 0 && supportsTools(model)) {
    const validTools = toolSchemas
      .map(normalizeToolSchema)
      .filter(Boolean)
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          strict: isStrictSchemaCompatible(tool.parameters),
          parameters: tool.parameters
        }
      }));

    if (validTools.length > 0) {
      payload.tools = validTools;
      payload.tool_choice = 'auto';
      payload.parallel_tool_calls = false;
      console.log(`[Agent] Sending ${validTools.length} tools to LLM:`, validTools.map(t => t.function.name));
    } else {
      console.log('[Agent] No valid tool schemas found, proceeding without tools');
    }
  } else if (toolSchemas && toolSchemas.length > 0) {
    console.warn(`[Agent] Model '${model}' does not support tools, proceeding without them`);
  }

  // Get timer manager for LLM request lifecycle
  const timerMgr = getTimerManager('askAgent');

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = timerMgr.schedule(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(llmApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await parseResponseJsonSafe(response);

        const errorMessage = String(errorData?.error?.message || errorData?.message || '').toLowerCase();

        if (response.status === 400 && errorMessage.includes('does not support tools')) {
          console.warn('[Agent] Model does not support tools, retrying without tools');
          delete payload.tools;
          delete payload.tool_choice;
          delete payload.parallel_tool_calls;

          const retryResponse = await fetch(llmApiUrl, {
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

        if (response.status === 400 && payload.tools && errorMessage.includes('strict')) {
          console.warn('[Agent] Strict tool schema rejected, retrying with non-strict tool definitions');
          payload.tools = payload.tools.map(tool => ({
            ...tool,
            function: {
              ...tool.function,
              strict: false
            }
          }));

          const retryResponse = await fetch(llmApiUrl, {
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
          console.log('[Agent] LLM Response (non-strict tools):', JSON.stringify(retryResult, null, 2));
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
      await new Promise(resolve => timerMgr.schedule(resolve, backoffMs));
    } finally {
      timerMgr.clearTimeout(timeout);
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

function getAssistantMessageFromResponse(response) {
  const fromChoices = response?.choices?.[0]?.message;
  if (fromChoices && typeof fromChoices === 'object') {
    return fromChoices;
  }

  // Responses-style compatibility: synthesize a message with text and function tool calls.
  if (Array.isArray(response?.output)) {
    const fnCalls = response.output.filter(item => item?.type === 'function_call');
    const contentBlocks = response.output
      .filter(item => item?.type === 'message' && Array.isArray(item.content))
      .flatMap(item => item.content || []);

    const messageContent = contentBlocks
      .map(part => (part?.type === 'output_text' ? part?.text || '' : ''))
      .join('')
      .trim();

    return {
      content: messageContent || response.output_text || '',
      tool_calls: fnCalls.map((item, idx) => ({
        id: item.call_id || item.id || `out_${idx}`,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      }))
    };
  }

  return {
    content: response?.output_text || '',
    tool_calls: []
  };
}

function getMessageContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part?.text || '';
        if (part?.type === 'output_text') return part?.text || '';
        return '';
      })
      .join('')
      .trim();
  }

  if (content == null) {
    return '';
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function buildExecutionPlan(toolCalls) {
  const base = (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall, index) => ({
    id: toolCall?.id || `tool_${index}`,
    name: toolCall?.name,
    args: isPlainObject(toolCall?.args) ? toolCall.args : {}
  }));

  const hasBrowserToolCall = base.some(tc => typeof tc?.name === 'string' && tc.name.startsWith('browser_'));
  const plan = [];

  if (hasBrowserToolCall) {
    const hasNavigate = base.some(tc => tc.name === 'browser_navigate');
    const hasSnapshot = base.some(tc => tc.name === 'browser_snapshot');
    if (!hasNavigate && !hasSnapshot) {
      plan.push({ id: `prefetch_${Date.now()}`, name: 'browser_snapshot', args: {} });
    }
  }

  for (const tc of base) {
    plan.push(tc);
    if (tc.name === 'browser_navigate') {
      plan.push({ id: `${tc.id}_snap`, name: 'browser_snapshot', args: {} });
    }
  }

  return plan;
}

function normalizeToolSchema(tool) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const rawName = tool.name || tool.function?.name;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) {
    return null;
  }

  const rawSchema =
    tool.parameters ||
    tool.inputSchema ||
    tool.input_schema ||
    tool.function?.parameters ||
    tool.function?.input_schema ||
    {};

  const parameters = isPlainObject(rawSchema)
    ? { ...rawSchema }
    : { type: 'object', properties: {}, required: [] };

  if (!parameters.type && isPlainObject(parameters.properties)) {
    parameters.type = 'object';
  }

  if (parameters.type === 'object') {
    if (!isPlainObject(parameters.properties)) {
      parameters.properties = {};
    }

    if (!Array.isArray(parameters.required)) {
      parameters.required = [];
    }
  }

  // Standardized function schema shape for tool calling.
  return {
    name,
    description: typeof (tool.description || tool.function?.description) === 'string' && (tool.description || tool.function?.description).trim()
      ? (tool.description || tool.function?.description).trim()
      : 'No description available',
    parameters
  };
}

function isStrictSchemaCompatible(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema.type !== 'object') return false;
  if (!isPlainObject(schema.properties)) return false;
  if (!Array.isArray(schema.required)) return false;

  const propertyKeys = Object.keys(schema.properties);
  const requiredSet = new Set(schema.required.filter(k => typeof k === 'string'));
  const allRequired = propertyKeys.every(k => requiredSet.has(k));

  return allRequired && schema.additionalProperties === false;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseToolArguments(argsRaw, toolName) {
  if (isPlainObject(argsRaw)) {
    return argsRaw;
  }

  if (argsRaw == null || argsRaw === '') {
    return {};
  }

  if (typeof argsRaw !== 'string') {
    console.warn(`[Agent] Invalid arguments format for ${toolName}; defaulting to empty object`);
    return {};
  }

  try {
    const parsed = JSON.parse(argsRaw);
    if (isPlainObject(parsed)) {
      return parsed;
    }
    console.warn(`[Agent] Arguments for ${toolName} are not an object; defaulting to empty object`);
    return {};
  } catch (e) {
    console.warn(`[Agent] Failed to parse JSON arguments for ${toolName}:`, e);
    return {};
  }
}

function pruneArgsBySchema(args, schema) {
  if (!isPlainObject(args)) {
    return {};
  }

  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const hasProperties = Object.keys(properties).length > 0;
  const additionalProps = schema?.additionalProperties;

  // No explicit field map means we should not silently drop model-provided args.
  if (!hasProperties) {
    return args;
  }

  if (additionalProps !== false) {
    return args;
  }

  const pruned = {};
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      pruned[key] = args[key];
    }
  }
  return pruned;
}

/**
 * Extract tool calls from LLM response
 * Uses standardized OpenAI tool-call formats only.
 */
function extractToolCalls(response, toolSchemas = []) {
  const toolCalls = [];
  const message = response.choices?.[0]?.message;
  const allowedTools = new Map();
  const enforceAllowList = Array.isArray(toolSchemas) && toolSchemas.length > 0;

  for (const tool of toolSchemas || []) {
    const normalized = normalizeToolSchema(tool);
    if (normalized) {
      allowedTools.set(normalized.name, normalized);
    }
  }

  if (!message) {
    console.log('[Agent] No choices[0].message in response, trying alternative structured formats');
  } else {
    console.log('[Agent] Message structure:', {
      hasToolCalls: !!message.tool_calls,
      hasFunctionCall: !!message.function_call,
      hasContent: !!message.content
    });
  }

  // Format 1: OpenAI standard (tool_calls array)
  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    console.log(`[Agent] Found ${message.tool_calls.length} tool_calls in response`);

    for (const [index, toolCall] of message.tool_calls.entries()) {
      const functionPayload = toolCall?.function || toolCall;
      if (!functionPayload?.name) {
        continue;
      }

      const name = String(functionPayload.name).trim();
      if (enforceAllowList && !allowedTools.has(name)) {
        console.warn(`[Agent] Ignoring unregistered tool call: ${name}`);
        continue;
      }

      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(functionPayload.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: toolCall.id || `tool_${index}`, name, args });
    }
  }
  
  // Format 2: Legacy single function_call property (compat path)
  if (message?.function_call && !toolCalls.length) {
    const { name, arguments: argsString } = message.function_call;
    if (name && (!enforceAllowList || allowedTools.has(name))) {
      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(argsString, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      console.log(`[Agent] Extracted legacy function_call: ${name}`);
      toolCalls.push({ id: 'func_0', name, args });
    } else if (name) {
      console.warn(`[Agent] Ignoring unregistered legacy function_call: ${name}`);
    }
  }

  // Format 3: Responses API style output items with function_call
  if (!toolCalls.length && Array.isArray(response.output)) {
    const fnItems = response.output.filter(item => item?.type === 'function_call');
    for (const [index, item] of fnItems.entries()) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      if (enforceAllowList && !allowedTools.has(name)) {
        console.warn(`[Agent] Ignoring unregistered output function_call: ${name}`);
        continue;
      }

      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(item.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: item.call_id || item.id || `out_${index}`, name, args });
    }
  }

  return toolCalls;
}

/**
 * Execute tools by calling IPC (Electron) or browser MCP client (Web)
 */
async function executeTools(toolCalls, options = {}) {
  const { alreadyPlanned = false } = options;
  const results = [];

  const plannedCalls = alreadyPlanned ? (Array.isArray(toolCalls) ? toolCalls : []) : buildExecutionPlan(toolCalls);
  
  // Desktop mode: Use Electron IPC for local + remote MCP tools
  if (window.desktop?.isElectron) {
    if (!window.desktop?.mcpCall) {
      console.error('[Agent] mcpCall not available in desktop API');
      throw new Error('MCP tools not available');
    }

    for (const toolCall of plannedCalls) {
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
          error: String(error?.message || error),
          success: false
        });
      }
    }
    
    return results;
  }
  
  // Web mode: Use browser MCP client for remote-only MCP tools
  if (window.mcpBrowserClient) {
    for (const toolCall of plannedCalls) {
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
          error: String(error?.message || error),
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

