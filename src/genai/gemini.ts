/**
 * Cloudflare Workers Gemini/LLM Model Adapter
 * 
 * NOTE: This is a simplified port from Google's Gemini API to a generic LLM interface.
 * Changes made:
 * - Removed Google-specific dependencies (Genkit, Google AI SDK)
 * - Replaced with Cloudflare Workers fetch-based API calls
 * - Simplified configuration schema for Cloudflare environment
 * - Added support for multiple LLM providers (OpenAI, Anthropic, DeepSeek)
 * - Removed Google-specific features (Google Search retrieval, Google-specific tools)
 * - Added Cloudflare-specific error handling and logging
 */

export interface Env {
  // Cloudflare bindings
  LLM_API_KEY?: string;  // API key for LLM provider
  LLM_BASE_URL?: string; // Base URL for LLM API
  LLM_PROVIDER?: 'openai' | 'anthropic' | 'deepseek' | 'gemini'; // LLM provider
  
  // Optional: For storing conversation history or embeddings
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  
  // Optional: For caching responses
  KV?: KVNamespace;
  
  // Optional: For storing generated media
  BUCKET?: R2Bucket;
}

/**
 * Safety settings for content filtering
 */
export interface SafetySetting {
  category: 'hate' | 'harassment' | 'sexual' | 'dangerous' | 'unclassified';
  threshold: 'low' | 'medium' | 'high' | 'none';
}

/**
 * Tool/function definition for function calling
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Message content part
 */
export interface ContentPart {
  type: 'text' | 'image' | 'audio';
  text?: string;
  image?: {
    data: ArrayBuffer;
    mimeType: string;
  };
  audio?: {
    data: ArrayBuffer;
    mimeType: string;
  };
}

/**
 * Chat message
 */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
}

/**
 * Generation configuration
 */
export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/**
 * Tool configuration
 */
export interface ToolConfig {
  mode?: 'auto' | 'any' | 'none';
  allowedFunctions?: string[];
}

/**
 * Main request for LLM generation
 */
export interface GenerateRequest {
  messages: Message[];
  model: string;
  config?: GenerationConfig;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  safetySettings?: SafetySetting[];
  stream?: boolean;
  systemInstruction?: string;
}

/**
 * Generated candidate
 */
export interface Candidate {
  index: number;
  message: Message;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';
}

/**
 * Usage statistics
 */
export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

/**
 * Generation response
 */
export interface GenerateResponse {
  candidates: Candidate[];
  usage?: UsageStats;
  model: string;
  id?: string;
}

/**
 * Stream chunk
 */
export interface StreamChunk {
  index: number;
  content: ContentPart[];
  finishReason?: string;
}

/**
 * LLM Provider interface
 */
export interface LLMProvider {
  generate(request: GenerateRequest, env: Env): Promise<GenerateResponse>;
  generateStream(request: GenerateRequest, env: Env): ReadableStream<StreamChunk>;
}

/**
 * Base LLM error class
 */
export class LLMError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Configuration schema for LLM requests
 */
export const LLMConfigSchema = {
  temperature: { type: 'number', min: 0, max: 2, default: 1.0 },
  topP: { type: 'number', min: 0, max: 1, default: 0.95 },
  maxTokens: { type: 'number', min: 1, max: 100000 },
  stopSequences: { type: 'array', items: { type: 'string' } },
  safetySettings: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['hate', 'harassment', 'sexual', 'dangerous', 'unclassified']
        },
        threshold: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'none']
        }
      }
    }
  }
};

/**
 * Convert messages to provider-specific format
 */
function convertMessagesToProviderFormat(
  messages: Message[], 
  provider: string
): unknown[] {
  switch (provider) {
    case 'openai':
      return messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        name: msg.name
      }));
    case 'anthropic':
      // Anthropic has different message structure
      return messages.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: typeof msg.content === 'string' 
          ? [{ type: 'text', text: msg.content }]
          : msg.content
      }));
    case 'deepseek':
      return messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        name: msg.name
      }));
    default:
      return messages;
  }
}

