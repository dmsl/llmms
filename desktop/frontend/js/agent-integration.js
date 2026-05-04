/**
 * Unified agent integration layer with provider adapters.
 *
 * This module keeps the tool-execution loop local, while delegating
 * provider-specific request/response normalization to the adapter layer.
 */

import { getTimerManager } from './utils/timer-manager.js';
import {
  DEFAULT_PROVIDER_SETTINGS,
  detectProviderTypeFromBaseUrl,
  getProviderLabel,
  listProviderModels,
  normalizeProviderSettings,
  probeToolSupport,
  requestProviderCompletion
} from './llm-provider-adapters.js';
import {
  gatherEvidence,
  searchWikipedia,
  searchWikidata,
  searchCrossref,
  searchEuropePMC,
  searchGDELT,
  searchHN
} from './searchProviders.js';

const RAG_ENDPOINT = 'https://chatucy.cs.ucy.ac.cy/api/rag_chain';
const LLM_MAX_RETRIES = 2;
const TOOL_RESULT_CHAR_LIMIT = 8000;
const MODEL_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const MINI_SEARCH_MAX_STEPS = 2;
const MINI_SEARCH_TIMEOUT_MS = 9000;
const MINI_SEARCH_DEFAULT_LIMIT = 6;
const MINI_SEARCH_TOOL_REGEX = /<mini_tool>\s*([\s\S]*?)\s*<\/mini_tool>/i;

let modelCapabilityCache = new Map();
let modelCapabilityCacheLoadedAt = 0;
let modelCapabilityInFlight = null;

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

const BROWSER_SESSION_START_TOOL_PATTERNS = [
  /^browser_start(?:_|$)/i,
  /(?:^|_)start_session(?:_|$)/i,
  /(?:^|_)create_session(?:_|$)/i,
  /(?:^|_)new_context(?:_|$)/i,
  /(?:^|_)new_page(?:_|$)/i
];

const BROWSER_SESSION_STOP_TOOL_PATTERNS = [
  /^browser_close(?:_|$)/i,
  /(?:^|_)stop_session(?:_|$)/i,
  /(?:^|_)end_session(?:_|$)/i
];

function normalizeModelId(modelName) {
  return String(modelName || '').trim().toLowerCase();
}

function baseModelId(modelName) {
  return normalizeModelId(modelName).split(':')[0];
}

function inferToolsSupportFromModelName(modelName) {
  const normalized = normalizeModelId(modelName);
  if (!normalized) return false;

  const baseId = baseModelId(normalized);
  return TOOL_SUPPORTED_MODELS.some((supported) =>
    baseId.includes(supported.toLowerCase()) || supported.toLowerCase().includes(baseId)
  );
}

export function getProviderSettings() {
  const fromWindow = window.LLM_PROVIDER_SETTINGS;
  if (fromWindow) {
    return normalizeProviderSettings(fromWindow);
  }

  const raw = localStorage.getItem('llm_base_url_v1');
  if (!raw) {
    return normalizeProviderSettings(DEFAULT_PROVIDER_SETTINGS);
  }

  try {
    return normalizeProviderSettings(JSON.parse(raw));
  } catch {
    return normalizeProviderSettings({
      baseUrl: raw,
      providerType: detectProviderTypeFromBaseUrl(raw)
    });
  }
}

function getCapabilityCacheKey(modelName, settings = getProviderSettings()) {
  const base = String(settings.baseUrl || '').trim().toLowerCase();
  return `${settings.providerType}::${base}::${normalizeModelId(modelName)}`;
}

function getBaseCapabilityCacheKey(modelName, settings = getProviderSettings()) {
  const base = String(settings.baseUrl || '').trim().toLowerCase();
  return `${settings.providerType}::${base}::${baseModelId(modelName)}`;
}

function getCachedToolsCapability(modelName, settings = getProviderSettings()) {
  const exactKey = getCapabilityCacheKey(modelName, settings);
  if (modelCapabilityCache.has(exactKey)) {
    return !!modelCapabilityCache.get(exactKey);
  }

  const baseKey = getBaseCapabilityCacheKey(modelName, settings);
  if (modelCapabilityCache.has(baseKey)) {
    return !!modelCapabilityCache.get(baseKey);
  }

  return null;
}

