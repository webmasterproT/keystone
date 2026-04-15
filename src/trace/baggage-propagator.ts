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

// NOTE: Ported from OpenTelemetry W3CBaggagePropagator to Cloudflare Workers
// This implements W3C Baggage propagation for distributed tracing in Workers
// Uses Cloudflare's Request/Response context instead of OpenTelemetry Context

export interface BaggageEntry {
  value: string;
  metadata?: Record<string, string>;
}

export interface Baggage {
  [key: string]: BaggageEntry;
}

export interface PropagationContext {
  baggage?: Baggage;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface Carrier {
  headers: Headers;
}

export interface Getter {
  get(carrier: Carrier, key: string): string | string[] | undefined;
}

export interface Setter {
  set(carrier: Carrier, key: string, value: string): void;
}

export const BAGGAGE_HEADER = 'baggage';
export const BAGGAGE_ITEMS_SEPARATOR = ',';
export const BAGGAGE_MAX_NAME_VALUE_PAIRS = 180;
export const BAGGAGE_MAX_PER_NAME_VALUE_PAIRS = 4096;

/**
 * Cloudflare Workers environment bindings for tracing
 */
export interface TracingEnv {
  // Workers Analytics Engine for trace storage
  TRACES?: AnalyticsEngineDataset;
  // KV for trace context storage
  TRACE_KV?: KVNamespace;
  // D1 for structured trace storage
  TRACE_DB?: D1Database;
}

/**
 * Propagates Baggage through W3C Baggage header format propagation.
 * Based on the Baggage specification: https://w3c.github.io/baggage/
 */
export class W3CBaggagePropagator {
  /**
   * Injects baggage from context into carrier headers
   */
  inject(context: PropagationContext, carrier: Carrier, setter: Setter): void {
    const baggage = context.baggage;
    if (!baggage) return;

    const keyPairs = this.getKeyPairs(baggage)
      .filter((pair) => {
        return pair.length <= BAGGAGE_MAX_PER_NAME_VALUE_PAIRS;
      })
      .slice(0, BAGGAGE_MAX_NAME_VALUE_PAIRS);

    const headerValue = this.serializeKeyPairs(keyPairs);
    if (headerValue.length > 0) {
      setter.set(carrier, BAGGAGE_HEADER, headerValue);
    }
  }

  /**
   * Extracts baggage from carrier headers into context
   */
  extract(context: PropagationContext, carrier: Carrier, getter: Getter): PropagationContext {
    const headerValue = getter.get(carrier, BAGGAGE_HEADER);
    const baggageString = Array.isArray(headerValue)
      ? headerValue.join(BAGGAGE_ITEMS_SEPARATOR)
      : headerValue;

    if (!baggageString) return context;

    const baggage: Baggage = {};
    if (baggageString.length === 0) {
      return { ...context, baggage };
    }

    const pairs = baggageString.split(BAGGAGE_ITEMS_SEPARATOR);
    pairs.forEach(entry => {
      const keyPair = this.parsePairKeyValue(entry);
      if (keyPair) {
        const baggageEntry: BaggageEntry = { value: keyPair.value };
        if (keyPair.metadata) {
          baggageEntry.metadata = keyPair.metadata;
        }
        baggage[keyPair.key] = baggageEntry;
      }
    });

    if (Object.entries(baggage).length === 0) {
      return context;
    }

    return { ...context, baggage };
  }

  /**
   * Returns the header fields used by this propagator
   */
  fields(): string[] {
    return [BAGGAGE_HEADER];
  }

  /**
   * Helper to get key-value pairs from baggage
   */
  private getKeyPairs(baggage: Baggage): string[] {
    return Object.entries(baggage).map(([key, entry]) => {
      let pair = `${key}=${encodeURIComponent(entry.value)}`;
      if (entry.metadata) {
        const metadataStr = Object.entries(entry.metadata)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join(';');
        pair += `;${metadataStr}`;
      }
      return pair;
    });
  }

  /**
   * Helper to serialize key pairs into header value
   */
  private serializeKeyPairs(keyPairs: string[]): string {
    return keyPairs.join(BAGGAGE_ITEMS_SEPARATOR);
  }

  /**
   * Helper to parse key-value pair from baggage string
   */
  private parsePairKeyValue(entry: string): { key: string; value: string; metadata?: Record<string, string> } | null {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) return null;

    const key = trimmed.substring(0, equalsIndex).trim();
    const rest = trimmed.substring(equalsIndex + 1);

    // Split value and metadata
    const parts = rest.split(';');
    const value = decodeURIComponent(parts[0].trim());

