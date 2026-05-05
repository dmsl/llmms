const PROVIDER_TYPES = Object.freeze({
  OPENAI: 'openai-compatible',
  OLLAMA: 'ollama',
  ANTHROPIC: 'anthropic-compatible'
});

const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
  providerType: PROVIDER_TYPES.OPENAI,
  baseUrl: 'https://chatucy.cs.ucy.ac.cy',
  authToken: '',
  anthropicVersion: '2023-06-01'
});

const MODEL_LIST_CACHE_TTL_MS = 60 * 1000;
const OLLAMA_SHOW_CACHE_PREFIX = 'chatucy:ollama-show-cache:';
const modelListCache = new Map();
const toolProbeCache = new Map();

const TEXT_DECODER = new TextDecoder();

export {
  PROVIDER_TYPES,
  DEFAULT_PROVIDER_SETTINGS
};

export async function detectProviderProfile(rawSettings = {}) {
  const settings = normalizeProviderSettings(rawSettings);
  const heuristicType = detectProviderTypeFromBaseUrl(settings.baseUrl);
  const supportedTypes = [];

  if (await probeOpenAIProvider(settings)) {
    supportedTypes.push(PROVIDER_TYPES.OPENAI);
  }

  if (shouldProbeAnthropicProvider(settings, heuristicType) && await probeAnthropicProvider(settings)) {
    supportedTypes.push(PROVIDER_TYPES.ANTHROPIC);
  }

  if (await probeOllamaProvider(settings)) {
    supportedTypes.push(PROVIDER_TYPES.OLLAMA);
  }

  const providerType = supportedTypes.includes(PROVIDER_TYPES.OPENAI)
    ? PROVIDER_TYPES.OPENAI
    : supportedTypes.includes(PROVIDER_TYPES.ANTHROPIC)
      ? PROVIDER_TYPES.ANTHROPIC
      : supportedTypes.includes(PROVIDER_TYPES.OLLAMA)
        ? PROVIDER_TYPES.OLLAMA
        : heuristicType;

  return {
    providerType,
    supportedTypes,
    source: supportedTypes.length > 0 ? 'probe' : 'heuristic'
  };
}

export function normalizeProviderSettings(rawSettings = {}) {
  if (typeof rawSettings === 'string') {
    rawSettings = { baseUrl: rawSettings };
  }

  const providerType = normalizeProviderType(rawSettings.providerType || rawSettings.type || detectProviderTypeFromBaseUrl(rawSettings.baseUrl || DEFAULT_PROVIDER_SETTINGS.baseUrl));
  const baseUrl = canonicalizeProviderBaseUrl(
    String(rawSettings.baseUrl || DEFAULT_PROVIDER_SETTINGS.baseUrl).trim() || DEFAULT_PROVIDER_SETTINGS.baseUrl,
    providerType
  );

  return {
    providerType,
    baseUrl,
    authToken: String(rawSettings.authToken || '').trim(),
    anthropicVersion: String(rawSettings.anthropicVersion || DEFAULT_PROVIDER_SETTINGS.anthropicVersion).trim() || DEFAULT_PROVIDER_SETTINGS.anthropicVersion
  };
}

export function detectProviderTypeFromBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_PROVIDER_SETTINGS.providerType;

  if (normalized.includes('anthropic')) {
    return PROVIDER_TYPES.ANTHROPIC;
  }

  if (normalized.includes('/ollama/api') || normalized.includes(':11434') || normalized.endsWith('/api')) {
    return PROVIDER_TYPES.OLLAMA;
  }

  return PROVIDER_TYPES.OPENAI;
}

export function getProviderLabel(providerType) {
  switch (normalizeProviderType(providerType)) {
    case PROVIDER_TYPES.OLLAMA:
      return 'Ollama';
    case PROVIDER_TYPES.ANTHROPIC:
      return 'Anthropic-Compatible';
    default:
      return 'OpenAI-Compatible';
  }
}

export async function listProviderModels(rawSettings = {}, { force = false } = {}) {
  const settings = normalizeProviderSettings(rawSettings);
  const cacheKey = getProfileCacheKey(settings);
  const cached = modelListCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.loadedAt < MODEL_LIST_CACHE_TTL_MS) {
    return cached.models;
  }

  let models;
  switch (settings.providerType) {
    case PROVIDER_TYPES.OLLAMA:
      models = await listOllamaModels(settings);
      break;
    case PROVIDER_TYPES.ANTHROPIC:
      models = await listAnthropicModels(settings);
      break;
    default:
      models = await listOpenAICompatibleModels(settings);
      break;
  }

  modelListCache.set(cacheKey, {
    loadedAt: Date.now(),
    models
  });

  return models;
}

export async function probeToolSupport(rawSettings = {}, modelId) {
  const settings = normalizeProviderSettings(rawSettings);
  const cacheKey = `${getProfileCacheKey(settings)}::${String(modelId || '').trim().toLowerCase()}`;
  if (toolProbeCache.has(cacheKey)) {
    return toolProbeCache.get(cacheKey);
  }

  let supported = false;
  try {
    switch (settings.providerType) {
      case PROVIDER_TYPES.OLLAMA:
        supported = await probeOllamaToolSupport(settings, modelId);
        break;
      case PROVIDER_TYPES.ANTHROPIC:
        supported = await probeAnthropicToolSupport(settings, modelId);
        break;
      default:
        supported = await probeOpenAIToolSupport(settings, modelId);
        break;
    }
  } catch (error) {
    console.warn(`[Provider] Tool support probe failed for ${modelId}:`, error);
    supported = false;
  }

  toolProbeCache.set(cacheKey, supported);
  return supported;
}

export async function requestProviderCompletion(rawSettings = {}, request, handlers = {}) {
  const settings = normalizeProviderSettings(rawSettings);
  switch (settings.providerType) {
    case PROVIDER_TYPES.OLLAMA:
      return requestOllamaCompletion(settings, request, handlers);
    case PROVIDER_TYPES.ANTHROPIC:
      return requestAnthropicCompletion(settings, request, handlers);
    default:
      return requestOpenAICompatibleCompletion(settings, request, handlers);
  }
}