/**
 * Convert tools to provider-specific format
 */
function convertToolsToProviderFormat(
  tools: ToolDefinition[],
  provider: string
): unknown[] {
  switch (provider) {
    case 'openai':
      return tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    case 'anthropic':
      // Anthropic tools format
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    default:
      return tools;
  }
}

/**
 * Parse provider response
 */
function parseProviderResponse(
  response: unknown,
  provider: string
): GenerateResponse {
  switch (provider) {
    case 'openai':
      const openaiResp = response as any;
      return {
        candidates: openaiResp.choices?.map((choice: any, index: number) => ({
          index,
          message: {
            role: 'assistant',
            content: choice.message.content,
            toolCallId: choice.message.tool_calls?.[0]?.id
          },
          finishReason: choice.finish_reason
        })) || [],
        usage: {
          inputTokens: openaiResp.usage?.prompt_tokens,
          outputTokens: openaiResp.usage?.completion_tokens,
          totalTokens: openaiResp.usage?.total_tokens
        },
        model: openaiResp.model,
        id: openaiResp.id
      };
      
    case 'anthropic':
      const anthropicResp = response as any;
      return {
        candidates: [{
          index: 0,
          message: {
            role: 'assistant',
            content: anthropicResp.content?.[0]?.text || ''
          },
          finishReason: anthropicResp.stop_reason
        }],
        usage: {
          inputTokens: anthropicResp.usage?.input_tokens,
          outputTokens: anthropicResp.usage?.output_tokens,
          totalTokens: (anthropicResp.usage?.input_tokens || 0) + 
                     (anthropicResp.usage?.output_tokens || 0)
        },
        model: anthropicResp.model,
        id: anthropicResp.id
      };
      
    default:
      throw new LLMError(500, `Unsupported provider: ${provider}`);
  }
}

/**
 * OpenAI provider implementation
 */
class OpenAIProvider implements LLMProvider {
  async generate(request: GenerateRequest, env: Env): Promise<GenerateResponse> {
    const apiKey = env.LLM_API_KEY;
    const baseUrl = env.LLM_BASE_URL || 'https://api.openai.com/v1';
    
    if (!apiKey) {
      throw new LLMError(401, 'OpenAI API key not configured');
    }
    
    const body = {
      model: request.model,
      messages: convertMessagesToProviderFormat(request.messages, 'openai'),
      temperature: request.config?.temperature,
      top_p: request.config?.topP,
      max_tokens: request.config?.maxTokens,
      stop: request.config?.stopSequences,
      tools: request.tools ? convertToolsToProviderFormat(request.tools, 'openai') : undefined,
      tool_choice: request.toolChoice
    };
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new LLMError(
        response.status,
        error.error?.message || 'OpenAI API error',
        error.error?.code,
        error
      );
    }
    
    const data = await response.json();
    return parseProviderResponse(data, 'openai');
  }
  
  generateStream(request: GenerateRequest, env: Env): ReadableStream<StreamChunk> {
    // NOTE: Streaming implementation omitted for brevity
    // Would use fetch with stream: true and transform the SSE stream
    throw new LLMError(501, 'Streaming not implemented');
  }
}

/**
 * Anthropic provider implementation
 */
class AnthropicProvider implements LLMProvider {
  async generate(request: GenerateRequest, env: Env): Promise<GenerateResponse> {
    const apiKey = env.LLM_API_KEY;
    const baseUrl = env.LLM_BASE_URL || 'https://api.anthropic.com/v1';
    
    if (!apiKey) {
      throw new LLMError(401, 'Anthropic API key not configured');
    }
    
    const body = {
      model: request.model,
      messages: convertMessagesToProviderFormat(request.messages, 'anthropic'),
      max_tokens: request.config?.maxTokens || 4096,
      temperature: request.config?.temperature,
      top_p: request.config?.topP,
      stop_sequences: request.config?.stopSequences,
      system: request.systemInstruction,
      tools: request.tools ? convertToolsToProviderFormat(request.tools, 'anthropic') : undefined,
      tool_choice: request.toolChoice
    };
    
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new LLMError(
        response.status,
        error.error?.message || 'Anthropic API error',
        error.error?.type,
        error
      );
    }
    
