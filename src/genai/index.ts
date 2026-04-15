/**
 * Cloudflare Workers GenAI Plugin
 * 
 * NOTE: This is a port from Google's Genkit plugin to Cloudflare Workers.
 * Key changes:
 * - Replaced Google-specific auth with Cloudflare Access JWT verification
 * - Replaced Google KMS with Web Crypto API for encryption
 * - Replaced Google Cloud Storage with R2 bindings
 * - Replaced Google-specific LLM APIs with generic LLM interface
 * - Removed Google-specific model definitions (Gemini, Imagen, Veo)
 * - Added support for multiple LLM providers (OpenAI, Anthropic, DeepSeek)
 */

import { z } from 'zod';

// Cloudflare Worker environment bindings
export interface Env {
  // Database for storing model configurations and usage logs
  DB: D1Database;
  
  // Object storage for model artifacts and embeddings
  BUCKET: R2Bucket;
  
  // Key-value store for caching model responses
  KV: KVNamespace;
  
  // Secrets for API keys (set via wrangler secret or dashboard)
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  
  // Cloudflare Access JWT verification (if using Access)
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  
  // Analytics Engine for logging
  AI_ANALYTICS?: AnalyticsEngineDataset;
}

// Generic LLM request/response schemas
export const LLMRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  stream: z.boolean().optional(),
});

export const LLMResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number(),
    message: z.object({
      role: z.string(),
      content: z.string(),
    }),
    finish_reason: z.string(),
  })),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

export const EmbeddingRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
});