function normalizeProviderType(providerType) {
  const value = String(providerType || '').trim().toLowerCase();
  if (value === PROVIDER_TYPES.OLLAMA) return PROVIDER_TYPES.OLLAMA;
  if (value === PROVIDER_TYPES.ANTHROPIC) return PROVIDER_TYPES.ANTHROPIC;
  return PROVIDER_TYPES.OPENAI;
}

function canonicalizeProviderBaseUrl(baseUrl, providerType) {
  const normalized = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!normalized) {
    return DEFAULT_PROVIDER_SETTINGS.baseUrl;
  }

  if (providerType === PROVIDER_TYPES.OLLAMA) {
    return normalized
      .replace(/\/ollama\/api(?:\/.*)?$/i, '')
      .replace(/\/api(?:\/chat|\/tags|\/show)?$/i, '');
  }

  if (providerType === PROVIDER_TYPES.ANTHROPIC) {
    return normalized
      .replace(/\/v1\/messages$/i, '')
      .replace(/\/v1\/models$/i, '')
      .replace(/\/v1$/i, '');
  }

  return normalized
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1$/i, '');
}

function getProfileCacheKey(settings) {
  return `${settings.providerType}::${String(settings.baseUrl || '').trim().toLowerCase()}`;
}

function getOllamaShowStorageKey(settings) {
  return `${OLLAMA_SHOW_CACHE_PREFIX}${getProfileCacheKey(settings)}`;
}

function canUseLocalStorage() {
  try {
    return typeof globalThis !== 'undefined' && !!globalThis.localStorage;
  } catch (error) {
    return false;
  }
}

function loadOllamaShowCache(settings) {
  if (!canUseLocalStorage()) {
    return {};
  }

  try {
    const raw = globalThis.localStorage.getItem(getOllamaShowStorageKey(settings));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object'
      ? parsed.models
      : {};
  } catch (error) {
    return {};
  }
}

function saveOllamaShowCache(settings, cache) {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    globalThis.localStorage.setItem(
      getOllamaShowStorageKey(settings),
      JSON.stringify({
        updatedAt: Date.now(),
        models: cache
      })
    );
  } catch (error) {
    // Ignore storage quota/privacy failures.
  }
}

function pruneOllamaShowCache(cache, remoteModelIds) {
  const next = {};
  const allowed = new Set((remoteModelIds || []).map(id => String(id || '').trim().toLowerCase()).filter(Boolean));
  for (const [modelId, value] of Object.entries(cache || {})) {
    if (allowed.has(String(modelId || '').trim().toLowerCase())) {
      next[modelId] = value;
    }
  }
  return next;
}

function buildHeaders(settings, extraHeaders = {}) {
  const headers = { ...extraHeaders };

  if (settings.providerType === PROVIDER_TYPES.ANTHROPIC) {
    headers['anthropic-version'] = settings.anthropicVersion;
    if (settings.authToken) {
      headers['x-api-key'] = settings.authToken;
    }
  } else if (settings.authToken) {
    headers.Authorization = `Bearer ${settings.authToken}`;
  }

  return headers;
}

function buildBrowserSafeJsonPostHeaders(settings, extraHeaders = {}) {
  const headers = { ...extraHeaders };

  if (settings.providerType === PROVIDER_TYPES.ANTHROPIC) {
    headers['anthropic-version'] = settings.anthropicVersion;
    if (settings.authToken) {
      headers['x-api-key'] = settings.authToken;
    }
  } else if (settings.authToken) {
    headers.Authorization = `Bearer ${settings.authToken}`;
  }

  return headers;
}

function shouldProbeAnthropicProvider(settings, heuristicType = detectProviderTypeFromBaseUrl(settings?.baseUrl)) {
  const normalized = String(settings?.baseUrl || '').trim().toLowerCase();
  if (!normalized) return false;

  return heuristicType === PROVIDER_TYPES.ANTHROPIC ||
    normalized.includes('anthropic') ||
    normalized.includes('claude') ||
    normalized.includes('/messages');
}

async function probeOpenAIProvider(settings) {
  const url = resolveOpenAIModelsUrl(settings.baseUrl);
  const result = await probeProviderEndpoint(url, {
    headers: buildHeaders({ ...settings, providerType: PROVIDER_TYPES.OPENAI }, { Accept: 'application/json' }),
    validate: (response, body) => {
      if (response.ok) {
        return Array.isArray(body?.data);
      }
      return false;
    }
  });
  return result.ok;
}

async function probeAnthropicProvider(settings) {
  const url = resolveAnthropicModelsUrl(settings.baseUrl);
  const result = await probeProviderEndpoint(url, {
    headers: buildHeaders({ ...settings, providerType: PROVIDER_TYPES.ANTHROPIC }, { Accept: 'application/json' }),
    validate: (response, body) => {
      if (!response.ok) {
        return false;
      }
      return Array.isArray(body?.data) && body.data.some(item =>
        item?.type === 'model' || typeof item?.display_name === 'string'
      );
    }
  });
  return result.ok;
}

async function probeOllamaProvider(settings) {
  const candidateUrls = resolveOllamaApiCandidateUrls(settings.baseUrl, 'tags');
  for (const url of candidateUrls) {
    const result = await probeProviderEndpoint(url, {
      headers: buildHeaders({ ...settings, providerType: PROVIDER_TYPES.OPENAI }, { Accept: 'application/json' }),
      validate: (response, body) => {
        if (!response.ok) {
          return false;
        }
        return Array.isArray(body?.models) || Array.isArray(body?.data);
      }
    });
    if (result.ok) {
      return true;
    }
  }
  return false;
}

