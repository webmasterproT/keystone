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

// NOTE: Ported from Google Gemini API types to generic LLM interface for Cloudflare Workers
// - Removed Google-specific types (GoogleSearchRetrievalTool, Imagen, Veo)
// - Added generic LLM provider support (OpenAI, Anthropic, DeepSeek, etc.)
// - Simplified for Cloudflare Workers runtime

/**
 * Cloudflare Workers environment bindings for GenAI operations
 */
export interface Env {
  /** D1 database for storing conversation history, embeddings, etc. */
  DB: D1Database;
  
  /** R2 bucket for storing generated images, videos, and other media */
  BUCKET: R2Bucket;
  
  /** KV namespace for caching embeddings, model responses, etc. */
  KV: KVNamespace;
  
  /** Cloudflare Access JWT for authentication */
  ACCESS_JWT?: string;
  
  /** API keys for various LLM providers (stored as secrets) */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  
  /** Analytics Engine for logging and metrics */
  AI_ANALYTICS?: AnalyticsEngineDataset;
}

/**
 * Content part types for multimodal inputs
 */
export type Part = TextPart | ImagePart | FilePart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  image: {
    /** Base64 encoded image data */
    data: string;
    /** MIME type (e.g., image/jpeg, image/png) */
    mimeType: string;
  };
}

export interface FilePart {
  type: 'file';
  file: {
    /** Base64 encoded file data */
    data: string;
    /** MIME type */
    mimeType: string;
    /** Original filename */
    filename?: string;
  };
}

/**
 * Content container for messages
 */
export interface Content {
  role: 'user' | 'assistant' | 'system';
  parts: Part[];
}

/**
 * Generation configuration
 */
export interface GenerationConfig {
  /** Sampling temperature (0.0 to 2.0) */
  temperature?: number;
  
  /** Top-p sampling (0.0 to 1.0) */
  topP?: number;
  
  /** Top-k sampling (1 to infinity) */
  topK?: number;
  
  /** Maximum tokens to generate */
  maxTokens?: number;
  
  /** Stop sequences */
  stopSequences?: string[];
  
  /** Presence penalty (-2.0 to 2.0) */
  presencePenalty?: number;
  
  /** Frequency penalty (-2.0 to 2.0) */
  frequencyPenalty?: number;
}

/**
 * Safety settings for content filtering
 */
export interface SafetySetting {
  category: SafetyCategory;
  threshold: SafetyThreshold;
}

export enum SafetyCategory {
  HARM_CATEGORY_HARASSMENT = 'HARM_CATEGORY_HARASSMENT',
  HARM_CATEGORY_HATE_SPEECH = 'HARM_CATEGORY_HATE_SPEECH',
  HARM_CATEGORY_SEXUALLY_EXPLICIT = 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  HARM_CATEGORY_DANGEROUS_CONTENT = 'HARM_CATEGORY_DANGEROUS_CONTENT',
}

export enum SafetyThreshold {
  BLOCK_NONE = 'BLOCK_NONE',
  BLOCK_LOW_AND_ABOVE = 'BLOCK_LOW_AND_ABOVE',
  BLOCK_MEDIUM_AND_ABOVE = 'BLOCK_MEDIUM_AND_ABOVE',
  BLOCK_ONLY_HIGH = 'BLOCK_ONLY_HIGH',
}

/**
 * Tool definitions for function calling
 */
