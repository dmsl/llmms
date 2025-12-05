const Ajv = require('ajv');
const ajv = new Ajv({ coerceTypes: true, useDefaults: true }); // Auto-coerce types

/**
 * Backend LLM Call Handler
 * 
 * Calls the university's OpenAI-compatible backend for agentic reasoning.
 * Supports both streaming and non-streaming modes.
 * Normalizes tool call formats to canonical structure: { name, args }
 */
async function callBackendLLM(messages, tools = [], options = {}) {
  const BACKEND_URL = 'https://chatucy.cs.ucy.ac.cy/openapi/v1/chat/completions';
  const { model = 'llama3.2', stream = false } = options;
  
  try {
    const payload = {
      model,
      messages,
      stream,
      tools: tools.length > 0 ? tools : undefined
    };
    
    console.log(`[Agent] Calling backend LLM with model: ${model}, stream: ${stream}`);
    
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Backend LLM error: ${response.status} ${response.statusText}`);
    }

    // For streaming responses, return the response object itself
    if (stream) {
      return response;
    }
    
    // For non-streaming, parse and return JSON
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Agent] Backend LLM call failed:', error);
    throw error;
  }
}

/**
 * Lightweight JSON repair utility
 * Attempts to fix common malformations before rejecting
 */
function repairJSON(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // Attempt 1: Remove trailing commas
    let repaired = jsonString.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(repaired);
    } catch (e1) {
      // Attempt 2: Extract JSON from text using regex
      const jsonMatch = repaired.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          // Attempt 3: Quote unquoted strings
          const quoted = jsonMatch[0]
            .replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)/g, ': "$1"')
            .replace(/,\s*([a-zA-Z_][a-zA-Z0-9_]*)/g, ', "$1"');
          try {
            return JSON.parse(quoted);
          } catch (e3) {
            // All repairs failed
            return null;
          }
        }
      }
      return null;
    }
  }
}

/**
 * Generate stable ID for tool calls (if missing)
 */
function generateToolId(toolName, index) {
  return `call_${Date.now()}_${toolName}_${index}`;
}

/**
 * Validate tool arguments against schema using Ajv
 * Returns { valid: bool, errors: [] }
 */
function validateToolSchema(toolName, args, schema) {
  try {
    if (!schema || !schema.properties) {
      console.warn(`[Agent] No schema available for ${toolName}, skipping validation`);
      return { valid: true, errors: [] };
    }

    const validate = ajv.compile(schema);
    const isValid = validate(args);

    if (!isValid) {
      return {
        valid: false,
        errors: validate.errors.map(e => `${e.instancePath || 'root'} ${e.message}`).join('; ')
      };
    }

    return { valid: true, errors: [] };
  } catch (error) {
    console.warn(`[Agent] Schema validation error for ${toolName}:`, error);
    return { valid: true, errors: [] }; // Allow execution on validation error
  }
}

/**
 * Normalize tool calls to canonical format: { id, name, args }
 * 
 * Handles multiple LLM output formats:
 *   - OpenAI: message.tool_calls[].function.name/arguments
 *   - Alternative: message.function_call.name/arguments
 *   - Alternative: message.tool_call.name/arguments
 *   - Alternative: message.tool, message.tools, message.actions (various formats)
 *   - Auto-generates stable IDs if missing
 *   - Auto-coerces wrapped objects to arrays
 */
function normalizeToolCalls(message) {
  const toolCalls = [];

  // Helper: safely parse arguments string
  const parseArgs = (argsInput) => {
    if (typeof argsInput === 'object') return argsInput;
    if (typeof argsInput === 'string') {
      try {
        return JSON.parse(argsInput);
      } catch (e) {
        // Try JSON repair
        const repaired = repairJSON(argsInput);
        if (repaired) return repaired;
        console.warn(`[Agent] Failed to parse arguments:`, e);
        return {};
      }
    }
    return {};
  };

  // Format 1: OpenAI standard (tool_calls array with function property)
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const toolCall = message.tool_calls[i];
      const { id, function: func } = toolCall;
      if (func) {
        const { name, arguments: argsString } = func;
        const args = parseArgs(argsString);
        toolCalls.push({
          id: id || generateToolId(name, i),
          name,
          args
        });
      }
    }
  }

  // Format 2: Single function_call (legacy OpenAI)
  if (message.function_call && !toolCalls.length) {
    const { name, arguments: argsString } = message.function_call;
    const args = parseArgs(argsString);
    toolCalls.push({
      id: generateToolId(name, 0),
      name,
      args
    });
  }

  // Format 3: Single tool_call
  if (message.tool_call && !toolCalls.length) {
    const { id, name, arguments: argsString } = message.tool_call;
    const args = parseArgs(argsString);
    toolCalls.push({
      id: id || generateToolId(name, 0),
      name,
      args
    });
  }

  // Format 4: Single .tool object
  if (message.tool && !toolCalls.length && typeof message.tool === 'object') {
    const tool = message.tool;
    if (tool.name) {
      const { id, name, arguments: argsString, args: directArgs } = tool;
      const args = parseArgs(directArgs || argsString);
      toolCalls.push({
        id: id || generateToolId(name, 0),
        name,
        args
      });
    }
  }

  // Format 5: .tools array (some models use this)
  if (message.tools && Array.isArray(message.tools) && !toolCalls.length) {
    for (let i = 0; i < message.tools.length; i++) {
      const tool = message.tools[i];
      if (tool && typeof tool === 'object' && tool.name) {
        const { id, name, arguments: argsString, args: directArgs } = tool;
        const args = parseArgs(directArgs || argsString);
        toolCalls.push({
          id: id || generateToolId(name, i),
          name,
          args
        });
      }
    }
  }

  // Format 6: .actions array (Claude-style)
  if (message.actions && Array.isArray(message.actions) && !toolCalls.length) {
    for (let i = 0; i < message.actions.length; i++) {
      const action = message.actions[i];
      if (action && typeof action === 'object' && action.name) {
        const { id, name, arguments: argsString, args: directArgs } = action;
        const args = parseArgs(directArgs || argsString);
        toolCalls.push({
          id: id || generateToolId(name, i),
          name,
          args
        });
      }
    }
  }

  return toolCalls;
}

/**
 * Model-aware configuration for behavioral adjustments
 */
function getModelBehavior(model) {
  const baseModel = model.toLowerCase().split('-')[0];
  
  // Model-specific tuning
  const behaviors = {
    llama: { maxSteps: 12, allowLongReasoning: true, coerceTypes: true },
    mistral: { maxSteps: 8, allowLongReasoning: false, coerceTypes: true },
    qwen: { maxSteps: 10, allowLongReasoning: true, coerceTypes: false },
    neural: { maxSteps: 10, allowLongReasoning: false, coerceTypes: true }
  };
  
  return behaviors[baseModel] || { maxSteps: 12, allowLongReasoning: true, coerceTypes: true };
}

/**
 * Summarize older tool results to keep context window manageable
 * Keeps last 4 exchanges, summarizes earlier ones
 */
function compressMessageHistory(messages, keepRecent = 4) {
  if (messages.length <= keepRecent * 2 + 2) {
    return messages; // Not enough to summarize
  }

  // Keep system message and last N exchanges
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  
  const toKeep = nonSystemMsgs.slice(-keepRecent * 2);
  const toSummarize = nonSystemMsgs.slice(0, nonSystemMsgs.length - keepRecent * 2);

  // Create summary of compressed messages
  if (toSummarize.length > 0) {
    const toolResults = [];
    for (const msg of toSummarize) {
      if (msg.role === 'tool') {
        const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const isError = result.includes('error') || result.includes('Error');
        toolResults.push(`- ${msg.name}: ${isError ? 'error' : 'success'}`);
      }
    }

    const summary = {
      role: 'system',
      content: `Previously executed tool calls (summarized):\n${toolResults.join('\n')}`
    };

    return [...systemMsgs, summary, ...toKeep];
  }

  return messages;
}

/**
 * Create a hash of tool call combination to detect repeats
 */
function hashToolCalls(toolCalls) {
  const callSignatures = toolCalls
    .map(tc => `${tc.name}:${JSON.stringify(tc.args).slice(0, 50)}`)
    .join('|');
  return require('crypto').createHash('md5').update(callSignatures).digest('hex');
}

/**
 * Main Agent Loop - Commercial Grade
 * 
 * Implements agentic reasoning with:
 * - JSON schema validation (Ajv)
 * - Loop guardrails (max steps, repeat detection)
 * - JSON repair and self-correction
 * - Tool execution metadata
 * - Context compression
 * - Model-aware behavior
 * - Internal vs visible message separation
 * 
 * @param {Object} options - Configuration options
 * @param {string} options.userMessage - The user's message
 * @param {Array} options.toolSchemas - Available tool schemas for the LLM
 * @param {Function} options.toolRunner - Function to execute tools
 * @param {string} options.model - Model to use (default: llama3.2)
 * @param {string} options.systemPrompt - System prompt override
 * @param {string} options.personality - Personality/role for the assistant
 * @param {Array} options.conversationHistory - Previous conversation messages for context
 */
async function runAgent({ userMessage, toolSchemas, toolRunner, systemPrompt = '', personality = 'default', model = 'llama3.2', conversationHistory = [] }) {
  const messages = [];
  const internalMessages = []; // Hidden from user
  const modelBehavior = getModelBehavior(model);
  const MAX_STEPS = modelBehavior.maxSteps || 12;
  
  let stepCount = 0;
  let lastToolCallHash = null;
  
  // Build system prompt with personality
  let finalSystemPrompt = systemPrompt || 'You are a helpful assistant.';
  if (personality && personality !== 'default' && typeof personality === 'string') {
    finalSystemPrompt = `${finalSystemPrompt}\n\nPersonality: ${personality}`;
  }
  
  // Add system prompt (hidden from frontend)
  internalMessages.push({ role: 'system', content: finalSystemPrompt });
  
  // Add conversation history (if provided)
  if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    // Filter to only user/assistant/tool messages (hide internal ones)
    const visibleHistory = conversationHistory.filter(m => m.role !== 'agent' && m.role !== 'internal');
    messages.push(...visibleHistory);
  }
  
  // Add current user message
  messages.push({ role: 'user', content: userMessage });
  
  // Combine for LLM (internal + visible)
  const combinedMessages = [...internalMessages, ...messages];

  while (stepCount < MAX_STEPS) {
    stepCount++;
    console.log(`[Agent] Step ${stepCount}/${MAX_STEPS}`);

    try {
      // Call the backend LLM for agentic reasoning with selected model
      const response = await callBackendLLM(combinedMessages, toolSchemas, { model, stream: false });

      // Extract message from OpenAI-compatible response format
      const message = response.choices[0].message;
      const messageContent = message.content || '';
      
      // Extract token usage
      const usage = response.usage || {};
      const tokenUsage = {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0
      };

      // Normalize tool calls to canonical format
      const toolCalls = normalizeToolCalls(message);

      // Check if LLM called any tools
      if (toolCalls.length === 0) {
        // No tool calls - return final text response with token usage
        console.log('[Agent] LLM returned final response');
        
        // Add final assistant message to visible history
        messages.push({ role: 'assistant', content: messageContent });
        
        return {
          response: messageContent,
          tokens: tokenUsage,
          toolsExecuted: false,
          steps: stepCount
        };
      }

      // Detect repeated tool calls (infinite loop protection)
      const currentHash = hashToolCalls(toolCalls);
      if (lastToolCallHash === currentHash) {
        console.warn('[Agent] Repeated tool call detected - breaking loop');
        const toolNames = toolCalls.map(tc => tc.name).join(', ');
        return {
          response: `I attempted to execute the same tools (${toolNames}) multiple times without progress. Unable to continue.`,
          tokens: tokenUsage,
          toolsExecuted: false,
          error: 'Repeated tool calls detected',
          steps: stepCount
        };
      }
      lastToolCallHash = currentHash;

      // Process each tool call
      console.log(`[Agent] LLM called ${toolCalls.length} tool(s)`);
      
      // Add assistant message with tool calls (visible)
      messages.push({
        role: 'assistant',
        content: messageContent,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args)
          }
        }))
      });

      // Also add to combined messages for next LLM call
      combinedMessages.push({
        role: 'assistant',
        content: messageContent,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args)
          }
        }))
      });

      // Execute tools
      const toolMetadata = [];
      for (const toolCall of toolCalls) {
        const { id, name, args } = toolCall;
        const startTime = Date.now();
        
        try {
          // Get schema for this tool
          const toolSchema = toolSchemas.find(t => t.name === name);
          const inputSchema = toolSchema?.inputSchema;
          
          // Validate arguments against schema
          const validation = validateToolSchema(name, args, inputSchema);
          if (!validation.valid) {
            // Schema validation failed - send corrective message back to LLM
            console.warn(`[Agent] Tool ${name} validation failed:`, validation.errors);
            
            const correctionMsg = {
              role: 'tool',
              tool_call_id: id,
              name,
              content: JSON.stringify({
                error: `Invalid arguments. Expected: ${validation.errors}. Please correct and retry.`
              })
            };
            
            messages.push(correctionMsg);
            combinedMessages.push(correctionMsg);
            
            // Continue loop to let LLM self-correct
            continue;
          }

          // Call the tool via unified registry
          console.log(`[Agent] Executing tool: ${name}`, args);
          const toolResult = await toolRunner(name, args);
          const duration = Date.now() - startTime;

          // Track metadata
          toolMetadata.push({
            tool_name: name,
            duration_ms: duration,
            success: true,
            args,
            result: toolResult
          });

          // Add tool result to messages (OpenAI format)
          const toolMsg = {
            role: 'tool',
            tool_call_id: id,
            name,
            content: JSON.stringify(toolResult)
          };
          
          messages.push(toolMsg);
          combinedMessages.push(toolMsg);

          console.log(`[Agent] Tool ${name} completed in ${duration}ms`);
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(`[Agent] Tool ${name} failed:`, error);
          
          // Track error metadata
          toolMetadata.push({
            tool_name: name,
            duration_ms: duration,
            success: false,
            args,
            error: error.message
          });
          
          // Add error message to conversation (OpenAI format)
          const errorMsg = {
            role: 'tool',
            tool_call_id: id,
            name,
            content: JSON.stringify({ error: error.message })
          };
          
          messages.push(errorMsg);
          combinedMessages.push(errorMsg);
        }
      }

      // Compress message history if getting too large
      if (combinedMessages.length > 30) {
        const compressed = compressMessageHistory(combinedMessages, 4);
        // Update combined messages, keeping system message
        const systemMsg = combinedMessages.find(m => m.role === 'system');
        combinedMessages.length = 0;
        if (systemMsg) combinedMessages.push(systemMsg);
        combinedMessages.push(...compressed.filter(m => m.role !== 'system'));
        console.log('[Agent] Message history compressed');
      }

    } catch (error) {
      console.error(`[Agent] LLM call failed at step ${stepCount}:`, error);
      
      // Attempt to recover by asking LLM to retry
      const recoveryMsg = {
        role: 'user',
        content: `Previous operation failed: ${error.message}. Please try again with a different approach.`
      };
      
      messages.push(recoveryMsg);
      combinedMessages.push(recoveryMsg);
    }
  }

  // Max steps exceeded
  console.error('[Agent] Max steps exceeded');
  return {
    response: 'Agent loop exceeded safe execution limits (12 steps). Unable to complete request.',
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    toolsExecuted: false,
    error: 'Max steps exceeded',
    steps: stepCount
  };
}

module.exports = { runAgent, callBackendLLM };