async function probeProviderEndpoint(url, { headers = {}, validate } = {}) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let body = null;
    if (contentType.includes('application/json')) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    return {
      ok: typeof validate === 'function' ? validate(response, body, contentType) : response.ok,
      response,
      body
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

function formatModelName(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return 'Unknown Model';

  const [name, version] = raw.split(':');
  const base = name
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  if (version && version !== 'latest') {
    return `${base} (${version})`;
  }

  return base;
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function inferVisionCapability(descriptor, modelId) {
  const capabilityList = normalizeCapabilityList(descriptor?.capabilities);
  if (capabilityList.includes('vision')) {
    return true;
  }

  const modalities = [
    ...(Array.isArray(descriptor?.input_modalities) ? descriptor.input_modalities : []),
    ...(Array.isArray(descriptor?.modalities) ? descriptor.modalities : [])
  ].map(item => String(item || '').toLowerCase());

  if (modalities.includes('image')) {
    return true;
  }

  const id = String(modelId || '').toLowerCase();
  return id.includes('vision') || id.includes('vl') || id.includes('llava');
}

function inferThinkingCapability(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.includes('reason') || id.includes('deepseek-r1') || id.includes('qwq') || id.includes('o1');
}

function inferThinkingCapabilityFromDescriptor(descriptor, modelId) {
  const capabilityList = normalizeCapabilityList(descriptor?.capabilities);
  if (capabilityList.includes('thinking') || capabilityList.includes('reasoning')) {
    return true;
  }
  return inferThinkingCapability(modelId);
}

function inferEmbeddingModelByName(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.includes('embed') ||
    id.includes('embedding') ||
    id.startsWith('bge') ||
    id.includes('bge-') ||
    id.includes('e5-') ||
    id === 'e5' ||
    id.includes('nomic-embed') ||
    id.includes('text-embedding') ||
    id.includes('snowflake-arctic-embed') ||
    id.includes('mxbai-embed');
}

function inferChatCapability(descriptor, modelId) {
  const capabilityList = normalizeCapabilityList(descriptor?.capabilities);
  if (capabilityList.includes('completion') || capabilityList.includes('chat')) {
    return true;
  }
  if (capabilityList.includes('embedding') || capabilityList.includes('embeddings')) {
    return false;
  }
  return !inferEmbeddingModelByName(modelId);
}

function normalizeCapabilityList(capabilities) {
  if (Array.isArray(capabilities)) {
    return capabilities.map(item => String(item || '').toLowerCase());
  }
  if (capabilities && typeof capabilities === 'object') {
    return Object.entries(capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => String(name || '').toLowerCase());
  }
  return [];
}

function extractOllamaModelInfoValue(showPayload, suffixes) {
  const modelInfo = showPayload?.model_info;
  if (!modelInfo || typeof modelInfo !== 'object') return null;

  const normalizedSuffixes = suffixes.map(suffix => String(suffix || '').toLowerCase());
  for (const [key, value] of Object.entries(modelInfo)) {
    const normalizedKey = String(key || '').toLowerCase();
    if (normalizedSuffixes.some(suffix => normalizedKey.endsWith(suffix))) {
      return value;
    }
  }
  return null;
}

function parseSerializedParameter(parametersText, name) {
  if (typeof parametersText !== 'string' || !parametersText.trim()) return null;
  const pattern = new RegExp(`(?:^|\\n)\\s*${name}\\s+([^\\n]+)`, 'i');
  const match = parametersText.match(pattern);
  return match ? match[1].trim() : null;
}

function getOllamaContextWindow(showPayload) {
  return normalizeNumber(
    showPayload?.details?.context_length ??
    extractOllamaModelInfoValue(showPayload, ['.context_length']) ??
    parseSerializedParameter(showPayload?.parameters, 'num_ctx')
  );
}

function getOllamaMaxOutputTokens(showPayload) {
  return normalizeNumber(
    showPayload?.details?.num_predict ??
    extractOllamaModelInfoValue(showPayload, ['.max_output_tokens', '.max_tokens']) ??
    parseSerializedParameter(showPayload?.parameters, 'num_predict')
  );
}

function inferOllamaVisionCapability(showPayload, fallbackDescriptor, modelId) {
  const capabilityList = normalizeCapabilityList(showPayload?.capabilities);
  if (capabilityList.includes('vision')) {
    return true;
  }

  const modelInfo = showPayload?.model_info;
  if (modelInfo && typeof modelInfo === 'object') {
    const keys = Object.keys(modelInfo).map(key => String(key || '').toLowerCase());
    if (keys.some(key => key.includes('.vision.') || key.endsWith('.mm.tokens_per_image'))) {
      return true;
    }
  }

  return inferVisionCapability(showPayload || fallbackDescriptor, modelId);
}

function inferOllamaToolSupport(showPayload) {
  const capabilityList = normalizeCapabilityList(showPayload?.capabilities);
  if (capabilityList.some(item => item === 'tools' || item === 'tool' || item === 'tool_use' || item === 'function_calling')) {
    return true;
  }
  if (capabilityList.length > 0) {
    return false;
  }
  return null;
}

function inferOllamaThinkingCapability(showPayload, modelId) {
  const capabilityList = normalizeCapabilityList(showPayload?.capabilities);
  if (capabilityList.includes('reasoning') || capabilityList.includes('thinking')) {
    return true;
  }
  return inferThinkingCapability(modelId);
}

function inferOllamaEmbeddingCapability(showPayload, modelId) {
  const capabilityList = normalizeCapabilityList(showPayload?.capabilities);
  if (capabilityList.includes('completion') || capabilityList.includes('chat')) {
    return false;
  }
  if (capabilityList.includes('embedding') || capabilityList.includes('embeddings')) {
    return true;
  }

  const detailsFamilies = [
    showPayload?.details?.family,
    ...(Array.isArray(showPayload?.details?.families) ? showPayload.details.families : [])
  ]
    .map(item => String(item || '').toLowerCase())
    .filter(Boolean);

  if (detailsFamilies.some(family => family.includes('bert') || family.includes('embed'))) {
    return true;
  }

  const architecture = String(showPayload?.model_info?.['general.architecture'] || '').toLowerCase();
  if (architecture.includes('bert') || architecture.includes('embed')) {
    return true;
  }

  const tokenizerModel = String(showPayload?.model_info?.['tokenizer.ggml.model'] || '').toLowerCase();
  if (tokenizerModel === 'bert') {
    return true;
  }

  const causalAttention = extractOllamaModelInfoValue(showPayload, ['.attention.causal']);
  if (causalAttention === false) {
    return true;
  }

  return inferEmbeddingModelByName(modelId);
}

function buildOllamaShowMetadata(showPayload, modelId, baseModel = {}) {
  const capabilityList = normalizeCapabilityList(showPayload?.capabilities);
  const embedding = inferOllamaEmbeddingCapability(showPayload, modelId);
  const toolSupport = inferOllamaToolSupport(showPayload);
  const contextWindow = getOllamaContextWindow(showPayload);
  const maxOutputTokens = getOllamaMaxOutputTokens(showPayload);

  return {
    contextWindow,
    maxOutputTokens,
    metadataVerified: contextWindow !== null || maxOutputTokens !== null,
    metadataTrust: contextWindow !== null || maxOutputTokens !== null ? 'verified' : 'unknown',
    toolSupport,
    toolSupportProvenance: toolSupport === null ? 'unknown' : 'verified',
    tools: toolSupport === true,
    embedding,
    chatCapable: capabilityList.includes('completion') || capabilityList.includes('chat')
      ? true
      : capabilityList.length > 0
        ? !embedding
        : (typeof baseModel.chatCapable === 'boolean' ? baseModel.chatCapable : !embedding),
    vision: inferOllamaVisionCapability(showPayload, baseModel, modelId),
    thinking: inferOllamaThinkingCapability(showPayload, modelId)
  };
}

function applyOllamaShowMetadata(model, metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return model;
  }

  return {
    ...model,
    contextWindow: metadata.contextWindow ?? model.contextWindow ?? null,
    maxOutputTokens: metadata.maxOutputTokens ?? model.maxOutputTokens ?? null,
    metadataVerified: metadata.metadataVerified === true || model.metadataVerified === true,
    metadataTrust: metadata.metadataTrust || model.metadataTrust,
    toolSupport: typeof metadata.toolSupport === 'boolean' || metadata.toolSupport === null
      ? metadata.toolSupport
      : model.toolSupport,
    toolSupportProvenance: metadata.toolSupportProvenance || model.toolSupportProvenance,
    tools: metadata.tools === true || model.tools === true,
    embedding: metadata.embedding === true,
    chatCapable: typeof metadata.chatCapable === 'boolean' ? metadata.chatCapable : model.chatCapable,
    vision: metadata.vision === true || model.vision === true,
    thinking: metadata.thinking === true || model.thinking === true
  };
}

async function fetchOllamaShowMetadata(settings, urls, modelId, baseModel = {}) {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildBrowserSafeJsonPostHeaders(settings, { Accept: 'application/json' }),
        body: JSON.stringify({ model: modelId, verbose: false })
      });
      if (!response.ok) {
        continue;
      }

      const showPayload = await response.json();
      return buildOllamaShowMetadata(showPayload, modelId, baseModel);
    } catch (error) {
      continue;
    }
  }

  return null;
}