export async function refreshModelToolCapabilities({ force = false } = {}) {
  const cacheFresh = Date.now() - modelCapabilityCacheLoadedAt < MODEL_CAPABILITY_CACHE_TTL_MS;
  if (!force && cacheFresh && modelCapabilityCache.size > 0) {
    return modelCapabilityCache;
  }

  if (!force && modelCapabilityInFlight) {
    return modelCapabilityInFlight;
  }

  modelCapabilityInFlight = (async () => {
    try {
      const models = await listProviderModels(getProviderSettings(), { force });
      for (const model of models) {
        if (typeof model?.toolSupport === 'boolean') {
          modelCapabilityCache.set(getCapabilityCacheKey(model.id), model.toolSupport);
          modelCapabilityCache.set(getBaseCapabilityCacheKey(model.id), model.toolSupport);
        }
      }
      modelCapabilityCacheLoadedAt = Date.now();
      return modelCapabilityCache;
    } finally {
      modelCapabilityInFlight = null;
    }
  })();

  return modelCapabilityInFlight;
}

export function supportsTools(modelName) {
  const cached = getCachedToolsCapability(modelName);
  if (cached !== null) {
    return cached;
  }
  return inferToolsSupportFromModelName(modelName);
}

export async function supportsToolsFromProvider(modelName) {
  const settings = getProviderSettings();
  const cached = getCachedToolsCapability(modelName, settings);
  if (cached !== null) {
    return cached;
  }

  await refreshModelToolCapabilities();
  const refreshed = getCachedToolsCapability(modelName, settings);
  if (refreshed !== null) {
    return refreshed;
  }

  const probed = await probeToolSupport(settings, modelName);
  modelCapabilityCache.set(getCapabilityCacheKey(modelName, settings), probed);
  modelCapabilityCache.set(getBaseCapabilityCacheKey(modelName, settings), probed);
  modelCapabilityCacheLoadedAt = Date.now();
  return probed;
}

export async function loadAvailableModels({ force = false } = {}) {
  const models = await listProviderModels(getProviderSettings(), { force });
  for (const model of models) {
    if (typeof model?.toolSupport === 'boolean') {
      modelCapabilityCache.set(getCapabilityCacheKey(model.id), model.toolSupport);
      modelCapabilityCache.set(getBaseCapabilityCacheKey(model.id), model.toolSupport);
    }
  }
  modelCapabilityCacheLoadedAt = Date.now();
  return models;
}

export function getActiveProviderLabel() {
  return getProviderLabel(getProviderSettings().providerType);
}

export async function askAgent(
  userMessage,
  toolSchemas = [],
  model = 'llama3.2',
  conversationHistory = [],
  uploadedFile = null,
  sessionId = null,
  mode = 'agent',
  handlers = {}
) {
  if (uploadedFile && !uploadedFile.type.startsWith('image/')) {
    return handleRagChain(userMessage, model, uploadedFile, conversationHistory, sessionId);
  }

  const modelSupportsTooling = await supportsToolsFromProvider(model);
  const hasAvailableTools = Array.isArray(toolSchemas) && toolSchemas.length > 0;
  const normalizedMode = mode === 'agent' ? 'agent' : 'ask';

  let messages = buildSteeringPrompts(normalizedMode, toolSchemas);
  messages = messages.concat(await buildMessages(conversationHistory, userMessage, uploadedFile));

  if (normalizedMode === 'ask' || !modelSupportsTooling || !hasAvailableTools) {
    return runMiniSearchLoop(messages, model, userMessage, {
      handlers,
      thinkingEnabled: handlers?.thinkingEnabled === true,
      thinkingSupported: handlers?.thinkingSupported === true
    });
  }

  let iterations = 0;
  const maxIterations = 20;
  let lastAssistantContent = '';

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await callLLM(messages, toolSchemas, model, modelSupportsTooling, {
      stream: false,
      handlers,
      thinkingEnabled: handlers?.thinkingEnabled === true,
      thinkingSupported: handlers?.thinkingSupported === true
    });
    const assistantMessage = getAssistantMessageFromResponse(response);
    const responseContent = assistantMessage?.content;
    if (typeof responseContent === 'string' && responseContent.trim()) {
      lastAssistantContent = stripToolTags(responseContent);
    }

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
      return {
        ...response,
        text: extractFinalContent(response)
      };
    }

    const toolResults = await executeTools(executionPlan, { alreadyPlanned: true });
    const assistantContent = stripToolTags(getMessageContentText(assistantMessage?.content));
    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: normalizedToolCalls
    });

    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.id,
        name: result.name,
        content: serializeToolResultForModel(result)
      });
    }
  }

  return {
    text: lastAssistantContent
      ? `${lastAssistantContent}\n\n(Note: Agent stopped after ${maxIterations} steps to avoid an infinite loop.)`
      : `Agent reached the safety limit (${maxIterations} steps) before finishing.`,
    toolCalls: [],
    finishReason: 'max_iterations'
  };
}

