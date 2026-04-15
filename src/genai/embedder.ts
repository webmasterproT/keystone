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
 *
 * Ported to Cloudflare Workers
 * - Replaced Google AI API with generic LLM interface
 * - Uses Cloudflare Workers secrets for API keys
 * - Uses Web Crypto API for security
 * - Designed for Cloudflare Workers runtime
 */

export interface EmbedderEnv {
  /** API key for embedding service (stored as Workers secret) */
  EMBED_API_KEY?: string;
  
  /** Base URL for embedding API endpoint */
  EMBED_API_URL?: string;
  
  /** Optional KV namespace for caching embeddings */
  EMBED_CACHE?: KVNamespace;
  
  /** Optional D1 database for storing embedding metadata */
  DB?: D1Database;
  
  /** Optional R2 bucket for storing large embedding datasets */
  EMBED_STORAGE?: R2Bucket;
}

export interface EmbeddingConfig {
  /** Override the API key provided at plugin initialization. */
  apiKey?: string;
  
  /**
   * The `task_type` parameter is defined as the intended downstream application to help the model
   * produce better quality embeddings.
   */
  taskType?: TaskType;
  
  title?: string;
  version?: string;
  
  /**
   * The `outputDimensionality` parameter allows you to specify the dimensionality of the embedding output.
   * By default, the model generates embeddings with 768 dimensions. Some models allow the output
   * dimensionality to be adjusted between 1 and 768.
   * By selecting a smaller output dimensionality, users can save memory and storage space, leading to more efficient computations.
   */
  outputDimensionality?: number;
  
  /** Cache TTL in seconds (0 = no cache) */
  cacheTtl?: number;
  
  /** Whether to store embeddings in R2 for long-term storage */
  persistToR2?: boolean;
}

export interface EmbeddingRequest {
  content: string;
  config?: EmbeddingConfig;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
  dimensions: number;
  cached?: boolean;
  storageKey?: string;
}

export interface BatchEmbeddingResponse {
  embeddings: EmbeddingResponse[];
}

export interface EmbedderInfo {
  dimensions: number;
  supports: {
    input: string[];
  };
  maxBatchSize?: number;
  rateLimit?: {
    requestsPerMinute: number;
  };
}

export interface EmbedderReference {
  name: string;
  info: EmbedderInfo;
  configSchema?: any;
}

export type TaskType = 
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING';

export const TaskTypeSchema = {
  RETRIEVAL_QUERY: 'RETRIEVAL_QUERY',
  RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT',
  SEMANTIC_SIMILARITY: 'SEMANTIC_SIMILARITY',
  CLASSIFICATION: 'CLASSIFICATION',
  CLUSTERING: 'CLUSTERING'
} as const;

// NOTE: Replaced Google-specific model references with generic LLM interface
const KNOWN_MODELS = {
  'text-embedding-3-small': {
    name: 'text-embedding-3-small',
    dimensions: 1536,
    maxBatchSize: 100
  },
  'text-embedding-3-large': {
    name: 'text-embedding-3-large',
    dimensions: 3072,
    maxBatchSize: 50
  },
  'multilingual-e5-large': {
    name: 'multilingual-e5-large',
    dimensions: 1024,
    maxBatchSize: 100
  }
};

export type KnownModels = keyof typeof KNOWN_MODELS;

/**
 * Cloudflare Workers Embedder for LLM embedding services
 * Supports multiple embedding providers (OpenAI, Anthropic, Cohere, etc.)
 */
export class CloudflareEmbedder {
  private env: EmbedderEnv;
  private defaultModel: string;
  
  constructor(env: EmbedderEnv, defaultModel: KnownModels = 'text-embedding-3-small') {
    this.env = env;
    this.defaultModel = defaultModel;
  }
  
  /**
   * Generate embeddings for a single text
   */
  async embed(
    content: string,
    config?: EmbeddingConfig
  ): Promise<EmbeddingResponse> {
    const cacheKey = await this.generateCacheKey(content, config);
    
    // Check cache first
    if (config?.cacheTtl && this.env.EMBED_CACHE) {
      const cached = await this.env.EMBED_CACHE.get(cacheKey, 'json');
      if (cached) {
        return { ...cached as EmbeddingResponse, cached: true };
      }
    }
    
    // Generate embedding
    const embedding = await this.callEmbeddingAPI(content, config);
    const response: EmbeddingResponse = {
      embedding,
      model: config?.version || this.defaultModel,
      dimensions: embedding.length
    };
    
    // Cache if configured
    if (config?.cacheTtl && this.env.EMBED_CACHE) {
      await this.env.EMBED_CACHE.put(
        cacheKey,
        JSON.stringify(response),
        { expirationTtl: config.cacheTtl }
      );
    }
    
    // Store in R2 if configured
    if (config?.persistToR2 && this.env.EMBED_STORAGE) {
      const storageKey = `embeddings/${Date.now()}-${crypto.randomUUID()}.json`;
      await this.env.EMBED_STORAGE.put(storageKey, JSON.stringify({
        content,
        embedding,
        config,
        timestamp: new Date().toISOString()
      }));
      response.storageKey = storageKey;
    }
    
    return response;
  }
  