function normalizeOpenAICompatibleDescriptor(settings, descriptor) {
  const modelId = descriptor?.id || descriptor?.name || descriptor?.model;
  const capabilityList = normalizeCapabilityList(descriptor?.capabilities);
  const contextWindow = normalizeNumber(
    descriptor?.context_window ??
    descriptor?.contextWindow ??
    descriptor?.context_length ??
    descriptor?.contextLength
  );
  const maxOutputTokens = normalizeNumber(
    descriptor?.max_output_tokens ??
    descriptor?.maxOutputTokens ??
    descriptor?.max_completion_tokens ??
    descriptor?.maxCompletionTokens
  );
  const knowledgeCutoff = descriptor?.knowledge_cutoff || descriptor?.knowledgeCutoff || null;
  const supportedParams = Array.isArray(descriptor?.supported_parameters)
    ? descriptor.supported_parameters.map(item => String(item || '').toLowerCase())
    : Array.isArray(descriptor?.supportedParameters)
      ? descriptor.supportedParameters.map(item => String(item || '').toLowerCase())
      : [];

  let toolSupport = null;
  if (typeof descriptor?.tools === 'boolean') {
    toolSupport = descriptor.tools;
  } else if (typeof descriptor?.supports_tools === 'boolean') {
    toolSupport = descriptor.supports_tools;
  } else if (typeof descriptor?.supportsTools === 'boolean') {
    toolSupport = descriptor.supportsTools;
  } else if (capabilityList.includes('tools') || capabilityList.includes('tool') || capabilityList.includes('tool_use') || capabilityList.includes('function_calling')) {
    toolSupport = true;
  } else if (supportedParams.includes('tools') || supportedParams.includes('tool_choice') || supportedParams.includes('function_call')) {
    toolSupport = true;
  }

  const streamingSupport = descriptor?.streaming === true
    ? true
    : supportedParams.includes('stream')
      ? true
      : true;
  const embedding = inferEmbeddingModelByName(modelId);
  const chatCapable = inferChatCapability(descriptor, modelId);

  return {
    id: String(modelId || ''),
    displayName: formatModelName(modelId),
    providerType: settings.providerType,
    providerLabel: getProviderLabel(settings.providerType),
    providerSource: settings.providerType,
    contextWindow,
    maxOutputTokens,
    knowledgeCutoff,
    metadataVerified: contextWindow !== null || maxOutputTokens !== null || !!knowledgeCutoff,
    metadataTrust: contextWindow !== null || maxOutputTokens !== null || !!knowledgeCutoff ? 'verified' : 'unknown',
    toolSupport,
    toolSupportProvenance: toolSupport === null ? 'unknown' : 'verified',
    tools: toolSupport === true,
    supportsStreaming: streamingSupport,
    embedding,
    chatCapable,
    vision: inferVisionCapability(descriptor, modelId),
    thinking: inferThinkingCapabilityFromDescriptor(descriptor, modelId)
  };
}