    let metadata: Record<string, string> | undefined;
    if (parts.length > 1) {
      metadata = {};
      for (let i = 1; i < parts.length; i++) {
        const metaPart = parts[i].trim();
        const metaEqualsIndex = metaPart.indexOf('=');
        if (metaEqualsIndex > 0) {
          const metaKey = metaPart.substring(0, metaEqualsIndex).trim();
          const metaValue = decodeURIComponent(metaPart.substring(metaEqualsIndex + 1).trim());
          metadata[metaKey] = metaValue;
        }
      }
    }

    return { key, value, metadata };
  }
}

/**
 * Cloudflare Workers specific helpers for baggage propagation
 */
export class CloudflareBaggageHelpers {
  /**
   * Creates a standard getter for Cloudflare Request/Response headers
   */
  static createHeadersGetter(): Getter {
    return {
      get(carrier: Carrier, key: string): string | string[] | undefined {
        const values: string[] = [];
        for (const [headerKey, headerValue] of carrier.headers.entries()) {
          if (headerKey.toLowerCase() === key.toLowerCase()) {
            values.push(headerValue);
          }
        }
        if (values.length === 0) return undefined;
        if (values.length === 1) return values[0];
        return values;
      }
    };
  }

  /**
   * Creates a standard setter for Cloudflare Request/Response headers
   */
  static createHeadersSetter(): Setter {
    return {
      set(carrier: Carrier, key: string, value: string): void {
        carrier.headers.set(key, value);
      }
    };
  }

  /**
   * Extracts baggage from a Cloudflare Request
   */
  static extractFromRequest(request: Request, context: PropagationContext = {}): PropagationContext {
    const propagator = new W3CBaggagePropagator();
    const carrier: Carrier = { headers: request.headers };
    const getter = this.createHeadersGetter();
    
    return propagator.extract(context, carrier, getter);
  }

  /**
   * Injects baggage into a Cloudflare Response
   */
  static injectIntoResponse(response: Response, context: PropagationContext): Response {
    const propagator = new W3CBaggagePropagator();
    const carrier: Carrier = { headers: new Headers(response.headers) };
    const setter = this.createHeadersSetter();
    
    propagator.inject(context, carrier, setter);
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: carrier.headers
    });
  }

  /**
   * Creates a new Request with injected baggage headers
   */
  static injectIntoRequest(request: Request, context: PropagationContext): Request {
    const propagator = new W3CBaggagePropagator();
    const carrier: Carrier = { headers: new Headers(request.headers) };
    const setter = this.createHeadersSetter();
    
    propagator.inject(context, carrier, setter);
    
    return new Request(request.url, {
      method: request.method,
      headers: carrier.headers,
      body: request.body,
      redirect: request.redirect,
      cf: request.cf
    });
  }

  /**
   * Creates baggage from key-value pairs
   */
  static createBaggage(entries: Record<string, string | BaggageEntry>): Baggage {
    const baggage: Baggage = {};
    
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === 'string') {
        baggage[key] = { value };
      } else {
        baggage[key] = value;
      }
    }
    
    return baggage;
  }

  /**
   * Adds trace context to baggage for distributed tracing
   */
  static addTraceContext(baggage: Baggage, traceId: string, spanId: string): Baggage {
    return {
      ...baggage,
      'trace-id': { value: traceId },
      'span-id': { value: spanId },
      'trace-flags': { value: '01' } // Sampled flag
    };
  }

  /**
   * Extracts trace context from baggage
   */
  static extractTraceContext(baggage: Baggage): { traceId?: string; spanId?: string; sampled?: boolean } {
    const traceId = baggage['trace-id']?.value;
    const spanId = baggage['span-id']?.value;
    const traceFlags = baggage['trace-flags']?.value;
    
    return {
      traceId,
      spanId,
      sampled: traceFlags === '01'
    };
  }
}

/**
 * Cloudflare Worker middleware for automatic baggage propagation
 */
export function withBaggagePropagation(handler: ExportedHandler<TracingEnv>): ExportedHandler<TracingEnv> {
  return {
    async fetch(request: Request, env: TracingEnv, ctx: ExecutionContext) {
      const propagator = new W3CBaggagePropagator();
      const getter = CloudflareBaggageHelpers.createHeadersGetter();
      const carrier: Carrier = { headers: request.headers };
      
      // Extract baggage from incoming request
      const context = propagator.extract({}, carrier, getter);
      
      // Store in execution context for downstream use
      (ctx as any).baggageContext = context;
      
      // Call original handler
      const response = await handler.fetch(request, env, ctx);
      
      // Inject baggage into response if needed
      if (context.baggage && Object.keys(context.baggage).length > 0) {
        const setter = CloudflareBaggageHelpers.createHeadersSetter();
        const responseCarrier: Carrier = { headers: new Headers(response.headers) };
        propagator.inject(context, responseCarrier, setter);
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseCarrier.headers
        });
      }
      
      return response;
    }
  };
}