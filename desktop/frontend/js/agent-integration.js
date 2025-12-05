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

const BACKEND_API = 'https://chatucy.cs.ucy.ac.cy/openapi/v1/chat/completions';
const RAG_ENDPOINT = 'https://chatucy.cs.ucy.ac.cy/api/rag_chain';

/**
 * Send message to agent with support for tools, conversation history, and multimodal files
 * Runs agentic loop on frontend for privacy
 * @param {string} userMessage - The user's message
 * @param {Array} toolSchemas - Available tool definitions
 * @param {string} model - Model to use (default: llama3.2)
 * @param {Array} conversationHistory - Previous messages for context
 * @param {File} uploadedFile - Optional file (images for vision models, documents for RAG)
 */
export async function askAgent(userMessage, toolSchemas = [], model = 'llama3.2', conversationHistory = [], uploadedFile = null) {
  // Handle document/large file RAG separately
  if (uploadedFile && !uploadedFile.type.startsWith('image/')) {
    return handleRagChain(userMessage, model, uploadedFile);
  }
  
  // Build initial messages with system prompt
  let messages = [
    {
      role: 'system',
      content: `You are a helpful, friendly assistant. Provide clear, concise, and helpful responses to user questions. Be conversational and natural in your responses.`
    }
  ];
  
  messages = messages.concat(await buildMessages(conversationHistory, userMessage, uploadedFile));
  
  // Agentic loop - keep calling LLM until it stops using tools
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops
  
  while (iterations < maxIterations) {
    iterations++;
    console.log(`[Agent] Agentic loop iteration ${iterations}`);
    
    try {
      // Call LLM with current messages and available tools
      const response = await callLLM(messages, toolSchemas, model);
      
      // Check if LLM wants to use tools
      const toolCalls = extractToolCalls(response);
      
      if (toolCalls.length === 0) {
        // No tool calls - return the response content
        let content = response.choices?.[0]?.message?.content;
        console.log(`[Agent] LLM response (no tools): ${typeof content}`, content);
        
        // Handle empty or JSON-only responses
        if (!content || content.trim() === '{}' || content.trim() === '') {
          // LLM returned nothing - this might mean it's confused
          // Return a helpful message
          return 'I\'m ready to help! Feel free to ask me anything.';
        }
        
        // Try to extract text from JSON if the content is JSON
        if (typeof content === 'string' && content.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(content);
            // If JSON has a "response" or "text" field, use that
            if (parsed.response) return parsed.response;
            if (parsed.text) return parsed.text;
            if (parsed.message) return parsed.message;
            // Otherwise return original if it's more than just {}
            if (Object.keys(parsed).length > 0) return content;
          } catch (e) {
            // Not valid JSON, return as-is
            return content;
          }
        }
        
        return content || 'I didn\'t receive a proper response from the model.';
      }
      
      // Execute tools and add results to conversation
      console.log(`[Agent] Executing ${toolCalls.length} tool(s)`);
      const toolResults = await executeTools(toolCalls);
      
      // Add assistant's tool use message to history
      messages.push({
        role: 'assistant',
        content: response.choices[0].message.content,
        tool_calls: response.choices[0].message.tool_calls
      });
      
      // Add tool results as user message
      messages.push({
        role: 'user',
        content: buildToolResultsMessage(toolResults)
      });
      
    } catch (error) {
      console.error('[Agent] Agentic loop error:', error);
      throw error;
    }
  }
  
  throw new Error(`Agent exceeded maximum iterations (${maxIterations})`);
}

/**
 * Call the LLM backend API
 */
async function callLLM(messages, toolSchemas, model) {
  try {
    const payload = {
      model,
      messages,
      stream: false,
      temperature: 0.7
    };
    
    // Format tools correctly for OpenAI-compatible API
    if (toolSchemas && toolSchemas.length > 0) {
      // Filter out malformed schemas and normalize them
      const validTools = toolSchemas
        .filter(tool => {
          // Skip if schema is just "$schema" without properties
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
        // Enable function-calling mode - tell LLM to use tools
        payload.tool_choice = 'auto';
        
        console.log(`[Agent] Sending ${validTools.length} tools to LLM:`, 
          validTools.map(t => t.function.name));
      } else {
        console.log('[Agent] No valid tool schemas found, proceeding without tools');
      }
    }

    const response = await fetch(BACKEND_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log('[Agent] LLM Response:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('[Agent] LLM call failed:', error);
    throw error;
  }
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
    console.log('[Agent] Full tool_calls:', JSON.stringify(message.tool_calls, null, 2));
    
    for (const toolCall of message.tool_calls) {
      console.log('[Agent] Processing toolCall:', JSON.stringify(toolCall, null, 2));
      
      if (toolCall.function) {
        const { name, arguments: argsString } = toolCall.function;
        console.log(`[Agent] Tool function - name: "${name}", args type: ${typeof argsString}`);
        
        let args = {};
        try {
          args = typeof argsString === 'string' ? JSON.parse(argsString) : argsString;
        } catch (e) {
          console.warn(`[Agent] Failed to parse arguments for ${name}:`, e);
        }
        
        console.log(`[Agent] Extracted tool call: ${name} with args:`, args);
        toolCalls.push({ 
          id: toolCall.id, 
          name, 
          args 
        });
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
  
  return toolCalls;
}

/**
 * Execute tools by calling IPC (Electron) or local functions
 */
async function executeTools(toolCalls) {
  const results = [];
  
  // Check if MCP is available in Electron
  if (!window.desktop?.isElectron) {
    console.error('[Agent] Not running in Electron environment');
    throw new Error('Tool execution requires Electron environment');
  }
  
  if (!window.desktop?.mcpCall) {
    console.error('[Agent] mcpCall not available in desktop API');
    throw new Error('MCP tools not available');
  }
  
  for (const toolCall of toolCalls) {
    try {
      console.log(`[Agent] Executing tool: "${toolCall.name}" with args:`, toolCall.args);
      
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
      
      console.log(`[Agent] Tool ${toolCall.name} succeeded:`, result);
    } catch (error) {
      console.error(`[Agent] Tool ${toolCall.name} failed:`, error);
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
async function handleRagChain(userMessage, model, file) {
  try {
    console.log(`[Agent] RAG chain request with document: ${file.name}`);
    
    // Convert file to base64 for transmission
    const base64 = await fileToBase64(file);
    
    const payload = {
      model: model,
      messages: [{ role: 'user', content: userMessage }],
      fileData: base64,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      fileSize: file.size,
      clientSideRag: false
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
    
    const data = await response.json();
    return data.response || data.result?.response || '';
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