async function listOpenAICompatibleModels(settings) {
  const url = resolveOpenAIModelsUrl(settings.baseUrl);
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(settings, { Accept: 'application/json' })
  });
  if (!response.ok) {
    throw new Error(`Failed to load models: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  const models = entries
    .map(entry => normalizeOpenAICompatibleDescriptor(settings, entry))
    .filter(entry => !!entry.id);

  return enrichModelsFromOllamaShow(settings, models);
}

async function listAnthropicModels(settings) {
  const response = await fetch(resolveAnthropicModelsUrl(settings.baseUrl), {
    method: 'GET',
    headers: buildHeaders(settings, { Accept: 'application/json' })
  });
  if (!response.ok) {
    throw new Error(`Failed to load Anthropic models: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  return entries.map(entry => {
    const modelId = entry?.id || entry?.name;
    const embedding = inferEmbeddingModelByName(modelId);
    return {
      id: String(modelId || ''),
      displayName: entry?.display_name || entry?.displayName || formatModelName(modelId),
      providerType: settings.providerType,
      providerLabel: getProviderLabel(settings.providerType),
      providerSource: settings.providerType,
      contextWindow: null,
      maxOutputTokens: null,
      knowledgeCutoff: null,
      metadataVerified: false,
      metadataTrust: 'unknown',
      toolSupport: null,
      toolSupportProvenance: 'unknown',
      tools: false,
      supportsStreaming: true,
      embedding,
      chatCapable: !embedding,
      vision: false,
      thinking: inferThinkingCapability(modelId)
    };
  }).filter(entry => !!entry.id);
}

async function enrichModelsFromOllamaShow(settings, models) {
  if (!Array.isArray(models) || models.length === 0) {
    return models;
  }

  const candidateUrls = resolveOllamaApiCandidateUrls(settings.baseUrl, 'show');
  if (candidateUrls.length === 0) {
    return models;
  }

  let cache = pruneOllamaShowCache(
    loadOllamaShowCache(settings),
    models.map(model => model.id)
  );

  const enriched = [];
  for (const model of models) {
    const cacheKey = String(model.id || '').trim().toLowerCase();
    let metadata = cache[cacheKey] || null;
    if (!metadata) {
      metadata = await fetchOllamaShowMetadata(settings, candidateUrls, model.id, model);
      if (metadata) {
        cache[cacheKey] = metadata;
      }
    }

    enriched.push(applyOllamaShowMetadata(model, metadata));
  }

  saveOllamaShowCache(settings, cache);
  return enriched;
}

async function listOllamaModels(settings) {
  try {
    const tagsResponse = await fetch(resolveOllamaApiUrl(settings.baseUrl, 'tags'), {
      method: 'GET',
      headers: buildHeaders(settings, { Accept: 'application/json' })
    });
    if (!tagsResponse.ok) {
      throw new Error(`Failed to load Ollama tags: ${tagsResponse.status} ${tagsResponse.statusText}`);
    }

    const tagsPayload = await tagsResponse.json();
    const entries = Array.isArray(tagsPayload?.models) ? tagsPayload.models : [];
    const remoteModelIds = entries
      .map(entry => entry?.name || entry?.model || entry?.id)
      .filter(Boolean);
    let cache = pruneOllamaShowCache(loadOllamaShowCache(settings), remoteModelIds);
    const showUrl = resolveOllamaApiUrl(settings.baseUrl, 'show');

    const models = [];
    for (const entry of entries) {
      const modelId = entry?.name || entry?.model || entry?.id;
      if (!modelId) continue;

      const baseModel = {
        id: String(modelId),
        displayName: formatModelName(modelId),
        providerType: settings.providerType,
        providerLabel: getProviderLabel(settings.providerType),
        providerSource: settings.providerType,
        contextWindow: null,
        maxOutputTokens: null,
        knowledgeCutoff: null,
        metadataVerified: false,
        metadataTrust: 'unknown',
        toolSupport: null,
        toolSupportProvenance: 'unknown',
        tools: false,
        supportsStreaming: true,
        embedding: inferEmbeddingModelByName(modelId),
        chatCapable: !inferEmbeddingModelByName(modelId),
        vision: false,
        thinking: inferThinkingCapability(modelId)
      };

      const cacheKey = String(modelId || '').trim().toLowerCase();
      let metadata = cache[cacheKey] || null;
      if (!metadata) {
        metadata = await fetchOllamaShowMetadata(settings, [showUrl], modelId, baseModel);
        if (metadata) {
          cache[cacheKey] = metadata;
        } else {
          console.warn(`[Provider] Failed to inspect Ollama model ${modelId}; using fallback metadata.`);
        }
      }

      models.push(applyOllamaShowMetadata(baseModel, metadata));
    }

    saveOllamaShowCache(settings, cache);
    return models;
  } catch (error) {
    console.warn('[Provider] Ollama native model discovery failed; falling back to OpenAI-compatible /v1/models:', error);
    return listOpenAICompatibleModels({
      ...settings,
      providerType: PROVIDER_TYPES.OLLAMA
    });
  }
}

async function probeOpenAIToolSupport(settings, modelId) {
  const url = resolveOpenAIChatUrl(settings.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(settings, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Compatibility probe. Use the provided tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'compatibility_probe',
            description: 'Compatibility probe tool',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'compatibility_probe' }
      },
      max_tokens: 16,
      stream: false,
      temperature: 0
    })
  });

  if (!response.ok) {
    return false;
  }

  const payload = await response.json();
  return !!payload?.choices?.[0]?.message?.tool_calls?.length;
}

async function probeAnthropicToolSupport(settings, modelId) {
  const response = await fetch(resolveAnthropicMessagesUrl(settings.baseUrl), {
    method: 'POST',
    headers: buildHeaders(settings, {
      'Content-Type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'false'
    }),
    body: JSON.stringify({
      model: modelId,
      max_tokens: 32,
      system: 'Compatibility probe.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Use the provided tool.' }]
        }
      ],
      tools: [
        {
          name: 'compatibility_probe',
          description: 'Compatibility probe tool',
          input_schema: {
            type: 'object',
            properties: {}
          }
        }
      ],
      tool_choice: {
        type: 'tool',
        name: 'compatibility_probe'
      }
    })
  });

  if (!response.ok) {
    return false;
  }

  const payload = await response.json();
  return Array.isArray(payload?.content) && payload.content.some(item => item?.type === 'tool_use');
}

async function probeOllamaToolSupport(settings, modelId) {
  try {
    const response = await fetch(resolveOllamaApiUrl(settings.baseUrl, 'show'), {
      method: 'POST',
      headers: buildHeaders(settings, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: modelId })
    });

    if (response.ok) {
      const payload = await response.json();
      if (typeof payload?.capabilities?.tools === 'boolean') {
        return payload.capabilities.tools;
      }

      if (Array.isArray(payload?.capabilities)) {
        return payload.capabilities.map(item => String(item || '').toLowerCase()).includes('tools');
      }
    }
  } catch (error) {
    console.warn(`[Provider] Ollama native tool probe failed for ${modelId}; trying OpenAI-compatible probe:`, error);
  }

  return probeOpenAIToolSupport({ ...settings, providerType: PROVIDER_TYPES.OPENAI }, modelId);
}

