/**
 * W3C Trace Context propagator for Cloudflare Workers.
 * Implements W3C Trace Context specification for distributed tracing.
 * @see https://www.w3.org/TR/trace-context/
 */

export const TRACE_PARENT_HEADER = 'traceparent';
export const TRACE_STATE_HEADER = 'tracestate';

const VERSION = '00';
const VERSION_PART = '(?!ff)[\\da-f]{2}';
const TRACE_ID_PART = '(?![0]{32})[\\da-f]{32}';
const PARENT_ID_PART = '(?![0]{16})[\\da-f]{16}';
const FLAGS_PART = '[\\da-f]{2}';
const TRACE_PARENT_REGEX = new RegExp(`^\\s?(${VERSION_PART})-(${TRACE_ID_PART})-(${PARENT_ID_PART})-(${FLAGS_PART})(-.*)?\\s?$`);

/**
 * Trace flags for W3C trace context
 */
export enum TraceFlags {
  NONE = 0x0,
  SAMPLED = 0x1
}

/**
 * Span context representation
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: TraceFlags;
  traceState?: TraceState;
  isRemote?: boolean;
}

/**
 * Trace state implementation following W3C specification
 */
export class TraceState {
  private entries: Map<string, string>;

  constructor(raw?: string) {
    this.entries = new Map();
    if (raw) {
      this.parse(raw);
    }
  }

  /**
   * Parse trace state header value
   */
  private parse(raw: string): void {
    // Remove whitespace and split by comma
    const pairs = raw.trim().split(',');
    
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split('=');
      if (key && valueParts.length > 0) {
        // Rejoin in case value contains '='
        const value = valueParts.join('=');
        this.entries.set(key.trim(), value.trim());
      }
    }
  }

  /**
   * Serialize trace state to header value
   */
  serialize(): string {
    const entries: string[] = [];
    for (const [key, value] of this.entries) {
      entries.push(`${key}=${value}`);
    }
    return entries.join(',');
  }

  /**
   * Get value for a key
   */
  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  /**
   * Set value for a key
   */
  set(key: string, value: string): TraceState {
    this.entries.set(key, value);
    return this;
  }

  /**
   * Delete a key
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }
}

/**
 * Carrier interface for propagation
 */
export interface Carrier {
  [key: string]: unknown;
}

/**
 * Setter interface for injecting trace context
 */
export interface Setter {
  set(carrier: Carrier, key: string, value: string): void;
}

/**
 * Getter interface for extracting trace context
 */
export interface Getter {
  get(carrier: Carrier, key: string): string | string[] | undefined;
}

/**
 * Check if span context is valid
 */
export function isSpanContextValid(spanContext: SpanContext): boolean {
  return (
    typeof spanContext.traceId === 'string' &&
    spanContext.traceId.length === 32 &&
    /^[0-9a-f]{32}$/i.test(spanContext.traceId) &&
    typeof spanContext.spanId === 'string' &&
    spanContext.spanId.length === 16 &&
    /^[0-9a-f]{16}$/i.test(spanContext.spanId) &&
    (spanContext.traceFlags === TraceFlags.NONE || 
     spanContext.traceFlags === TraceFlags.SAMPLED)
  );
}

/**
 * Check if tracing is suppressed in the current context
 * NOTE: Simplified from Google's implementation - Cloudflare Workers
 * don't have built-in tracing suppression. This can be extended
 * with custom logic based on request headers or environment.
 */
export function isTracingSuppressed(context: unknown): boolean {
  // In Cloudflare Workers, we might suppress tracing based on:
  // 1. Specific request headers
  // 2. Environment configuration
  // 3. Path patterns (e.g., health checks)
  return false;
}

/**
 * Parse trace parent header value
 */
export function parseTraceParent(traceParent: string): SpanContext | null {
  const match = TRACE_PARENT_REGEX.exec(traceParent);
  if (!match) return null;

  // According to specification, implementations should be compatible
  // with future versions. If there are more parts, we only reject it 
  // if it's using version 00
  if (match[1] === '00' && match[5]) return null;

  const traceFlags = parseInt(match[4], 16);
  
  // Validate trace flags
  if (traceFlags !== TraceFlags.NONE && traceFlags !== TraceFlags.SAMPLED) {
    return null;
  }

  return {
    traceId: match[2],
    spanId: match[3],
    traceFlags: traceFlags as TraceFlags,
  };
}

/**
 * Context management for Cloudflare Workers
 * NOTE: Simplified context API compared to OpenTelemetry's full implementation
 */
export class TraceContext {
  private spanContext?: SpanContext;

  /**
   * Set span context in the current context
   */
  setSpanContext(spanContext: SpanContext): TraceContext {
    this.spanContext = spanContext;
    return this;
  }

  /**
   * Get span context from the current context
   */
  getSpanContext(): SpanContext | undefined {
    return this.spanContext;
  }

  /**
   * Create a new context with the given span context
   */
  static createWithSpanContext(spanContext: SpanContext): TraceContext {
    const context = new TraceContext();
    return context.setSpanContext(spanContext);
  }
}