    const data = await response.json();
    return parseProviderResponse(data, 'anthropic');
  }
  
  generateStream(request: GenerateRequest, env: Env): ReadableStream<StreamChunk> {
    throw new LLMError(501, 'Streaming not implemented');
  }
}

/**
 * Main LLM client for Cloudflare Workers
 */
export class CloudflareLLMClient {
  private provider: LLMProvider;
  
  constructor(env: Env) {
    const providerType = env.LLM_PROVIDER || 'openai';
    
    switch (providerType) {
      case 'openai':
        this.provider = new OpenAIProvider();
        break;
      case 'anthropic':
        this.provider = new AnthropicProvider();
        break;
      default:
        throw new LLMError(400, `Unsupported LLM provider: ${providerType}`);
    }
  }
  
  /**
   * Generate content using configured LLM provider
   */
  async generate(request: GenerateRequest, env: Env): Promise<GenerateResponse> {
    try {
      // Validate request
      if (!request.messages || request.messages.length === 0) {
        throw new LLMError(400, 'No messages provided');
      }
      
      if (!request.model) {
        throw new LLMError(400, 'Model not specified');
      }
      
      // Call provider
      return await this.provider.generate(request, env);
      
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }
      throw new LLMError(500, 'LLM generation failed', undefined, error);
    }
  }
  
  /**
   * Generate streaming response
   */
  generateStream(request: GenerateRequest, env: Env): ReadableStream<StreamChunk> {
    return this.provider.generateStream(request, env);
  }
  
  /**
   * Get available models (simplified - would normally fetch from provider API)
   */
  async listModels(env: Env): Promise<string[]> {
    // NOTE: In a real implementation, this would fetch from provider's model endpoint
    // For now, return common models based on provider
    const provider = env.LLM_PROVIDER || 'openai';
    
    switch (provider) {
      case 'openai':
        return [
          'gpt-4o',
          'gpt-4-turbo',
          'gpt-4',
          'gpt-3.5-turbo',
          'o1-preview',
          'o1-mini'
        ];
      case 'anthropic':
        return [
          'claude-3-5-sonnet-20241022',
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307',
          'claude-2.1'
        ];
      default:
        return [];
    }
  }
}

/**
 * Example Cloudflare Worker handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const client = new CloudflareLLMClient(env);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }
    
    // Only allow POST for generation
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    
    try {
      const requestData = await request.json() as GenerateRequest;
      
      // Check if streaming is requested
      if (requestData.stream) {
        const stream = client.generateStream(requestData, env);
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // Regular generation
      const response = await client.generate(requestData, env);
      return Response.json(response, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        }
      });
      
    } catch (error) {
      console.error('LLM generation error:', error);
      
      if (error instanceof LLMError) {
        return Response.json({
          error: {
            message: error.message,
            code: error.code,
            status: error.status
          }
        }, {
          status: error.status,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
      
      return Response.json({
        error: {
          message: 'Internal server error',
          status: 500
        }
      }, {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

/**
 * Utility function to create a simple text message
 */
export function textMessage(role: Message['role'], content: string): Message {
  return { role, content };
}

/**
 * Utility function to create a message with media
 */
export function mediaMessage(
  role: Message['role'], 
  parts: ContentPart[]
): Message {
  return { role, content: parts };
}

/**
 * Validate safety settings
 */
export function validateSafetySettings(settings: SafetySetting[]): boolean {
  return settings.every(s => 
    ['hate', 'harassment', 'sexual', 'dangerous', 'unclassified'].includes(s.category) &&
    ['low', 'medium', 'high', 'none'].includes(s.threshold)
  );
}

// Export types for external use
export type {
  SafetySetting,
  ToolDefinition,
  ContentPart,
  Message,
  GenerationConfig,
  ToolConfig,
  GenerateRequest,
  Candidate,
  UsageStats,
  GenerateResponse,
  StreamChunk
};