/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// NOTE: Ported from Google AI API client to generic LLM interface for Cloudflare Workers
// - Google-specific endpoints replaced with configurable LLM providers
// - API key authentication replaced with Cloudflare Workers secrets
// - Google-specific models/types replaced with generic LLM interfaces

import {
  extractErrMsg,
  getGenkitClientHeader,
  processStream,
} from '../common/utils.js';
import {
  ClientOptions,
  EmbedContentRequest,
  EmbedContentResponse,
  GenerateContentRequest,
  GenerateContentResponse,
  GenerateContentStreamResult,
  ImagenPredictRequest,
  ImagenPredictResponse,
  ListModelsResponse,
  Model,
  VeoOperation,
  VeoPredictRequest,
  LLMProvider,
  LLMConfig,
} from './types.js';

// Cloudflare Workers environment bindings
interface Env {
  // LLM API keys stored as secrets
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  
  // Optional: Store model configurations in KV
  LLM_CONFIG?: KVNamespace;
  
  // Optional: Cache embeddings/responses in R2
  EMBEDDINGS_BUCKET?: R2Bucket;
  
  // Optional: Log requests to D1 for analytics
  ANALYTICS_DB?: D1Database;
}

/**
 * Generic LLM client for Cloudflare Workers supporting multiple providers
 */
export class LLMClient {
  private env: Env;
  private config: LLMConfig;
  
  constructor(env: Env, config?: Partial<LLMConfig>) {
    this.env = env;
    this.config = {
      provider: config?.provider || LLMProvider.OPENAI,
      baseUrl: config?.baseUrl,
      apiVersion: config?.apiVersion || 'v1',
      defaultModel: config?.defaultModel,
      timeout: config?.timeout || 30000,
      ...config
    };
  }
  