async function requestOpenAICompatibleCompletion(settings, request, handlers) {
  const payload = buildOpenAIPayload(request);
  const response = await fetch(resolveOpenAIChatUrl(settings.baseUrl), {
    method: 'POST',
    headers: buildHeaders(settings, { 'Content-Type': 'application/json' }),
    signal: request?.signal || undefined,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  if (!request.stream) {
    const result = await response.json();
    return normalizeOpenAICompletion(result, settings.providerType, request.model);
  }

  emitEvent(handlers, { type: 'started' });
  return parseOpenAIStream(response, handlers, request.model, settings.providerType);
}

async function requestOllamaCompletion(settings, request, handlers) {
  try {
    const payload = buildOllamaPayload(request);
    const response = await fetch(resolveOllamaApiUrl(settings.baseUrl, 'chat'), {
      method: 'POST',
      headers: buildHeaders(settings, { 'Content-Type': 'application/json' }),
      signal: request?.signal || undefined,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(await buildErrorMessage(response));
    }

    if (!request.stream) {
      const result = await response.json();
      return normalizeOllamaCompletion(result, settings.providerType, request.model);
    }

    emitEvent(handlers, { type: 'started' });
    return parseOllamaStream(response, handlers, request.model, settings.providerType);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.warn('[Provider] Ollama native chat request failed; falling back to OpenAI-compatible chat endpoint:', error);
    return requestOpenAICompatibleCompletion(
      { ...settings, providerType: PROVIDER_TYPES.OPENAI },
      request,
      handlers
    );
  }
}

async function requestAnthropicCompletion(settings, request, handlers) {
  const payload = buildAnthropicPayload(request);
  const response = await fetch(resolveAnthropicMessagesUrl(settings.baseUrl), {
    method: 'POST',
    headers: buildHeaders(settings, { 'Content-Type': 'application/json' }),
    signal: request?.signal || undefined,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  if (!request.stream) {
    const result = await response.json();
    return normalizeAnthropicCompletion(result, settings.providerType, request.model);
  }

  emitEvent(handlers, { type: 'started' });
  return parseAnthropicStream(response, handlers, request.model, settings.providerType);
}

function buildOpenAIPayload(request) {
  const payload = {
    model: request.model,
    messages: mapInternalMessagesToOpenAI(request.messages),
    stream: !!request.stream,
    temperature: request.temperature ?? 0.7
  };

  if (request.maxTokens) {
    payload.max_tokens = request.maxTokens;
  }

  if (request.thinkingSupported === true) {
    payload.reasoning_effort = request.thinkingEnabled === true ? 'medium' : 'none';
  }

  if (request.allowTools && Array.isArray(request.toolSchemas) && request.toolSchemas.length > 0) {
    payload.tools = request.toolSchemas.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    payload.tool_choice = 'auto';
    payload.parallel_tool_calls = false;
  }

  return payload;
}

function buildOllamaPayload(request) {
  const payload = {
    model: request.model,
    messages: mapInternalMessagesToOllama(request.messages),
    stream: !!request.stream
  };

  if (request.thinkingSupported === true) {
    const modelId = String(request.model || '').toLowerCase();
    payload.think = modelId.includes('gpt-oss')
      ? (request.thinkingEnabled === true ? 'medium' : 'low')
      : request.thinkingEnabled === true;
  }

  if (request.allowTools && Array.isArray(request.toolSchemas) && request.toolSchemas.length > 0) {
    payload.tools = request.toolSchemas.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  return payload;
}

function buildAnthropicPayload(request) {
  const { system, messages } = mapInternalMessagesToAnthropic(request.messages);
  const payload = {
    model: request.model,
    system,
    messages,
    stream: !!request.stream,
    max_tokens: request.maxTokens || 2048
  };

  if (request.allowTools && Array.isArray(request.toolSchemas) && request.toolSchemas.length > 0) {
    payload.tools = request.toolSchemas.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
    payload.tool_choice = { type: 'auto' };
  }

  return payload;
}

function mapInternalMessagesToOpenAI(messages) {
  const normalized = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'developer') {
      normalized.push({ role: 'system', content: message.content });
      continue;
    }

    normalized.push({
      ...message,
      content: normalizeOpenAIContent(message.content)
    });
  }
  return normalized;
}

function mapInternalMessagesToOllama(messages) {
  return (messages || []).map(message => {
    if (message.role === 'developer') {
      return {
        role: 'system',
        content: contentToText(message.content)
      };
    }

    if (Array.isArray(message.content)) {
      const text = [];
      const images = [];

      for (const part of message.content) {
        if (typeof part === 'string') {
          text.push(part);
          continue;
        }

        if (part?.type === 'text') {
          text.push(part.text || '');
          continue;
        }

        const imageUrl = part?.image_url?.url || part?.image_url;
        const match = typeof imageUrl === 'string'
          ? imageUrl.match(/^data:(.+?);base64,(.+)$/)
          : null;
        if (match) {
          images.push(match[2]);
        }
      }

      const normalized = {
        role: message.role,
        content: text.join('')
      };
      if (images.length > 0) {
        normalized.images = images;
      }
      return normalized;
    }

    return {
      role: message.role,
      content: contentToText(message.content)
    };
  });
}

function mapInternalMessagesToAnthropic(messages) {
  const systemChunks = [];
  const normalizedMessages = [];

  for (const message of messages || []) {
    if (!message) continue;

    if (message.role === 'system' || message.role === 'developer') {
      systemChunks.push(contentToText(message.content));
      continue;
    }

    if (message.role === 'tool') {
      normalizedMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id || message.id || 'tool_result',
            content: contentToText(message.content)
          }
        ]
      });
      continue;
    }

    const normalizedContent = normalizeAnthropicContent(message.content);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const toolBlocks = message.tool_calls.map((toolCall, index) => ({
        type: 'tool_use',
        id: toolCall?.id || `tool_use_${index}`,
        name: toolCall?.function?.name || toolCall?.name || '',
        input: parseJsonObject(toolCall?.function?.arguments)
      })).filter(block => block.name);

      normalizedMessages.push({
        role: 'assistant',
        content: normalizedContent.concat(toolBlocks)
      });
      continue;
    }

    normalizedMessages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: normalizedContent
    });
  }

  return {
    system: systemChunks.filter(Boolean).join('\n\n'),
    messages: normalizedMessages
  };
}

