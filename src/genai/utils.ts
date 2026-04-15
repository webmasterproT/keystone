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

// NOTE: Ported from Google Cloud to Cloudflare Workers
// - Removed Google-specific API key handling
// - Added Cloudflare Workers environment binding support
// - Replaced GenkitError with standard Error
// - Removed process.env usage in favor of Workers env bindings

import { GenerateRequest } from './types.js';
import { extractMedia } from '../common/utils.js';
import { ImagenInstance, VeoImage } from './types.js';

export {
  checkModelName,
  cleanSchema,
  extractText,
  extractVersion,
  modelName,
} from '../common/utils.js';

/**
 * Cloudflare Workers environment bindings for GenAI utilities
 */
export interface Env {
  /** API key for LLM services (stored as secret) */
  AI_API_KEY?: string;
  /** Alternative API key environment variable names */
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GOOGLE_GENAI_API_KEY?: string;
  /** Cloudflare AI binding */
  AI?: any;
  /** Database for storing API key configurations */
  DB?: D1Database;
  /** Encrypted storage for sensitive keys */
  KV?: KVNamespace;
}

/**
 * Error class for GenAI operations in Cloudflare Workers
 */
export class GenAIError extends Error {
  constructor(
    public status: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'GenAIError';
  }
}

export const MISSING_API_KEY_ERROR = new GenAIError(
  'FAILED_PRECONDITION',
  'Please pass in the API key or set the AI_API_KEY environment variable in your Worker configuration.\n' +
    'For more details see https://developers.cloudflare.com/workers/configuration/environment-variables/'
);

export const API_KEY_FALSE_ERROR = new GenAIError(
  'INVALID_ARGUMENT',
  'GenAI plugin was initialized with {apiKey: false} but no apiKey configuration was passed at call time.'
);

/**
 * Retrieves an API key from Cloudflare Workers environment bindings.
 *
 * @param env - Cloudflare Workers environment object
 * @returns The API key as a string, or `undefined` if none of the specified
 *          environment variables are set.
 */
export function getApiKeyFromEnv(env: Env): string | undefined {
  return (
    env.AI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.GOOGLE_API_KEY ||
    env.GOOGLE_GENAI_API_KEY
  );
}

/**
 * Checks and retrieves an API key based on the provided argument and environment bindings.
 *
 * - If `pluginApiKey` is a non-empty string, it's used as the API key.
 * - If `pluginApiKey` is `undefined` or an empty string, it attempts to fetch the API key from environment
 * - If `pluginApiKey` is `false`, key retrieval from the environment is skipped, and the function
 *   will return `undefined`. This mode indicates that the API key is expected to be provided
 *   at a later stage or in a different context.
 *
 * @param pluginApiKey - An optional API key string, `undefined` to check the environment, or `false` to bypass all checks in this function.
 * @param env - Cloudflare Workers environment object
 * @returns The resolved API key as a string, or `undefined` if `pluginApiKey` is `false`.
 * @throws {GenAIError} MISSING_API_KEY_ERROR - Thrown if `pluginApiKey` is not `false` and no API key
 *   can be found either in the `pluginApiKey` argument or from the environment.
 */
export function checkApiKey(
  pluginApiKey: string | false | undefined,
  env: Env
): string | undefined {
  let apiKey: string | undefined;

  // Don't get the key from the environment if pluginApiKey is false
  if (pluginApiKey !== false) {
    apiKey = pluginApiKey || getApiKeyFromEnv(env);
  }

  // If pluginApiKey is false, then we don't throw because we are waiting for
  // the apiKey passed into the individual call
  if (pluginApiKey !== false && !apiKey) {
    throw MISSING_API_KEY_ERROR;
  }
  return apiKey;
}

/**
 * Calculates and returns the effective API key based on multiple potential sources.
 * The order of precedence for determining the API key is:
 * 1. `requestApiKey` (if provided)
 * 2. `pluginApiKey` (if provided and not `false`)
 * 3. Environment binding (if `pluginApiKey` is not `false` and `pluginApiKey` is not provided)
 *
 * @param pluginApiKey - The apiKey value provided during plugin initialization.
 * @param requestApiKey - The apiKey provided to an individual generate call.
 * @param env - Cloudflare Workers environment object
 * @returns The resolved API key as a string.
 * @throws {GenAIError} API_KEY_FALSE_ERROR - Thrown if `pluginApiKey` is `false` and `requestApiKey` is not provided
 * @throws {GenAIError} MISSING_API_KEY_ERROR - Thrown if no API key can be resolved from any source
 */
