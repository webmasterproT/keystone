/**
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Attribute values for OpenTelemetry spans and logs.
 * Cloudflare Workers implementation using Web APIs.
 */

/**
 * Type definition for attribute values.
 * Cloudflare Workers support these native types for serialization.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string | number | boolean>
  | null
  | undefined;

/**
 * Interface for attributes (key-value pairs).
 * Used for span attributes, log attributes, and resource attributes.
 */
export interface Attributes {
  [attributeKey: string]: AttributeValue;
}

/**
 * Limits for attribute values in Cloudflare Workers context.
 * Based on Workers KV and R2 payload size limits.
 */
export const ATTRIBUTE_VALUE_LENGTH_LIMIT = 1024 * 1024; // 1MB max value size
export const ATTRIBUTE_COUNT_LIMIT = 128; // Maximum number of attributes per span/log

/**
 * Validates an attribute value for Cloudflare Workers constraints.
 * @param value - The attribute value to validate
 * @returns True if the value is valid, false otherwise
 */
export function isValidAttributeValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    // Check size limits for strings
    if (typeof value === 'string' && value.length > ATTRIBUTE_VALUE_LENGTH_LIMIT) {
      return false;
    }
    return true;
  }

  if (Array.isArray(value)) {
    // Check array size
    if (value.length > ATTRIBUTE_COUNT_LIMIT) {
      return false;
    }

    // All array elements must be valid attribute values
    return value.every(item => 
      item === null || 
      item === undefined || 
      typeof item === 'string' || 
      typeof item === 'number' || 
      typeof item === 'boolean'
    );
  }

  return false;
}

/**
 * Sanitizes attribute key for Cloudflare Workers usage.
 * Ensures keys are valid for Workers KV and Analytics Engine.
 * @param key - The attribute key to sanitize
 * @returns Sanitized key
 */
export function sanitizeAttributeKey(key: string): string {
  // Remove null characters and trim
  let sanitized = key.replace(/\0/g, '').trim();
  
  // Limit key length for Workers KV compatibility
  if (sanitized.length > 512) {
    sanitized = sanitized.substring(0, 512);
  }
  
  return sanitized;
}

/**
 * Sanitizes attribute value for Cloudflare Workers usage.
 * @param value - The attribute value to sanitize
 * @returns Sanitized value or null if invalid
 */
export function sanitizeAttributeValue(value: unknown): AttributeValue {
  if (!isValidAttributeValue(value)) {
    return null;
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    // Truncate strings that are too long
    if (value.length > ATTRIBUTE_VALUE_LENGTH_LIMIT) {
      return value.substring(0, ATTRIBUTE_VALUE_LENGTH_LIMIT);
    }
    return value;
  }

  if (Array.isArray(value)) {
    // Filter out invalid array elements and truncate if needed
    const validItems = value.filter(item => 
      item === null || 
      item === undefined || 
      typeof item === 'string' || 
      typeof item === 'number' || 
      typeof item === 'boolean'
    );
    
    // Truncate array if too large
    if (validItems.length > ATTRIBUTE_COUNT_LIMIT) {
      return validItems.slice(0, ATTRIBUTE_COUNT_LIMIT) as AttributeValue;
    }
    
    return validItems as AttributeValue;
  }

  return value as AttributeValue;
}

/**
 * Sanitizes a complete attributes object for Cloudflare Workers.
 * @param attributes - The attributes object to sanitize
 * @returns Sanitized attributes object
 */
export function sanitizeAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  let count = 0;

  for (const [key, value] of Object.entries(attributes)) {
    if (count >= ATTRIBUTE_COUNT_LIMIT) {
      break;
    }

    const sanitizedKey = sanitizeAttributeKey(key);
    const sanitizedValue = sanitizeAttributeValue(value);

    if (sanitizedValue !== null) {
      result[sanitizedKey] = sanitizedValue;
      count++;
    }
  }

  return result;
}

/**
 * Merges multiple attributes objects with later objects taking precedence.
 * @param attributes - Array of attributes objects to merge
 * @returns Merged attributes object
 */
export function mergeAttributes(...attributes: Attributes[]): Attributes {
  return attributes.reduce((acc, current) => {
    return { ...acc, ...sanitizeAttributes(current) };
  }, {});
}

/**
 * Converts attributes to a format suitable for Cloudflare Workers Analytics Engine.
 * Analytics Engine has specific requirements for data types and sizes.
 * @param attributes - The attributes to convert
 * @returns Analytics Engine compatible data
 */
export function toAnalyticsEngineData(attributes: Attributes): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) {
      continue;
    }

    const sanitizedKey = sanitizeAttributeKey(key);

    if (Array.isArray(value)) {
      // Convert arrays to JSON strings for Analytics Engine
      const jsonString = JSON.stringify(value);
      if (jsonString.length <= ATTRIBUTE_VALUE_LENGTH_LIMIT) {
        result[sanitizedKey] = jsonString;
      }
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[sanitizedKey] = value;
    }
  }

  return result;
}