function normalizeOpenAIContent(content) {
  if (!Array.isArray(content)) {
    return content;
  }

  return content.map(part => {
    if (typeof part === 'string') {
      return { type: 'text', text: part };
    }

    if (part?.type === 'text') {
      return { type: 'text', text: part.text || '' };
    }

    return part;
  });
}

function normalizeAnthropicContent(content) {
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: contentToText(content) }];
  }

  return content.map(part => {
    if (typeof part === 'string') {
      return { type: 'text', text: part };
    }

    if (part?.type === 'text') {
      return { type: 'text', text: part.text || '' };
    }

    const imageUrl = part?.image_url?.url || part?.image_url;
    const match = typeof imageUrl === 'string'
      ? imageUrl.match(/^data:(.+?);base64,(.+)$/)
      : null;
    if (match) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2]
        }
      };
    }

    return { type: 'text', text: '' };
  });
}

function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'output_text') return part.text || '';
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).join('');
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

function normalizeOpenAICompletion(result, providerType, modelId) {
  const choice = result?.choices?.[0] || {};
  const message = choice?.message || {};
  const finishReason = choice?.finish_reason || null;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const text = contentToText(message?.content);
  const thinking = contentToText(message?.reasoning || message?.thinking);

  return {
    providerType,
    model: modelId,
    text,
    thinking,
    message,
    toolCalls,
    finishReason,
    incompleteReason: finishReason === 'length' ? 'max_output_tokens' : null,
    usage: result?.usage || null,
    raw: result
  };
}

function normalizeOllamaCompletion(result, providerType, modelId) {
  const finishReason = result?.done_reason || null;
  return {
    providerType,
    model: modelId,
    text: contentToText(result?.message?.content),
    thinking: contentToText(result?.message?.thinking),
    message: result?.message || {},
    toolCalls: Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [],
    finishReason,
    incompleteReason: finishReason === 'length' ? 'max_output_tokens' : null,
    usage: {
      prompt_eval_count: result?.prompt_eval_count ?? null,
      eval_count: result?.eval_count ?? null
    },
    raw: result
  };
}

function normalizeAnthropicCompletion(result, providerType, modelId) {
  const textBlocks = Array.isArray(result?.content)
    ? result.content.filter(item => item?.type === 'text')
    : [];
  const toolBlocks = Array.isArray(result?.content)
    ? result.content.filter(item => item?.type === 'tool_use')
    : [];

  return {
    providerType,
    model: modelId,
    text: textBlocks.map(item => item?.text || '').join(''),
    message: result,
    toolCalls: toolBlocks.map(block => ({
      id: block?.id,
      function: {
        name: block?.name,
        arguments: JSON.stringify(block?.input || {})
      }
    })),
    finishReason: result?.stop_reason || null,
    incompleteReason: result?.stop_reason === 'max_tokens' ? 'max_output_tokens' : null,
    usage: result?.usage || null,
    raw: result
  };
}

async function parseOpenAIStream(response, handlers, modelId, providerType) {
  const aggregate = {
    providerType,
    model: modelId,
    text: '',
    thinking: '',
    message: { content: '' },
    toolCalls: [],
    finishReason: null,
    incompleteReason: null,
    usage: null,
    raw: null
  };

  let buffer = '';
  for await (const chunk of iterateResponseChunks(response)) {
    buffer += chunk;
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleOpenAIEvent(rawEvent, aggregate, handlers);
      boundary = buffer.indexOf('\n\n');
    }
  }

  emitCompletionEvent(aggregate, handlers);
  return aggregate;
}

function handleOpenAIEvent(rawEvent, aggregate, handlers) {
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return;
  }

  const rawData = dataLines.join('\n');
  if (rawData === '[DONE]') {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return;
  }

  const choice = payload?.choices?.[0] || {};
  const delta = choice?.delta || {};
  const contentDelta = extractOpenAIContentDelta(delta?.content);
  if (contentDelta) {
    aggregate.text += contentDelta;
    aggregate.message.content = aggregate.text;
    emitEvent(handlers, { type: 'delta', delta: contentDelta });
  }

  const reasoningDelta = extractOpenAIContentDelta(delta?.reasoning || delta?.thinking);
  if (reasoningDelta) {
    aggregate.thinking += reasoningDelta;
    emitEvent(handlers, { type: 'thinking_delta', delta: reasoningDelta });
  }

  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    emitEvent(handlers, { type: 'tool_call_delta', delta: delta.tool_calls });
  }

  if (choice?.finish_reason) {
    aggregate.finishReason = choice.finish_reason;
    if (choice.finish_reason === 'length') {
      aggregate.incompleteReason = 'max_output_tokens';
    }
  }

  if (payload?.usage) {
    aggregate.usage = payload.usage;
  }

  aggregate.raw = payload;
}

function extractOpenAIContentDelta(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).join('');
  }

  return '';
}

async function parseOllamaStream(response, handlers, modelId, providerType) {
  const aggregate = {
    providerType,
    model: modelId,
    text: '',
    thinking: '',
    message: { content: '' },
    toolCalls: [],
    finishReason: null,
    incompleteReason: null,
    usage: null,
    raw: null
  };

  let buffer = '';
  for await (const chunk of iterateResponseChunks(response)) {
    buffer += chunk;
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) {
        handleOllamaLine(line, aggregate, handlers);
      }
      boundary = buffer.indexOf('\n');
    }
  }

  if (buffer.trim()) {
    handleOllamaLine(buffer.trim(), aggregate, handlers);
  }

  emitCompletionEvent(aggregate, handlers);
  return aggregate;
}