export function calculateApiKey(
  pluginApiKey: string | false | undefined,
  requestApiKey: string | undefined,
  env: Env
): string {
  let apiKey: string | undefined;

  // Don't get the key from the environment if pluginApiKey is false
  if (pluginApiKey !== false) {
    apiKey = pluginApiKey || getApiKeyFromEnv(env);
  }

  apiKey = requestApiKey || apiKey;

  if (pluginApiKey === false && !requestApiKey) {
    throw API_KEY_FALSE_ERROR;
  }

  if (!apiKey) {
    throw MISSING_API_KEY_ERROR;
  }
  return apiKey;
}

/**
 * Extracts Veo image data from a GenerateRequest.
 * 
 * @param request - The generate request containing media content
 * @returns VeoImage object or undefined if no image found
 * @throws {GenAIError} If image is found but content type is missing
 */
export function extractVeoImage(
  request: GenerateRequest
): VeoImage | undefined {
  const media = request.messages.at(-1)?.content.find((p) => !!p.media)?.media;
  if (media) {
    const img = media.url.split(',')[1];
    if (img && media.contentType) {
      return {
        bytesBase64Encoded: img,
        mimeType: media.contentType!,
      };
    } else if (img) {
      // Content Type is not optional
      throw new GenAIError(
        'INVALID_ARGUMENT',
        'content type is required for images'
      );
    }
  }
  return undefined;
}

/**
 * Extracts Imagen image data from a GenerateRequest.
 * 
 * @param request - The generate request containing media content
 * @returns Imagen image object or undefined if no image found
 */
export function extractImagenImage(
  request: GenerateRequest
): ImagenInstance['image'] | undefined {
  const image = extractMedia(request, {
    metadataType: 'base',
    isDefault: true,
  })?.url.split(',')[1];

  if (image) {
    return { bytesBase64Encoded: image };
  }
  return undefined;
}

/**
 * Safely retrieves an API key from Cloudflare KV storage.
 * This is useful for rotating keys or managing multiple keys.
 * 
 * @param kv - Cloudflare KV namespace
 * @param keyName - The key name in KV (default: 'ai-api-key')
 * @returns The API key or undefined if not found
 */
export async function getApiKeyFromKV(
  kv: KVNamespace,
  keyName: string = 'ai-api-key'
): Promise<string | undefined> {
  return await kv.get(keyName);
}

/**
 * Validates an API key format (basic validation).
 * 
 * @param apiKey - The API key to validate
 * @returns True if the key appears valid
 */
export function validateApiKeyFormat(apiKey: string): boolean {
  // Basic validation - adjust based on your API key format
  return apiKey.length > 10 && /^[A-Za-z0-9_\-]+$/.test(apiKey);
}

/**
 * Creates a secure API key configuration for Cloudflare Workers.
 * This can be used to store encrypted keys or rotate keys automatically.
 * 
 * @param env - Cloudflare Workers environment
 * @param keyName - The name of the key to use
 * @returns A configured API key or throws an error
 */
export async function getSecureApiKey(
  env: Env,
  keyName: string = 'default'
): Promise<string> {
  // Try environment variables first
  const envKey = getApiKeyFromEnv(env);
  if (envKey) return envKey;

  // Try KV storage if available
  if (env.KV) {
    const kvKey = await getApiKeyFromKV(env.KV, `ai-api-key-${keyName}`);
    if (kvKey) return kvKey;
  }

  // Try database if available
  if (env.DB) {
    try {
      const result = await env.DB
        .prepare('SELECT api_key FROM api_keys WHERE name = ? AND active = 1')
        .bind(keyName)
        .first<{ api_key: string }>();
      
      if (result?.api_key) {
        return result.api_key;
      }
    } catch (error) {
      // Log but don't fail - fall through to error
      console.warn('Failed to fetch API key from database:', error);
    }
  }

  throw MISSING_API_KEY_ERROR;
}