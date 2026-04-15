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
 * AnyValue represents a dynamically typed value which can be either
 * null, a string, boolean, number, array of AnyValue, or key-value pairs.
 * This is used for OpenTelemetry attribute values in Cloudflare Workers.
 */
export type AnyValue =
  | null
  | string
  | boolean
  | number
  | Array<AnyValue>
  | { [key: string]: AnyValue };

/**
 * Type guard to check if a value is an AnyValue array
 */
export function isAnyValueArray(value: unknown): value is Array<AnyValue> {
  return Array.isArray(value);
}

/**
 * Type guard to check if a value is an AnyValue object
 */
export function isAnyValueObject(value: unknown): value is { [key: string]: AnyValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a primitive AnyValue
 */
export function isAnyValuePrimitive(value: unknown): value is string | boolean | number | null {
  return value === null || 
         typeof value === 'string' || 
         typeof value === 'boolean' || 
         typeof value === 'number';
}

/**
 * Serialize AnyValue to JSON string
 * NOTE: Cloudflare Workers use standard JSON serialization
 */
export function serializeAnyValue(value: AnyValue): string {
  return JSON.stringify(value);
}

/**
 * Parse JSON string to AnyValue
 * NOTE: Cloudflare Workers use standard JSON parsing
 */
export function parseAnyValue(json: string): AnyValue {
  return JSON.parse(json);
}

/**
 * Convert AnyValue to a format suitable for Cloudflare Workers Analytics Engine
 * Analytics Engine only supports numeric values, so we convert other types
 */
export function toAnalyticsEngineValue(value: AnyValue): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    // Try to parse as number, otherwise use hash
    const num = Number(value);
    if (!isNaN(num)) return num;
    
    // Use simple hash for string values
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0; // Convert to 32-bit integer
    }
    return hash;
  }
  
  // For arrays and objects, use hash of JSON string
  const str = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Convert AnyValue to a format suitable for Cloudflare Logpush
 * Logpush can handle structured JSON logs
 */
export function toLogpushData(value: AnyValue): unknown {
  return value;
}

/**
 * Extract string value from AnyValue if possible
 */
export function extractString(value: AnyValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return JSON.stringify(value);
}

/**
 * Extract numeric value from AnyValue if possible
 */
export function extractNumber(value: AnyValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const num = Number(value);
    return isNaN(num) ? null : num;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

/**
 * Extract boolean value from AnyValue if possible
 */
export function extractBoolean(value: AnyValue): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return null;
}

/**
 * Flatten AnyValue object for use in URL query parameters or headers
 */
export function flattenAnyValue(value: AnyValue, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  
  if (value === null) {
    result[prefix || 'value'] = 'null';
  } else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    result[prefix || 'value'] = String(value);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const newPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      Object.assign(result, flattenAnyValue(item, newPrefix));
    });
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([key, val]) => {
      const newPrefix = prefix ? `${prefix}.${key}` : key;
      Object.assign(result, flattenAnyValue(val, newPrefix));
    });
  }
  
  return result;
}

/**
 * Cloudflare Workers environment bindings that might use AnyValue
 */
export interface TraceEnv {
  // For storing trace data
  TRACES_DB?: D1Database;
  TRACES_KV?: KVNamespace;
  TRACES_R2?: R2Bucket;
  
  // For analytics
  ANALYTICS?: AnalyticsEngineDataset;
  
  // For authentication (Cloudflare Access)
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  
  // For external APIs
  LLM_API_KEY?: string;
  LLM_API_URL?: string;
}

/**
 * Store AnyValue in Cloudflare KV with automatic serialization
 */
export async function storeInKV(
  kv: KVNamespace,
  key: string,
  value: AnyValue,
  options?: KVNamespacePutOptions
): Promise<void> {
  const serialized = serializeAnyValue(value);
  await kv.put(key, serialized, options);
}

/**
 * Retrieve AnyValue from Cloudflare KV with automatic parsing
 */
export async function retrieveFromKV(
  kv: KVNamespace,
  key: string
): Promise<AnyValue | null> {
  const value = await kv.get(key);
  return value ? parseAnyValue(value) : null;
}

/**
 * Store AnyValue in D1 database
 * NOTE: D1 is SQLite-based, so we need to serialize to JSON
 */
export async function storeInD1(
  db: D1Database,
  table: string,
  id: string,
  value: AnyValue
): Promise<void> {
  const serialized = serializeAnyValue(value);
  await db
    .prepare(`INSERT OR REPLACE INTO ${table} (id, value) VALUES (?, ?)`)
    .bind(id, serialized)
    .run();
}

/**
 * Retrieve AnyValue from D1 database
 */
export async function retrieveFromD1(
  db: D1Database,
  table: string,
  id: string
): Promise<AnyValue | null> {
  const result = await db
    .prepare(`SELECT value FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ value: string }>();
  
  return result ? parseAnyValue(result.value) : null;
}