/**
 * Converts attributes to a format suitable for Cloudflare Workers KV storage.
 * KV requires string values, so we serialize non-string values.
 * @param attributes - The attributes to convert
 * @returns KV compatible data
 */
export function toKVData(attributes: Attributes): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) {
      continue;
    }

    const sanitizedKey = sanitizeAttributeKey(key);
    let stringValue: string;

    if (typeof value === 'string') {
      stringValue = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      stringValue = value.toString();
    } else if (Array.isArray(value)) {
      stringValue = JSON.stringify(value);
    } else {
      continue;
    }

    // Truncate if necessary for KV limits
    if (stringValue.length > ATTRIBUTE_VALUE_LENGTH_LIMIT) {
      stringValue = stringValue.substring(0, ATTRIBUTE_VALUE_LENGTH_LIMIT);
    }

    result[sanitizedKey] = stringValue;
  }

  return result;
}

/**
 * Environment bindings for Cloudflare Workers.
 * Add these to your wrangler.toml or dashboard.
 */
export interface Env {
  // For storing trace data
  TRACES_DB?: D1Database;
  
  // For storing large trace payloads
  TRACES_BUCKET?: R2Bucket;
  
  // For caching trace metadata
  TRACES_KV?: KVNamespace;
  
  // For sending trace data to Analytics Engine
  ANALYTICS_ENGINE?: AnalyticsEngineDataset;
  
  // For authentication (Cloudflare Access JWT)
  AUTH_JWT?: string;
}

/**
 * Stores attributes in Cloudflare Workers storage.
 * Chooses appropriate storage based on data size.
 * @param attributes - The attributes to store
 * @param env - Worker environment bindings
 * @returns Storage location identifier
 */
export async function storeAttributes(
  attributes: Attributes,
  env: Env
): Promise<{ type: 'kv' | 'r2' | 'd1'; id: string }> {
  const sanitized = sanitizeAttributes(attributes);
  const kvData = toKVData(sanitized);
  
  // Calculate total size
  const totalSize = Object.values(kvData).reduce((sum, val) => sum + val.length, 0);
  
  // Choose storage based on size
  if (totalSize <= 25 * 1024 && env.TRACES_KV) {
    // Small data: use KV (25KB limit per value)
    const id = crypto.randomUUID();
    await env.TRACES_KV.put(id, JSON.stringify(kvData), {
      metadata: { type: 'attributes', timestamp: Date.now() }
    });
    return { type: 'kv', id };
  } else if (env.TRACES_BUCKET) {
    // Larger data: use R2
    const id = crypto.randomUUID();
    await env.TRACES_BUCKET.put(id, JSON.stringify(kvData), {
      customMetadata: { type: 'attributes', timestamp: Date.now().toString() }
    });
    return { type: 'r2', id };
  } else if (env.TRACES_DB) {
    // Use D1 as fallback
    const id = crypto.randomUUID();
    await env.TRACES_DB.prepare(
      'INSERT INTO trace_attributes (id, data, created_at) VALUES (?, ?, ?)'
    ).bind(id, JSON.stringify(kvData), Date.now()).run();
    return { type: 'd1', id };
  } else {
    throw new Error('No storage bindings available');
  }
}

/**
 * Retrieves attributes from Cloudflare Workers storage.
 * @param storageInfo - Storage location information
 * @param env - Worker environment bindings
 * @returns Retrieved attributes or null if not found
 */
export async function retrieveAttributes(
  storageInfo: { type: 'kv' | 'r2' | 'd1'; id: string },
  env: Env
): Promise<Attributes | null> {
  try {
    switch (storageInfo.type) {
      case 'kv':
        if (!env.TRACES_KV) return null;
        const kvData = await env.TRACES_KV.get(storageInfo.id, 'json');
        return kvData as Attributes;
        
      case 'r2':
        if (!env.TRACES_BUCKET) return null;
        const r2Object = await env.TRACES_BUCKET.get(storageInfo.id);
        if (!r2Object) return null;
        const text = await r2Object.text();
        return JSON.parse(text) as Attributes;
        
      case 'd1':
        if (!env.TRACES_DB) return null;
        const result = await env.TRACES_DB.prepare(
          'SELECT data FROM trace_attributes WHERE id = ?'
        ).bind(storageInfo.id).first();
        return result ? (JSON.parse(result.data as string) as Attributes) : null;
        
      default:
        return null;
    }
  } catch (error) {
    console.error('Failed to retrieve attributes:', error);
    return null;
  }
}

// NOTE: Original OpenTelemetry Attributes.ts was mostly type definitions.
// This implementation adds Cloudflare Workers-specific utilities for
// storage, serialization, and integration with Workers services.