/**
 * Default setter implementation for Headers
 */
export class HeadersSetter implements Setter {
  set(carrier: Carrier, key: string, value: string): void {
    if (carrier instanceof Headers) {
      carrier.set(key, value);
    } else if (carrier && typeof carrier === 'object') {
      (carrier as Record<string, string>)[key] = value;
    }
  }
}

/**
 * Default getter implementation for Headers
 */
export class HeadersGetter implements Getter {
  get(carrier: Carrier, key: string): string | string[] | undefined {
    if (carrier instanceof Headers) {
      const value = carrier.get(key);
      return value !== null ? value : undefined;
    } else if (carrier && typeof carrier === 'object') {
      const value = (carrier as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
        return value as string[];
      }
    }
    return undefined;
  }
}

/**
 * W3C Trace Context propagator for Cloudflare Workers
 */
export class W3CTraceContextPropagator {
  /**
   * Inject trace context into carrier
   */
  inject(context: TraceContext, carrier: Carrier, setter: Setter = new HeadersSetter()): void {
    const spanContext = context.getSpanContext();
    
    if (!spanContext || 
        isTracingSuppressed(context) || 
        !isSpanContextValid(spanContext)) {
      return;
    }

    // Format trace parent header according to W3C specification
    const traceParent = `${VERSION}-${spanContext.traceId}-${spanContext.spanId}-0${Number(spanContext.traceFlags || TraceFlags.NONE).toString(16)}`;
    
    setter.set(carrier, TRACE_PARENT_HEADER, traceParent);

    if (spanContext.traceState) {
      setter.set(carrier, TRACE_STATE_HEADER, spanContext.traceState.serialize());
    }
  }

  /**
   * Extract trace context from carrier
   */
  extract(carrier: Carrier, getter: Getter = new HeadersGetter()): TraceContext {
    const context = new TraceContext();
    const traceParentHeader = getter.get(carrier, TRACE_PARENT_HEADER);
    
    if (!traceParentHeader) return context;

    // Handle array or single value
    const traceParent = Array.isArray(traceParentHeader) 
      ? traceParentHeader[0] 
      : traceParentHeader;

    if (typeof traceParent !== 'string') return context;

    const spanContext = parseTraceParent(traceParent);
    if (!spanContext) return context;

    spanContext.isRemote = true;

    // Extract trace state if present
    const traceStateHeader = getter.get(carrier, TRACE_STATE_HEADER);
    if (traceStateHeader) {
      // Merge multiple tracestate headers into one
      const state = Array.isArray(traceStateHeader)
        ? traceStateHeader.join(',')
        : traceStateHeader;
      
      spanContext.traceState = new TraceState(
        typeof state === 'string' ? state : undefined
      );
    }

    return context.setSpanContext(spanContext);
  }

  /**
   * Get the fields that this propagator uses
   */
  fields(): string[] {
    return [TRACE_PARENT_HEADER, TRACE_STATE_HEADER];
  }
}

/**
 * Helper function to generate trace and span IDs
 * NOTE: Uses Web Crypto API available in Cloudflare Workers
 */
export function generateTraceIds(): { traceId: string; spanId: string } {
  // Generate 16 random bytes for trace ID (32 hex chars)
  const traceIdBytes = new Uint8Array(16);
  crypto.getRandomValues(traceIdBytes);
  const traceId = Array.from(traceIdBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Generate 8 random bytes for span ID (16 hex chars)
  const spanIdBytes = new Uint8Array(8);
  crypto.getRandomValues(spanIdBytes);
  const spanId = Array.from(spanIdBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return { traceId, spanId };
}

/**
 * Create a new span context with sampling decision
 */
export function createSpanContext(
  sampled: boolean = false,
  parentTraceId?: string,
  parentSpanId?: string
): SpanContext {
  const { traceId, spanId } = generateTraceIds();
  
  return {
    traceId: parentTraceId || traceId,
    spanId,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    traceState: new TraceState(),
  };
}

/**
 * Cloudflare Workers environment bindings for trace context
 * NOTE: This interface should be extended based on actual bindings needed
 */
export interface TraceEnv {
  // Add any environment bindings needed for tracing
  // e.g., analytics engine, D1 for trace storage, etc.
  TRACE_SAMPLING_RATE?: number;
  TRACE_ENABLED?: boolean;
}

/**
 * Extract trace context from Cloudflare Workers request
 */
export function extractTraceFromRequest(request: Request): TraceContext {
  const propagator = new W3CTraceContextPropagator();
  return propagator.extract(request.headers);
}

/**
 * Inject trace context into Cloudflare Workers response
 */
export function injectTraceIntoResponse(
  response: Response,
  context: TraceContext
): Response {
  const propagator = new W3CTraceContextPropagator();
  const newHeaders = new Headers(response.headers);
  propagator.inject(context, newHeaders);
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Create trace headers for outgoing fetch requests
 */
export function createTraceHeaders(context: TraceContext): Headers {
  const headers = new Headers();
  const propagator = new W3CTraceContextPropagator();
  propagator.inject(context, headers);
  return headers;
}