function buildMiniSearchInstruction() {
  return `You can optionally call mini search tools even when native function-calling is unavailable.

If you need fresh/external information, output ONLY one command in this exact format and nothing else:
<mini_tool>{"name":"search_web","arguments":{"query":"...","category":"general","providerBudget":4,"totalLimit":12}}</mini_tool>

Available mini search tools:
- search_web: federated web evidence across registered providers
- search_wikipedia: Wikipedia search
- search_wikidata: Wikidata entity search
- search_crossref: Crossref papers
- search_europepmc: Europe PMC papers
- search_gdelt: GDELT news
- search_hn: Hacker News

Rules:
- If no lookup is needed, answer normally.
- Keep arguments as a JSON object.
- When tool results are provided later, ground the final answer in those results and cite URLs when available.`;
}

function extractMiniToolCommand(text) {
  const raw = String(text || '');
  const match = raw.match(MINI_SEARCH_TOOL_REGEX);
  if (!match) return null;

  let payload = String(match[1] || '').trim();
  payload = payload.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload);
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const args = isPlainObject(parsed?.arguments) ? parsed.arguments : {};
    if (!name) return null;
    return { name, args };
  } catch {
    return null;
  }
}

function clampInteger(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeMiniSearchArgs(args, defaultQuery) {
  const sourceArgs = isPlainObject(args) ? args : {};
  const query = String(sourceArgs.query || defaultQuery || '').trim();
  return {
    query,
    category: typeof sourceArgs.category === 'string' ? sourceArgs.category.trim().toLowerCase() : undefined,
    providerBudget: clampInteger(sourceArgs.providerBudget, 4, 1, 6),
    totalLimit: clampInteger(sourceArgs.totalLimit, 12, 1, 20),
    limit: clampInteger(sourceArgs.limit, MINI_SEARCH_DEFAULT_LIMIT, 1, 12),
    timeoutMs: clampInteger(sourceArgs.timeoutMs, MINI_SEARCH_TIMEOUT_MS, 1000, 15000)
  };
}

async function executeMiniSearchCommand(command, defaultQuery) {
  const name = String(command?.name || '').trim().toLowerCase();
  const parsedArgs = normalizeMiniSearchArgs(command?.args, defaultQuery);
  if (!parsedArgs.query) {
    throw new Error('Mini search command requires a non-empty query');
  }

  if (name === 'search_web') {
    const bundle = await gatherEvidence(parsedArgs.query, {
      category: parsedArgs.category,
      providerBudget: parsedArgs.providerBudget,
      totalLimit: parsedArgs.totalLimit,
      timeoutMs: parsedArgs.timeoutMs
    });
    return {
      tool: name,
      query: parsedArgs.query,
      itemCount: Array.isArray(bundle?.items) ? bundle.items.length : 0,
      sources: Array.isArray(bundle?.sources)
        ? bundle.sources.map(src => ({
            id: src.id,
            label: src.label,
            ok: src.ok !== false,
            error: src.error || null
          }))
        : [],
      items: Array.isArray(bundle?.items) ? bundle.items.slice(0, parsedArgs.totalLimit) : [],
      generatedAt: bundle?.generatedAt || new Date().toISOString()
    };
  }

  const providerMap = {
    search_wikipedia: searchWikipedia,
    search_wikidata: searchWikidata,
    search_crossref: searchCrossref,
    search_europepmc: searchEuropePMC,
    search_gdelt: searchGDELT,
    search_hn: searchHN
  };

  const providerSearch = providerMap[name];
  if (!providerSearch) {
    throw new Error(`Unknown mini search tool: ${command?.name}`);
  }

  const items = await providerSearch(parsedArgs.query, {
    timeoutMs: parsedArgs.timeoutMs,
    limit: parsedArgs.limit
  });

  return {
    tool: name,
    query: parsedArgs.query,
    itemCount: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items.slice(0, parsedArgs.limit) : [],
    generatedAt: new Date().toISOString()
  };
}

async function runMiniSearchLoop(messages, model, userMessage, options = {}) {
  const runSimpleAskFallback = () =>
    callLLM(messages, [], model, false, {
      stream: true,
      handlers: options.handlers,
      thinkingEnabled: options.thinkingEnabled === true,
      thinkingSupported: options.thinkingSupported === true
    });

  try {
    const loopMessages = [
      ...messages,
      {
        role: 'developer',
        content: buildMiniSearchInstruction()
      }
    ];

    let lastResponse = null;
    let lastText = '';

    for (let step = 0; step < MINI_SEARCH_MAX_STEPS; step++) {
      const response = await callLLM(loopMessages, [], model, false, {
        stream: false,
        handlers: options.handlers,
        thinkingEnabled: options.thinkingEnabled === true,
        thinkingSupported: options.thinkingSupported === true
      });
      lastResponse = response;
      const assistantText = extractFinalContent(response);
      lastText = assistantText;
      const command = extractMiniToolCommand(assistantText);

      if (!command) {
        return {
          ...response,
          text: assistantText
        };
      }

      console.info('[MiniSearch] Mini API requested by model:', command.name, command.args || {});

      let toolPayload;
      try {
        toolPayload = await executeMiniSearchCommand(command, userMessage);
        console.info('[MiniSearch] Mini API call succeeded:', command.name, {
          items: Array.isArray(toolPayload?.items) ? toolPayload.items.length : 0
        });
      } catch (error) {
        console.warn('[MiniSearch] Mini API call failed; falling back to simple ask mode:', command.name, error);
        return runSimpleAskFallback();
      }

      loopMessages.push({
        role: 'assistant',
        content: assistantText
      });
      loopMessages.push({
        role: 'user',
        content: [
          'Mini tool result JSON:',
          JSON.stringify(toolPayload),
          'Now provide the best final answer for the original user request using this result.'
        ].join('\n')
      });
    }

    return {
      ...(lastResponse || {}),
      text: lastText || `Mini search loop stopped after ${MINI_SEARCH_MAX_STEPS} steps.`,
      finishReason: 'max_mini_search_steps'
    };
  } catch (error) {
    console.warn('[MiniSearch] Mini loop failed; falling back to simple ask mode:', error);
    return runSimpleAskFallback();
  }
}

function buildSteeringPrompts(mode, toolSchemas = []) {
  const prompts = [
    {
      role: 'system',
      content: 'You are a helpful AI assistant.'
    },
    {
      role: 'developer',
      content: 'Give clear, direct answers and ask brief follow-up questions only when necessary.'
    }
  ];

  if (mode !== 'agent') {
    return prompts;
  }

  let instructions = `You are a tool-using assistant. Use the available tools only when they are necessary to complete the user's request.

RULES:
- Do not mention tools that are unavailable.
- Prefer a direct answer when tools are not needed.
- If you use a tool, base your answer on the result and keep the final response concise.`;

  if (toolSchemas.length > 0) {
    instructions += `\n\nAvailable tools:\n${toolSchemas.map(tool => `- ${tool.name}: ${tool.description || 'No description'}`).join('\n')}`;
  }

  prompts.push({
    role: 'developer',
    content: instructions
  });

  return prompts;
}

async function buildMessages(conversationHistory, userMessage, uploadedFile = null) {
  const messages = conversationHistory.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  let userContent = userMessage;
  if (uploadedFile && uploadedFile.type.startsWith('image/')) {
    userContent = [{ type: 'text', text: userMessage }];
    const base64 = await fileToBase64(uploadedFile);
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${uploadedFile.type};base64,${base64}`
      }
    });
  }

  messages.push({
    role: 'user',
    content: userContent
  });

  return messages;
}

async function callLLM(messages, toolSchemas, model, allowTools = false, options = {}) {
  const timerMgr = getTimerManager('askAgent');
  const normalizedTools = toolSchemas.map(normalizeToolSchema).filter(Boolean);

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const response = await requestProviderCompletion(getProviderSettings(), {
        model,
        messages,
        toolSchemas: allowTools ? normalizedTools : [],
        allowTools,
        stream: !!options.stream,
        temperature: 0.7,
        thinkingEnabled: options.thinkingEnabled === true,
        thinkingSupported: options.thinkingSupported === true
      }, options.handlers);

      if (response && typeof response.text === 'string') {
        response.text = stripToolTags(response.text);
      }

      return response;
    } catch (error) {
      const isLastAttempt = attempt === LLM_MAX_RETRIES;
      const retryable = /network|fetch|timeout|503|502|gateway|temporar/i.test(String(error?.message || ''));
      if (isLastAttempt || !retryable) {
        if (typeof options?.handlers?.onEvent === 'function') {
          options.handlers.onEvent({
            type: 'error',
            error: String(error?.message || error)
          });
        }
        throw error;
      }

      const backoffMs = 400 * Math.pow(2, attempt);
      await new Promise(resolve => timerMgr.schedule(resolve, backoffMs));
    }
  }

  throw new Error('LLM call failed after all retries');
}

function extractFinalContent(response) {
  const message = getAssistantMessageFromResponse(response);
  const content = stripToolTags(getMessageContentText(message?.content || response?.text || ''));
  return content || 'I\'m ready to help! Feel free to ask me anything.';
}

function stripToolTags(text) {
  if (!text) return text;
  return text
    .replace(/<function=[^>]*>[\s\S]*?(?=<function=|$)/g, '')
    .replace(/<\/?tool_call>/g, '')
    .replace(/<parameter=[^>]*>/g, '')
    .trim();
}

function getAssistantMessageFromResponse(response) {
  if (response?.message && typeof response.message === 'object') {
    return {
      ...response.message,
      content: response.message.content ?? response.text ?? ''
    };
  }

  const fromChoices = response?.choices?.[0]?.message;
  if (fromChoices && typeof fromChoices === 'object') {
    return fromChoices;
  }

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
    content: response?.text || response?.output_text || '',
    tool_calls: response?.toolCalls || []
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
        if (typeof part?.text === 'string') return part.text;
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

  return {
    name,
    description: typeof (tool.description || tool.function?.description) === 'string' && (tool.description || tool.function?.description).trim()
      ? (tool.description || tool.function?.description).trim()
      : 'No description available',
    parameters
  };
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
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`[Agent] Failed to parse JSON arguments for ${toolName}:`, error);
    return {};
  }
}

function pruneArgsBySchema(args, schema) {
  if (!isPlainObject(args)) {
    return {};
  }

  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  if (Object.keys(properties).length === 0 || schema?.additionalProperties !== false) {
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

function extractToolCalls(response, toolSchemas = []) {
  const toolCalls = [];
  const message = response?.message || response?.choices?.[0]?.message;
  const allowedTools = new Map();
  const enforceAllowList = Array.isArray(toolSchemas) && toolSchemas.length > 0;

  for (const tool of toolSchemas || []) {
    const normalized = normalizeToolSchema(tool);
    if (normalized) {
      allowedTools.set(normalized.name, normalized);
    }
  }

  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    for (const [index, toolCall] of message.tool_calls.entries()) {
      const functionPayload = toolCall?.function || toolCall;
      const name = typeof functionPayload?.name === 'string' ? functionPayload.name.trim() : '';
      if (!name) continue;
      if (enforceAllowList && !allowedTools.has(name)) continue;

      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(functionPayload.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: toolCall.id || `tool_${index}`, name, args });
    }
  }

  if (message?.function_call && !toolCalls.length) {
    const name = message.function_call?.name;
    if (name && (!enforceAllowList || allowedTools.has(name))) {
      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(message.function_call.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: 'func_0', name, args });
    }
  }

  if (!toolCalls.length && Array.isArray(response?.toolCalls)) {
    for (const [index, item] of response.toolCalls.entries()) {
      const functionPayload = item?.function || item;
      const name = typeof functionPayload?.name === 'string' ? functionPayload.name.trim() : '';
      if (!name) continue;
      if (enforceAllowList && !allowedTools.has(name)) continue;

      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(functionPayload.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: item.id || `tool_${index}`, name, args });
    }
  }

  if (!toolCalls.length && Array.isArray(response?.output)) {
    const fnItems = response.output.filter(item => item?.type === 'function_call');
    for (const [index, item] of fnItems.entries()) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      if (enforceAllowList && !allowedTools.has(name)) continue;

      const toolDef = allowedTools.get(name);
      const parsedArgs = parseToolArguments(item.arguments, name);
      const args = toolDef ? pruneArgsBySchema(parsedArgs, toolDef.parameters) : parsedArgs;
      toolCalls.push({ id: item.call_id || item.id || `out_${index}`, name, args });
    }
  }

  return toolCalls;
}

async function executeTools(toolCalls, options = {}) {
  const { alreadyPlanned = false } = options;
  const results = [];
  const plannedCalls = alreadyPlanned ? (Array.isArray(toolCalls) ? toolCalls : []) : buildExecutionPlan(toolCalls);

  if (window.desktop?.isElectron) {
    if (!window.desktop?.mcpCall) {
      throw new Error('MCP tools not available');
    }

    for (const toolCall of plannedCalls) {
      try {
        const result = await window.desktop.mcpCall(toolCall.name, toolCall.args);

        if (isBrowserSessionStartTool(toolCall.name)) {
          dispatchBrowserSessionEvent('agent-browser-session-started', {
            toolName: toolCall.name,
            args: toolCall.args,
            mode: 'desktop'
          });
        }

        if (isBrowserSessionStopTool(toolCall.name)) {
          dispatchBrowserSessionEvent('agent-browser-session-stopped', {
            toolName: toolCall.name,
            args: toolCall.args,
            mode: 'desktop'
          });
        }

        results.push({
          id: toolCall.id,
          name: toolCall.name,
          result,
          success: true
        });
      } catch (error) {
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

  if (window.mcpBrowserClient) {
    for (const toolCall of plannedCalls) {
      try {
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

        if (isBrowserSessionStartTool(toolCall.name)) {
          dispatchBrowserSessionEvent('agent-browser-session-started', {
            toolName: toolCall.name,
            args: toolCall.args,
            serverName: toolInfo.serverName,
            mode: 'web'
          });
        }

        if (isBrowserSessionStopTool(toolCall.name)) {
          dispatchBrowserSessionEvent('agent-browser-session-stopped', {
            toolName: toolCall.name,
            args: toolCall.args,
            serverName: toolInfo.serverName,
            mode: 'web'
          });
        }

        results.push({
          id: toolCall.id,
          name: toolCall.name,
          result,
          success: true
        });
      } catch (error) {
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

  throw new Error('Tool execution not available - MCP not initialized');
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
    return {
      truncated: true,
      preview: String(payload).slice(0, TOOL_RESULT_CHAR_LIMIT)
    };
  }
}

function isBrowserSessionStartTool(toolName) {
  return typeof toolName === 'string' && BROWSER_SESSION_START_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

function isBrowserSessionStopTool(toolName) {
  return typeof toolName === 'string' && BROWSER_SESSION_STOP_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

function dispatchBrowserSessionEvent(eventName, detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

async function handleRagChain(userMessage, model, file, conversationHistory = [], sessionId = null) {
  const base64 = await fileToBase64(file);
  if (!sessionId) {
    sessionId = `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  const messages = conversationHistory.length > 0
    ? conversationHistory
    : [{ role: 'user', content: userMessage }];

  const response = await fetch(RAG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      sessionId,
      fileData: base64,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream'
    })
  });

  if (!response.ok) {
    throw new Error(`RAG Error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return {
    text,
    finishReason: 'completed',
    toolCalls: [],
    usage: null
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