function handleOllamaLine(line, aggregate, handlers) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  const delta = contentToText(payload?.message?.content);
  if (delta) {
    aggregate.text += delta;
    aggregate.message.content = aggregate.text;
    emitEvent(handlers, { type: 'delta', delta });
  }

  const thinkingDelta = contentToText(payload?.message?.thinking);
  if (thinkingDelta) {
    aggregate.thinking += thinkingDelta;
    emitEvent(handlers, { type: 'thinking_delta', delta: thinkingDelta });
  }

  if (Array.isArray(payload?.message?.tool_calls) && payload.message.tool_calls.length > 0) {
    aggregate.toolCalls = payload.message.tool_calls;
    emitEvent(handlers, { type: 'tool_call_delta', delta: payload.message.tool_calls });
  }

  if (payload?.done_reason) {
    aggregate.finishReason = payload.done_reason;
    if (payload.done_reason === 'length') {
      aggregate.incompleteReason = 'max_output_tokens';
    }
  }

  aggregate.usage = {
    prompt_eval_count: payload?.prompt_eval_count ?? aggregate.usage?.prompt_eval_count ?? null,
    eval_count: payload?.eval_count ?? aggregate.usage?.eval_count ?? null
  };
  aggregate.raw = payload;
}

async function parseAnthropicStream(response, handlers, modelId, providerType) {
  const aggregate = {
    providerType,
    model: modelId,
    text: '',
    message: { content: '' },
    toolCalls: [],
    finishReason: null,
    incompleteReason: null,
    usage: null,
    raw: null
  };

  let buffer = '';
  let eventName = 'message';
  for await (const chunk of iterateResponseChunks(response)) {
    buffer += chunk;
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = [];
      eventName = 'message';
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length > 0) {
        handleAnthropicEvent(eventName, dataLines.join('\n'), aggregate, handlers);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  emitCompletionEvent(aggregate, handlers);
  return aggregate;
}

function handleAnthropicEvent(eventName, rawData, aggregate, handlers) {
  if (rawData === '[DONE]') {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return;
  }

  if (eventName === 'content_block_delta' && payload?.delta?.type === 'text_delta') {
    const delta = payload.delta.text || '';
    aggregate.text += delta;
    aggregate.message.content = aggregate.text;
    emitEvent(handlers, { type: 'delta', delta });
  }

  if (eventName === 'content_block_start' && payload?.content_block?.type === 'tool_use') {
    const toolDelta = payload.content_block;
    aggregate.toolCalls.push({
      id: toolDelta.id,
      function: {
        name: toolDelta.name,
        arguments: JSON.stringify(toolDelta.input || {})
      }
    });
    emitEvent(handlers, { type: 'tool_call_delta', delta: toolDelta });
  }

  if (eventName === 'message_delta' && payload?.delta?.stop_reason) {
    aggregate.finishReason = payload.delta.stop_reason;
    if (payload.delta.stop_reason === 'max_tokens') {
      aggregate.incompleteReason = 'max_output_tokens';
    }
  }

  if (payload?.usage) {
    aggregate.usage = payload.usage;
  }

  aggregate.raw = payload;
}

function emitCompletionEvent(aggregate, handlers) {
  if (aggregate.incompleteReason) {
    emitEvent(handlers, {
      type: 'incomplete',
      finishReason: aggregate.finishReason,
      incompleteReason: aggregate.incompleteReason,
      usage: aggregate.usage
    });
    return;
  }

  emitEvent(handlers, {
    type: 'completed',
    finishReason: aggregate.finishReason,
    usage: aggregate.usage
  });
}

function emitEvent(handlers, event) {
  if (typeof handlers?.onEvent === 'function') {
    handlers.onEvent(event);
  }
}

async function* iterateResponseChunks(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield TEXT_DECODER.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function buildErrorMessage(response) {
  const prefix = `API Error: ${response.status} ${response.statusText}`;
  try {
    const payload = await response.clone().json();
    const detail = payload?.error?.message || payload?.message || payload?.detail;
    return detail ? `${prefix} - ${detail}` : prefix;
  } catch {
    try {
      const text = await response.clone().text();
      return text ? `${prefix} - ${text.slice(0, 300)}` : prefix;
    } catch {
      return prefix;
    }
  }
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  return /aborted|aborterror/i.test(String(error.message || error));
}

function resolveOpenAIChatUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/\/v1\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function resolveOpenAIModelsUrl(baseUrl) {
  return resolveOpenAIChatUrl(baseUrl).replace(/\/chat\/completions$/i, '/models');
}

function resolveAnthropicBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/$/, '');
  if (/\/v1\/messages$/i.test(normalized)) {
    return normalized.replace(/\/messages$/i, '');
  }
  if (/\/v1$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/v1`;
}

function resolveAnthropicMessagesUrl(baseUrl) {
  return `${resolveAnthropicBaseUrl(baseUrl)}/messages`;
}

function resolveAnthropicModelsUrl(baseUrl) {
  return `${resolveAnthropicBaseUrl(baseUrl)}/models`;
}

function resolveOllamaApiUrl(baseUrl, endpoint) {
  const normalized = String(baseUrl || '').trim().replace(/\/$/, '');

  if (/\/ollama\/api$/i.test(normalized)) {
    return `${normalized}/${endpoint}`;
  }

  if (/\/api$/i.test(normalized)) {
    return `${normalized}/${endpoint}`;
  }

  if (/\/v1(\/chat\/completions)?$/i.test(normalized)) {
    const origin = tryGetOrigin(normalized);
    return `${origin}/api/${endpoint}`;
  }

  return `${normalized}/api/${endpoint}`;
}

function resolveOllamaApiCandidateUrls(baseUrl, endpoint) {
  const normalized = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!normalized) return [];

  const urls = [];
  const pushUnique = value => {
    if (value && !urls.includes(value)) {
      urls.push(value);
    }
  };

  if (/\/ollama\/api$/i.test(normalized) || /\/api$/i.test(normalized)) {
    pushUnique(`${normalized}/${endpoint}`);
    return urls;
  }

  if (/\/v1(\/chat\/completions)?$/i.test(normalized)) {
    const origin = tryGetOrigin(normalized);
    pushUnique(`${origin}/ollama/api/${endpoint}`);
    pushUnique(`${origin}/api/${endpoint}`);
    return urls;
  }

  pushUnique(`${normalized}/ollama/api/${endpoint}`);
  pushUnique(`${normalized}/api/${endpoint}`);
  return urls;
}

function parseJsonObject(rawValue) {
  if (!rawValue) return {};
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tryGetOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/v1(?:\/chat\/completions)?$/i, '');
  }
}
