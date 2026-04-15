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

import { validateKey, validateValue } from './tracestate-validators';

const MAX_TRACE_STATE_ITEMS = 32;
const MAX_TRACE_STATE_LEN = 512;
const LIST_MEMBERS_SEPARATOR = ',';
const LIST_MEMBER_KEY_VALUE_SPLITTER = '=';

/**
 * TraceState implementation for Cloudflare Workers.
 * 
 * This class manages the tracestate header as defined in the W3C Trace Context specification.
 * It's designed to work with Cloudflare Workers' request/response model and can be used
 * with Cloudflare's observability features like Logpush and Workers Analytics Engine.
 * 
 * @see https://www.w3.org/TR/trace-context/#tracestate-field
 */
export class TraceStateImpl {
  private _internalState = new Map<string, string>();

  /**
   * Creates a new TraceState instance.
   * 
   * @param rawTraceState - Optional raw tracestate header string to parse
   */
  constructor(rawTraceState?: string) {
    if (rawTraceState) {
      this._parse(rawTraceState);
    }
  }

  /**
   * Sets a key-value pair in the tracestate.
   * The key-value pair is added to the beginning of the list as per W3C spec.
   * If the key already exists, it's moved to the beginning with the new value.
   * 
   * @param key - The key to set
   * @param value - The value to set
   * @returns A new TraceState instance with the updated state
   */
  set(key: string, value: string): TraceStateImpl {
    const traceState = this._clone();
    
    // Remove existing key if present (will be re-added at beginning)
    if (traceState._internalState.has(key)) {
      traceState._internalState.delete(key);
    }
    
    traceState._internalState.set(key, value);
    return traceState;
  }

  /**
   * Removes a key-value pair from the tracestate.
   * 
   * @param key - The key to remove
   * @returns A new TraceState instance with the key removed
   */
  unset(key: string): TraceStateImpl {
    const traceState = this._clone();
    traceState._internalState.delete(key);
    return traceState;
  }

  /**
   * Gets the value for a key from the tracestate.
   * 
   * @param key - The key to look up
   * @returns The value associated with the key, or undefined if not found
   */
  get(key: string): string | undefined {
    return this._internalState.get(key);
  }

  /**
   * Serializes the tracestate to a string suitable for HTTP headers.
   * 
   * @returns The serialized tracestate string
   */
  serialize(): string {
    return this._keys()
      .reduce((agg: string[], key) => {
        const value = this.get(key);
        if (value !== undefined) {
          agg.push(`${key}${LIST_MEMBER_KEY_VALUE_SPLITTER}${value}`);
        }
        return agg;
      }, [])
      .join(LIST_MEMBERS_SEPARATOR);
  }

  /**
   * Gets all keys in the tracestate in the correct order (newest first).
   * 
   * @returns Array of keys in order
   */
  keys(): string[] {
    return this._keys();
  }

  /**
   * Gets all entries in the tracestate as key-value pairs.
   * 
   * @returns Array of [key, value] pairs in order (newest first)
   */
  entries(): Array<[string, string]> {
    return this._keys().map(key => [key, this.get(key)!]);
  }

  /**
   * Gets the number of key-value pairs in the tracestate.
   * 
   * @returns The size of the tracestate
   */
  size(): number {
    return this._internalState.size;
  }

  /**
   * Creates a copy of this TraceState instance.
   * 
   * @returns A new TraceState instance with the same state
   */
  clone(): TraceStateImpl {
    return this._clone();
  }

  /**
   * Parses a raw tracestate header string.
   * 
   * @param rawTraceState - The raw tracestate header string
   */
  private _parse(rawTraceState: string): void {
    // Validate total length
    if (rawTraceState.length > MAX_TRACE_STATE_LEN) {
      return;
    }

    // Split by comma and process in reverse order
    // This ensures that when we serialize, newer entries come first
    const entries = rawTraceState
      .split(LIST_MEMBERS_SEPARATOR)
      .reverse()
      .reduce((map, part) => {
        const listMember = part.trim(); // Handle optional whitespace
        
        const splitIndex = listMember.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
        if (splitIndex !== -1) {
          const key = listMember.slice(0, splitIndex);
          const value = listMember.slice(splitIndex + 1);
          
          if (validateKey(key) && validateValue(value)) {
            map.set(key, value);
          }
          // Invalid entries are silently dropped as per spec
        }
        
        return map;
      }, new Map<string, string>());

    // Apply size limit (truncate oldest entries)
    if (entries.size > MAX_TRACE_STATE_ITEMS) {
      const entriesArray = Array.from(entries.entries());
      // Reverse to maintain correct order after truncation
      const truncatedEntries = entriesArray
        .reverse()
        .slice(0, MAX_TRACE_STATE_ITEMS);
      
      this._internalState = new Map(truncatedEntries);
    } else {
      this._internalState = entries;
    }
  }

  /**
   * Gets keys in serialization order (newest first).
   */
  private _keys(): string[] {
    return Array.from(this._internalState.keys()).reverse();
  }

  /**
   * Creates a shallow clone of this instance.
   */
  private _clone(): TraceStateImpl {
    const traceState = new TraceStateImpl();
    traceState._internalState = new Map(this._internalState);
    return traceState;
  }
}

// NOTE: This implementation is a direct port of the OpenTelemetry TraceState
// implementation for use in Cloudflare Workers. It maintains full compatibility
// with W3C Trace Context specification and can be used with Cloudflare's
// observability stack including Logpush and Workers Analytics Engine.