  /**
   * Lists available models from the configured provider
   */
  async listModels(clientOptions?: ClientOptions): Promise<Model[]> {
    const url = this.getLLMUrl({
      resourcePath: 'models',
      queryParams: 'pageSize=1000',
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'GET',
      apiKey,
      clientOptions,
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    const modelResponse = JSON.parse(await response.text()) as ListModelsResponse;
    return modelResponse.models;
  }
  
  /**
   * Generates content using the configured LLM provider
   */
  async generateContent(
    model: string,
    generateContentRequest: GenerateContentRequest,
    clientOptions?: ClientOptions
  ): Promise<GenerateContentResponse> {
    const url = this.getLLMUrl({
      resourcePath: this.getProviderEndpoint('completions'),
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'POST',
      apiKey,
      clientOptions,
      body: JSON.stringify({
        model: model || this.config.defaultModel,
        ...generateContentRequest
      }),
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return response.json() as Promise<GenerateContentResponse>;
  }
  
  /**
   * Generates a stream of content using the configured LLM provider
   */
  async generateContentStream(
    model: string,
    generateContentRequest: GenerateContentRequest,
    clientOptions?: ClientOptions
  ): Promise<GenerateContentStreamResult> {
    const url = this.getLLMUrl({
      resourcePath: this.getProviderEndpoint('completions'),
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'POST',
      apiKey,
      clientOptions,
      body: JSON.stringify({
        model: model || this.config.defaultModel,
        stream: true,
        ...generateContentRequest
      }),
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return processStream(response);
  }
  
  /**
   * Embeds content using the configured LLM provider
   */
  async embedContent(
    model: string,
    embedContentRequest: EmbedContentRequest,
    clientOptions?: ClientOptions
  ): Promise<EmbedContentResponse> {
    const url = this.getLLMUrl({
      resourcePath: this.getProviderEndpoint('embeddings'),
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'POST',
      apiKey,
      clientOptions,
      body: JSON.stringify({
        model: model || this.config.defaultModel,
        ...embedContentRequest
      }),
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return response.json() as Promise<EmbedContentResponse>;
  }
  
  /**
   * NOTE: Image generation is provider-specific
   * For OpenAI: DALL-E, for Anthropic: Claude with image understanding
   * This is a simplified interface - actual implementation would vary by provider
   */
  async imagenPredict(
    model: string,
    imagenPredictRequest: ImagenPredictRequest,
    clientOptions?: ClientOptions
  ): Promise<ImagenPredictResponse> {
    // NOTE: Image generation endpoints vary by provider
    const endpoint = this.config.provider === LLMProvider.OPENAI 
      ? 'images/generations' 
      : 'predict'; // Generic fallback
    
    const url = this.getLLMUrl({
      resourcePath: endpoint,
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'POST',
      apiKey,
      clientOptions,
      body: JSON.stringify({
        model: model || this.config.defaultModel,
        ...imagenPredictRequest
      }),
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return response.json() as Promise<ImagenPredictResponse>;
  }
  
  /**
   * NOTE: Video generation is not widely supported across LLM providers
   * This is a placeholder for future video generation capabilities
   */
  async veoPredict(
    model: string,
    veoPredictRequest: VeoPredictRequest,
    clientOptions?: ClientOptions
  ): Promise<VeoOperation> {
    // NOTE: Most providers don't have video generation yet
    // This would be specific to providers that support it
    const url = this.getLLMUrl({
      resourcePath: 'videos/generations',
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'POST',
      apiKey,
      clientOptions,
      body: JSON.stringify({
        model: model || this.config.defaultModel,
        ...veoPredictRequest
      }),
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return response.json() as Promise<VeoOperation>;
  }
  
  /**
   * Checks status of a long-running operation
   */
  async veoCheckOperation(
    operation: string,
    clientOptions?: ClientOptions
  ): Promise<VeoOperation> {
    const url = this.getLLMUrl({
      resourcePath: operation,
      clientOptions,
    });
    
    const apiKey = await this.getApiKey();
    const fetchOptions = this.getFetchOptions({
      method: 'GET',
      apiKey,
      clientOptions,
    });
    
    const response = await this.makeRequest(url, fetchOptions);
    return response.json() as Promise<VeoOperation>;
  }
  
  /**
   * Gets the appropriate API key from environment based on provider
   */
  private async getApiKey(): Promise<string> {
    switch (this.config.provider) {
      case LLMProvider.OPENAI:
        if (!this.env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY not found in environment');
        }
        return this.env.OPENAI_API_KEY;
        
      case LLMProvider.ANTHROPIC:
        if (!this.env.ANTHROPIC_API_KEY) {
          throw new Error('ANTHROPIC_API_KEY not found in environment');
        }
        return this.env.ANTHROPIC_API_KEY;
        
      case LLMProvider.DEEPSEEK:
        if (!this.env.DEEPSEEK_API_KEY) {
          throw new Error('DEEPSEEK_API_KEY not found in environment');
        }
        return this.env.DEEPSEEK_API_KEY;
        
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }
  
  /**
   * Gets provider-specific endpoint paths
   */
  private getProviderEndpoint(type: 'completions' | 'embeddings'): string {
    switch (this.config.provider) {
      case LLMProvider.OPENAI:
        return type === 'completions' ? 'chat/completions' : 'embeddings';
        
      case LLMProvider.ANTHROPIC:
        return type === 'completions' ? 'messages' : 'embeddings';
        
      case LLMProvider.DEEPSEEK:
        return type === 'completions' ? 'chat/completions' : 'embeddings';
        
      default:
        return type;
    }
  }
  
  /**
   * Generates URL for the configured LLM provider
   */
  private getLLMUrl(params: {
    resourcePath: string;
    queryParams?: string;
    clientOptions?: ClientOptions;
  }): string {
    // Default base URLs by provider
    const defaultBaseUrls = {
      [LLMProvider.OPENAI]: 'https://api.openai.com',
      [LLMProvider.ANTHROPIC]: 'https://api.anthropic.com',
      [LLMProvider.DEEPSEEK]: 'https://api.deepseek.com',
    };
    
    const apiVersion = params.clientOptions?.apiVersion || this.config.apiVersion;
    const baseUrl = params.clientOptions?.baseUrl || this.config.baseUrl || defaultBaseUrls[this.config.provider];
    
    let url = `${baseUrl}/${apiVersion}/${params.resourcePath}`;
    
    if (params.queryParams) {
      url += `?${params.queryParams}`;
    }
    
    return url;
  }
  
  /**
   * Creates fetch options with proper headers and timeout
   */
  private getFetchOptions(params: {
    method: 'POST' | 'GET';
    apiKey: string;
    body?: string;
    clientOptions?: ClientOptions;
  }) {
    const fetchOptions: RequestInit = {
      method: params.method,
      headers: this.getHeaders(params.apiKey, params.clientOptions),
    };
    
    if (params.body) {
      fetchOptions.body = params.body;
    }
    
    const signal = this.getAbortSignal(params.clientOptions);
    if (signal) {
      fetchOptions.signal = signal;
    }
    
    return fetchOptions;
  }
  
  /**
   * Creates abort signal for timeout handling
   */
  private getAbortSignal(clientOptions?: ClientOptions): AbortSignal | undefined {
    const timeout = clientOptions?.timeout ?? this.config.timeout;
    const hasTimeout = timeout >= 0;
    
    if (clientOptions?.signal !== undefined || hasTimeout) {
      const controller = new AbortController();
      
      if (hasTimeout) {
        setTimeout(() => controller.abort(), timeout);
      }
      
      if (clientOptions?.signal) {
        clientOptions.signal.addEventListener('abort', () => {
          controller.abort();
        });
      }
      
      return controller.signal;
    }
    
    return undefined;
  }
  
  /**
   * Constructs headers for API request
   */
  private getHeaders(apiKey: string, clientOptions?: ClientOptions): HeadersInit {
    let customHeaders = {};
    
    if (clientOptions?.customHeaders) {
      customHeaders = structuredClone(clientOptions.customHeaders);
      // Remove provider-specific headers that will be set below
      delete customHeaders['Authorization'];
      delete customHeaders['x-api-key'];
      delete customHeaders['anthropic-version'];
    }
    
    const headers: HeadersInit = {
      ...customHeaders,
      'Content-Type': 'application/json',
    };
    
    // Provider-specific headers
    switch (this.config.provider) {
      case LLMProvider.OPENAI:
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
        
      case LLMProvider.ANTHROPIC:
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
        
      case LLMProvider.DEEPSEEK:
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
    }
    
    // Add client header for analytics
    headers['x-cloudflare-client'] = getGenkitClientHeader();
    
    return headers;
  }
  
  /**
   * Makes HTTP request with error handling
   */
  private async makeRequest(url: string, fetchOptions: RequestInit): Promise<Response> {
    try {
      const response = await fetch(url, fetchOptions);
      
      if (!response.ok) {
        let errorText = await response.text();
        let errorMessage = errorText;
        
        try {
          const json = JSON.parse(errorText);
          if (json.error && json.error.message) {
            errorMessage = json.error.message;
          }
        } catch (e) {
          // Not JSON or expected format, use the raw text
        }
        
        throw new Error(
          `Error fetching from ${url}: [${response.status} ${response.statusText}] ${errorMessage}`
        );
      }
      
      return response;
    } catch (e: unknown) {
      console.error(e);
      throw new Error(`Failed to fetch from ${url}: ${extractErrMsg(e)}`);
    }
  }
}

// Legacy function exports for backward compatibility
// NOTE: These use the default provider from environment

export async function listModels(
  env: Env,
  clientOptions?: ClientOptions
): Promise<Model[]> {
  const client = new LLMClient(env);
  return client.listModels(clientOptions);
}

export async function generateContent(
  env: Env,
  model: string,
  generateContentRequest: GenerateContentRequest,
  clientOptions?: ClientOptions
): Promise<GenerateContentResponse> {
  const client = new LLMClient(env);
  return client.generateContent(model, generateContentRequest, clientOptions);
}

export async function generateContentStream(
  env: Env,
  model: string,
  generateContentRequest: GenerateContentRequest,
  clientOptions?: ClientOptions
): Promise<GenerateContentStreamResult> {
  const client = new LLMClient(env);
  return client.generateContentStream(model, generateContentRequest, clientOptions);
}

export async function embedContent(
  env: Env,
  model: string,
  embedContentRequest: EmbedContentRequest,
  clientOptions?: ClientOptions
): Promise<EmbedContentResponse> {
  const client = new LLMClient(env);
  return client.embedContent(model, embedContentRequest, clientOptions);
}

export async function imagenPredict(
  env: Env,
  model: string,
  imagenPredictRequest: ImagenPredictRequest,
  clientOptions?: ClientOptions
): Promise<ImagenPredictResponse> {
  const client = new LLMClient(env);
  return client.imagenPredict(model, imagenPredictRequest, clientOptions);
}

export async function veoPredict(
  env: Env,
  model: string,
  veoPredictRequest: VeoPredictRequest,
  clientOptions?: ClientOptions
): Promise<VeoOperation> {
  const client = new LLMClient(env);
  return client.veoPredict(model, veoPredictRequest, clientOptions);
}

export async function veoCheckOperation(
  env: Env,
  operation: string,
  clientOptions?: ClientOptions
): Promise<VeoOperation> {
  const client = new LLMClient(env);
  return client.veoCheckOperation(operation, clientOptions);
}

// Test exports
export const TEST_ONLY = {
  getFetchOptions: (client: LLMClient, params: any) => (client as any).getFetchOptions(params),
  getAbortSignal: (client: LLMClient, options?: ClientOptions) => (client as any).getAbortSignal(options),
  getHeaders: (client: LLMClient, apiKey: string, options?: ClientOptions) => (client as any).getHeaders(apiKey, options),
  makeRequest: (client: LLMClient, url: string, options: RequestInit) => (client as any).makeRequest(url, options),
};