export interface Tool {
  functionDeclarations?: FunctionDeclaration[];
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolConfig {
  functionCallingConfig?: {
    mode?: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

/**
 * LLM provider configuration
 */
export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  DEEPSEEK = 'deepseek',
  CLOUDFLARE = 'cloudflare',
}

/**
 * Cloudflare-specific GenAI options
 */
export interface CloudflareGenAIOptions {
  /**
   * LLM provider to use. Defaults to environment variable or first available.
   */
  provider?: LLMProvider;
  
  /**
   * API key for the selected provider. If not provided, uses environment variable.
   */
  apiKey?: string;
  
  /**
   * Model name to use (e.g., 'gpt-4-turbo', 'claude-3-opus', 'deepseek-chat')
   */
  model?: string;
  
  /**
   * Base URL for API calls. Defaults to provider's standard endpoint.
   */
  baseUrl?: string;
  
  /**
   * Cloudflare Access JWT for authentication. If not provided, uses binding.
   */
  accessToken?: string;
  
  /**
   * Enable debug logging to Cloudflare Analytics Engine
   */
  debugLogging?: boolean;
}

/**
 * Request for generating content
 */
export interface GenerateContentRequest {
  contents: Content[];
  generationConfig?: GenerationConfig;
  safetySettings?: SafetySetting[];
  tools?: Tool[];
  toolConfig?: ToolConfig;
  systemInstruction?: string;
}

/**
 * Response candidate from generation
 */
export interface GenerateContentCandidate {
  index: number;
  content: Content;
  finishReason?: FinishReason;
  safetyRatings?: SafetyRating[];
  citationMetadata?: CitationMetadata;
}

export enum FinishReason {
  FINISH_REASON_UNSPECIFIED = 'FINISH_REASON_UNSPECIFIED',
  STOP = 'STOP',
  MAX_TOKENS = 'MAX_TOKENS',
  SAFETY = 'SAFETY',
  RECITATION = 'RECITATION',
  OTHER = 'OTHER',
}

export interface SafetyRating {
  category: SafetyCategory;
  probability: 'NEGLIGIBLE' | 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface CitationMetadata {
  citationSources: CitationSource[];
}

export interface CitationSource {
  startIndex?: number;
  endIndex?: number;
  uri?: string;
  license?: string;
}

/**
 * Response from generateContent
 */
export interface GenerateContentResponse {
  candidates: GenerateContentCandidate[];
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
}

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

/**
 * Stream result for streaming responses
 */
export interface GenerateContentStreamResult {
  stream: ReadableStream<GenerateContentResponse>;
}

/**
 * Request for embedding content
 */
export interface EmbedContentRequest {
  content: Content;
  taskType?: TaskType;
  title?: string;
}

export enum TaskType {
  TASK_TYPE_UNSPECIFIED = 'TASK_TYPE_UNSPECIFIED',
  RETRIEVAL_QUERY = 'RETRIEVAL_QUERY',
  RETRIEVAL_DOCUMENT = 'RETRIEVAL_DOCUMENT',
  SEMANTIC_SIMILARITY = 'SEMANTIC_SIMILARITY',
  CLASSIFICATION = 'CLASSIFICATION',
  CLUSTERING = 'CLUSTERING',
}

/**
 * Response from embedContent
 */
export interface EmbedContentResponse {
  embedding: ContentEmbedding;
}

export interface ContentEmbedding {
  values: number[];
}

/**
 * Model information
 */
export interface Model {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
  provider: LLMProvider;
}

/**
 * Response from listModels
 */
export interface ListModelsResponse {
  models: Model[];
}

/**
 * Client options for GenAI operations
 */
export interface ClientOptions {
  /**
   * AbortSignal for cancelling requests
   */
  signal?: AbortSignal;
  
  /**
   * Request timeout in milliseconds
   */
  timeout?: number;
  
  /**
   * Custom headers
   */
  headers?: Record<string, string>;
  
  /**
   * Cloudflare-specific options
   */
  cf?: {
    /**
     * Cache TTL in seconds
     */
    cacheTtl?: number;
    
    /**
     * Cache key for response caching
     */
    cacheKey?: string;
  };
}

/**
 * Media generation request (for future image/video generation support)
 */
export interface MediaGenerateRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  count?: number;
  quality?: 'standard' | 'hd';
}

export interface MediaGenerateResponse {
  media: MediaItem[];
  operationId?: string;
}

export interface MediaItem {
  /** R2 object key where media is stored */
  key: string;
  
  /** Public URL for accessing the media */
  url: string;
  
  /** MIME type */
  mimeType: string;
  
  /** Size in bytes */
  size: number;
}

/**
 * Task type schema for validation
 */
export const TaskTypeSchema = {
  [TaskType.TASK_TYPE_UNSPECIFIED]: 'TASK_TYPE_UNSPECIFIED',
  [TaskType.RETRIEVAL_QUERY]: 'RETRIEVAL_QUERY',
  [TaskType.RETRIEVAL_DOCUMENT]: 'RETRIEVAL_DOCUMENT',
  [TaskType.SEMANTIC_SIMILARITY]: 'SEMANTIC_SIMILARITY',
  [TaskType.CLASSIFICATION]: 'CLASSIFICATION',
  [TaskType.CLUSTERING]: 'CLUSTERING',
} as const;

// Export all types
export type {
  Content,
  GenerateContentCandidate,
  GenerateContentRequest,
  GenerateContentResponse,
  GenerateContentStreamResult,
  GenerationConfig,
  SafetySetting,
  Tool,
  ToolConfig,
  EmbedContentRequest,
  EmbedContentResponse,
  ContentEmbedding,
  Model,
  ListModelsResponse,
  ClientOptions,
  MediaGenerateRequest,
  MediaGenerateResponse,
  MediaItem,
};

export {
  FinishReason,
  SafetyCategory,
  SafetyThreshold,
  TaskType,
  TaskTypeSchema,
  LLMProvider,
};