export const EmbeddingResponseSchema = z.object({
  object: z.string(),
  data: z.array(z.object({
    object: z.string(),
    embedding: z.array(z.number()),
    index: z.number(),
  })),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

export type LLMRequest = z.infer<typeof LLMRequestSchema>;
export type LLMResponse = z.infer<typeof LLMResponseSchema>;
export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;

// Plugin configuration
export interface CloudflareAIPluginOptions {
  // Default model provider to use
  defaultProvider?: 'openai' | 'anthropic' | 'deepseek';
  
  // Base URLs for API endpoints
  baseUrls?: {
    openai?: string;
    anthropic?: string;
    deepseek?: string;
  };
  
  // Rate limiting configuration
  rateLimit?: {
    requestsPerMinute: number;
  };
  
  // Cache configuration
  cacheTtl?: number;
  
  // Analytics configuration
  enableAnalytics?: boolean;
}

// Model reference types
export interface ModelReference<T = any> {
  name: string;
  config: T;
  invoke: (request: LLMRequest, env: Env) => Promise<LLMResponse>;
}

export interface EmbedderReference<T = any> {
  name: string;
  config: T;
  embed: (request: EmbeddingRequest, env: Env) => Promise<EmbeddingResponse>;
}

// Action metadata for discovery
export interface ActionMetadata {
  name: string;
  type: 'model' | 'embedder';
  provider: string;
  description?: string;
  capabilities: string[];
}

// Cloudflare-specific utilities
export class CloudflareAuth {
  /**
   * Verify Cloudflare Access JWT token
   * NOTE: Replaces Google STS token exchange
   */
  static async verifyAccessToken(token: string, env: Env): Promise<boolean> {
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      // If Access isn't configured, allow all requests
      return true;
    }
    
    try {
      const response = await fetch('https://cloudflareaccess.com/cdn-cgi/access/get-identity', {
        headers: {
          'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.ok;
    } catch (error) {
      console.error('Access token verification failed:', error);
      return false;
    }
  }
  
  /**
   * Get API key for provider from environment
   * NOTE: Replaces Google KMS-based key management
   */
  static getApiKey(provider: string, env: Env): string | undefined {
    switch (provider) {
      case 'openai':
        return env.OPENAI_API_KEY;
      case 'anthropic':
        return env.ANTHROPIC_API_KEY;
      case 'deepseek':
        return env.DEEPSEEK_API_KEY;
      default:
        return undefined;
    }
  }
}

export class CloudflareCrypto {
  /**
   * Encrypt data using Web Crypto API
   * NOTE: Replaces Google KMS encryption
   */
  static async encrypt(data: string, env: Env): Promise<ArrayBuffer> {
    // Generate a key from a passphrase (in production, use a proper key management system)
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('temporary-key-material'), // In production, use a proper secret
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('salt'),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      key,
      encoder.encode(data)
    );
    
    // Combine IV and encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    
    return result.buffer;
  }
  
  /**
   * Decrypt data using Web Crypto API
   */
  static async decrypt(data: ArrayBuffer, env: Env): Promise<string> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    // Extract IV and encrypted data
    const dataView = new Uint8Array(data);
    const iv = dataView.slice(0, 12);
    const encrypted = dataView.slice(12);
    
    // Recreate key (same as encryption)
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('temporary-key-material'),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('salt'),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      key,
      encrypted
    );
    
    return decoder.decode(decrypted);
  }
}

// LLM Client implementation
export class LLMClient {
  private env: Env;
  private options: CloudflareAIPluginOptions;
  
  constructor(env: Env, options: CloudflareAIPluginOptions = {}) {
    this.env = env;
    this.options = options;
  }
  
  /**
   * Make a request to an LLM provider
   */
  async request(
    provider: 'openai' | 'anthropic' | 'deepseek',
    request: LLMRequest,
    stream = false
  ): Promise<LLMResponse | ReadableStream> {
    const apiKey = CloudflareAuth.getApiKey(provider, this.env);
    if (!apiKey) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }
    
    const baseUrl = this.options.baseUrls?.[provider] || this.getDefaultBaseUrl(provider);
    
    // Check cache first
    if (!stream && this.options.cacheTtl) {
      const cacheKey = `llm:${provider}:${JSON.stringify(request)}`;
      const cached = await this.env.KV.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    
    // Provider-specific headers
    if (provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
    }
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...request,
        stream,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }
    
    if (stream) {
      return response.body!;
    }
    
    const result = await response.json();
    
    // Cache the result
    if (this.options.cacheTtl) {
      const cacheKey = `llm:${provider}:${JSON.stringify(request)}`;
      await this.env.KV.put(cacheKey, JSON.stringify(result), {
        expirationTtl: this.options.cacheTtl,
      });
    }
    
    // Log to Analytics Engine if enabled
    if (this.env.AI_ANALYTICS && this.options.enableAnalytics) {
      this.env.AI_ANALYTICS.writeDataPoint({
        blobs: [provider, request.model],
        doubles: [result.usage.total_tokens, Date.now()],
        indexes: [`${provider}-${request.model}`],
      });
    }
    
    return result;
  }
  
  /**
   * Create embeddings
   */
  async embed(
    provider: 'openai' | 'anthropic' | 'deepseek',
    request: EmbeddingRequest
  ): Promise<EmbeddingResponse> {
    const apiKey = CloudflareAuth.getApiKey(provider, this.env);
    if (!apiKey) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }
    
    const baseUrl = this.options.baseUrls?.[provider] || this.getDefaultBaseUrl(provider);
    
    // Check cache first
    if (this.options.cacheTtl) {
      const cacheKey = `embed:${provider}:${JSON.stringify(request)}`;
      const cached = await this.env.KV.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
    
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    
    // Cache the result
    if (this.options.cacheTtl) {
      const cacheKey = `embed:${provider}:${JSON.stringify(request)}`;
      await this.env.KV.put(cacheKey, JSON.stringify(result), {
        expirationTtl: this.options.cacheTtl,
      });
    }
    
    return result;
  }
  
  /**
   * List available models from a provider
   */
  async listModels(provider: 'openai' | 'anthropic' | 'deepseek'): Promise<string[]> {
    const apiKey = CloudflareAuth.getApiKey(provider, this.env);
    if (!apiKey) {
      return [];
    }
    
    const baseUrl = this.options.baseUrls?.[provider] || this.getDefaultBaseUrl(provider);
    
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });
      
      if (!response.ok) {
        console.warn(`Failed to list models from ${provider}: ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      return data.data?.map((model: any) => model.id) || [];
    } catch (error) {
      console.error(`Error listing models from ${provider}:`, error);
      return [];
    }
  }
  
  private getDefaultBaseUrl(provider: string): string {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      case 'deepseek':
        return 'https://api.deepseek.com/v1';
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

// Plugin implementation
export class CloudflareAIPlugin {
  private options: CloudflareAIPluginOptions;
  private client: LLMClient | null = null;
  
  constructor(options: CloudflareAIPluginOptions = {}) {
    this.options = {
      defaultProvider: 'openai',
      enableAnalytics: true,
      cacheTtl: 300, // 5 minutes
      ...options,
    };
  }
  
  /**
   * Initialize the plugin with environment bindings
   */
  initialize(env: Env): void {
    this.client = new LLMClient(env, this.options);
  }
  
  /**
   * Get a model reference
   */
  model(
    name: string,
    config?: any
  ): ModelReference {
    if (!this.client) {
      throw new Error('Plugin not initialized. Call initialize() first.');
    }
    
    // Parse model name to extract provider
    const [provider, modelName] = this.parseModelName(name);
    
    return {
      name,
      config: config || {},
      invoke: async (request: LLMRequest, env: Env) => {
        const client = new LLMClient(env, this.options);
        return client.request(provider as any, {
          ...request,
          model: modelName,
        }) as Promise<LLMResponse>;
      },
    };
  }
  
  /**
   * Get an embedder reference
   */
  embedder(
    name: string,
    config?: any
  ): EmbedderReference {
    if (!this.client) {
      throw new Error('Plugin not initialized. Call initialize() first.');
    }
    
    // Parse embedder name to extract provider
    const [provider, modelName] = this.parseModelName(name);
    
    return {
      name,
      config: config || {},
      embed: async (request: EmbeddingRequest, env: Env) => {
        const client = new LLMClient(env, this.options);
        return client.embed(provider as any, {
          ...request,
          model: modelName,
        });
      },
    };
  }
  
  /**
   * List all available actions (models and embedders)
   */
  async listActions(env: Env): Promise<ActionMetadata[]> {
    const actions: ActionMetadata[] = [];
    const client = new LLMClient(env, this.options);
    
    // List models from each provider
    const providers: ('openai' | 'anthropic' | 'deepseek')[] = ['openai', 'anthropic', 'deepseek'];
    
    for (const provider of providers) {
      const models = await client.listModels(provider);
      
      // Add chat models
      models.forEach(model => {
        actions.push({
          name: `${provider}:${model}`,
          type: 'model',
          provider,
          description: `Chat model from ${provider}`,
          capabilities: ['chat', 'completion'],
        });
      });
      
      // Add embedding models (assuming all providers support embeddings)
      actions.push({
        name: `${provider}:text-embedding-ada-002`,
        type: 'embedder',
        provider,
        description: `Embedding model from ${provider}`,
        capabilities: ['embedding'],
      });
    }
    
    return actions;
  }
  
  /**
   * Parse model name into provider and model parts
   */
  private parseModelName(name: string): [string, string] {
    const parts = name.split(':');
    if (parts.length === 2) {
      return [parts[0], parts[1]];
    }
    
    // Default to configured provider
    const provider = this.options.defaultProvider || 'openai';
    return [provider, name];
  }
}

// Factory function for creating the plugin
export function cloudflareAIPlugin(options?: CloudflareAIPluginOptions): CloudflareAIPlugin {
  return new CloudflareAIPlugin(options);
}

// Default export
export default cloudflareAIPlugin;

// Type exports
export type {
  CloudflareAIPluginOptions,
  ModelReference,
  EmbedderReference,
  ActionMetadata,
  LLMRequest,
  LLMResponse,
  EmbeddingRequest,
  EmbeddingResponse,
};