  /**
   * Generate embeddings for multiple texts in batch
   */
  async embedBatch(
    contents: string[],
    config?: EmbeddingConfig
  ): Promise<BatchEmbeddingResponse> {
    const modelInfo = KNOWN_MODELS[this.defaultModel as KnownModels] || KNOWN_MODELS['text-embedding-3-small'];
    const batchSize = Math.min(contents.length, modelInfo.maxBatchSize || 100);
    
    const embeddings: EmbeddingResponse[] = [];
    
    // Process in batches to respect rate limits
    for (let i = 0; i < contents.length; i += batchSize) {
      const batch = contents.slice(i, i + batchSize);
      const batchPromises = batch.map(content => this.embed(content, config));
      const batchResults = await Promise.all(batchPromises);
      embeddings.push(...batchResults);
      
      // Rate limiting
      if (i + batchSize < contents.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between batches
      }
    }
    
    return { embeddings };
  }
  
  /**
   * Get embedder information for a specific model
   */
  getEmbedderInfo(modelName?: string): EmbedderInfo {
    const model = modelName || this.defaultModel;
    const modelInfo = KNOWN_MODELS[model as KnownModels] || KNOWN_MODELS['text-embedding-3-small'];
    
    return {
      dimensions: modelInfo.dimensions,
      supports: {
        input: ['text']
      },
      maxBatchSize: modelInfo.maxBatchSize,
      rateLimit: {
        requestsPerMinute: 60 // Default rate limit
      }
    };
  }
  
  /**
   * List all available embedding models
   */
  listModels(): Array<{name: string; info: EmbedderInfo}> {
    return Object.entries(KNOWN_MODELS).map(([name, info]) => ({
      name,
      info: {
        dimensions: info.dimensions,
        supports: { input: ['text'] },
        maxBatchSize: info.maxBatchSize
      }
    }));
  }
  
  /**
   * Generate a cache key for embedding content
   */
  private async generateCacheKey(content: string, config?: EmbeddingConfig): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${content}:${JSON.stringify(config || {})}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return `embed:${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }
  
  /**
   * Call the embedding API (supports multiple providers)
   */
  private async callEmbeddingAPI(
    content: string,
    config?: EmbeddingConfig
  ): Promise<number[]> {
    const apiKey = config?.apiKey || this.env.EMBED_API_KEY;
    if (!apiKey) {
      throw new Error('Embedding API key not configured');
    }
    
    const model = config?.version || this.defaultModel;
    const apiUrl = this.env.EMBED_API_URL || 'https://api.openai.com/v1/embeddings';
    
    // NOTE: Generic LLM interface - supports OpenAI-compatible APIs
    const requestBody: any = {
      input: content,
      model: model
    };
    
    if (config?.taskType) {
      requestBody.task_type = config.taskType;
    }
    
    if (config?.outputDimensionality) {
      requestBody.dimensions = config.outputDimensionality;
    }
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API error: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    
    // Handle different API response formats
    if (data.data && data.data[0] && data.data[0].embedding) {
      return data.data[0].embedding;
    } else if (data.embedding) {
      return data.embedding;
    } else if (Array.isArray(data)) {
      return data;
    }
    
    throw new Error('Invalid embedding API response format');
  }
  
  /**
   * Search for similar embeddings using vector similarity
   * NOTE: This is a simplified version - in production you'd use a vector database
   */
  async searchSimilar(
    queryEmbedding: number[],
    limit: number = 10
  ): Promise<Array<{content: string; similarity: number}>> {
    if (!this.env.DB) {
      throw new Error('D1 database not configured for similarity search');
    }
    
    // Convert embedding to SQLite-friendly format
    const embeddingJson = JSON.stringify(queryEmbedding);
    
    // NOTE: This is a simplified cosine similarity calculation
    // For production, consider using a dedicated vector database
    const results = await this.env.DB.prepare(`
      SELECT content, embedding
      FROM embeddings
      ORDER BY (
        SELECT SUM(v1.value * v2.value) / 
               (SQRT(SUM(v1.value * v1.value)) * SQRT(SUM(v2.value * v2.value)))
        FROM json_each(embedding) AS v1
        JOIN json_each(?) AS v2 ON v1.key = v2.key
      ) DESC
      LIMIT ?
    `).bind(embeddingJson, limit).all();
    
    return results.results.map((row: any) => ({
      content: row.content,
      similarity: this.calculateCosineSimilarity(queryEmbedding, JSON.parse(row.embedding))
    }));
  }
  
  /**
   * Calculate cosine similarity between two vectors
   */
  private calculateCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// Export utility functions
export function createEmbedderRef(
  name: string,
  info: EmbedderInfo
): EmbedderReference {
  return {
    name: `cloudflare/${name}`,
    info
  };
}

export function getModelInfo(modelName: KnownModels): EmbedderInfo {
  const model = KNOWN_MODELS[modelName];
  return {
    dimensions: model.dimensions,
    supports: {
      input: ['text']
    },
    maxBatchSize: model.maxBatchSize
  };
}

// Test utilities
export const TEST_ONLY = {
  KNOWN_MODELS,
  calculateCosineSimilarity: (a: number[], b: number[]) => {
    const embedder = new CloudflareEmbedder({});
    return (embedder as any).calculateCosineSimilarity(a, b);
  }
};