# Architecture

## Design Principles

1. **Zero cross-module dependencies.** Each directory under `src/` is self-contained. You can copy one into your project and it works.

2. **Workers-native.** No Node.js APIs. Everything uses `fetch`, `crypto.subtle`, `WebSocket`, `ReadableStream`, and Cloudflare bindings (D1, R2, KV, Analytics Engine, Queues).

3. **Standards-first.** Token exchange implements RFC 8693. Tracing implements W3C Trace Context. Baggage implements W3C Baggage. WebAuthn follows FIDO2 conventions.

4. **Env-driven configuration.** Every module reads from the Workers `Env` binding object. Secrets go in `wrangler secret put`. Config goes in `wrangler.toml` vars.

---

## Module Relationships

```
                    Independent modules -- no arrows between them
                    ================================================

  src/auth/          src/mtls/         src/trace/        src/genai/        src/migration/
  +-----------+      +-----------+     +-----------+     +-----------+     +-----------+
  | Scoped    |      | Cert      |     | W3C Trace |     | LLM       |     | User      |
  | Tokens    |      | Provider  |     | Context   |     | Client    |     | Import    |
  | STS       |      | Hardware  |     | Baggage   |     | Embedder  |     | Export    |
  | Exchange  |      | Keys      |     | TraceState|     | Imagen    |     | Config    |
  | Downscope |      | Signers   |     | Attributes|     | Veo       |     | HTTP      |
  |           |      | TLS Config|     | AnyValue  |     | Plugin    |     | Client    |
  |           |      | Tunnel    |     |           |     |           |     |           |
  +-----------+      +-----------+     +-----------+     +-----------+     +-----------+
       |                  |                 |                 |                 |
       v                  v                 v                 v                 v
  +---------------------------------------------------------------------------+
  |                     Cloudflare Workers Runtime                            |
  |   D1  |  R2  |  KV  |  Analytics Engine  |  Queues  |  Web Crypto API    |
  +---------------------------------------------------------------------------+
```

Each module defines its own `Env` interface with the bindings it needs. When composing modules, merge the interfaces.

---

## Module Internals

### auth/ -- Token Security Layer

Two parallel implementations of credential downscoping:

- **`scoped-tokens.types.ts`** provides `ScopedTokenClient` implementing an `AuthClient` interface. It generates HMAC-SHA256 signed JWTs with embedded access boundary rules. Tokens are verified using Web Crypto.

- **`scoped-tokens.ts`** provides `DownscopedTokenClient` which is simpler: exchange a source token and store the mapping in KV for later validation. Includes a full Worker handler for the `/token` endpoint.

- **`token-exchange.ts`** and **`token-exchange.types.ts`** implement RFC 8693 STS with two levels of abstraction: `TokenExchangeClient` (simple) and `StsCredentials` (full spec with retry, client auth methods, timeout).

### mtls/ -- Certificate Trust Chain

Five files covering the full mTLS lifecycle:

1. **Provisioning** (`cert-provider.ts`): Get certificates from KV metadata, R2 storage, mTLS bindings, or external endpoints.
2. **Registration** (`hardware-key.ts`): WebAuthn ceremony -- generate challenges, verify attestations, store keys in D1, attestation objects in R2.
3. **Validation** (`signers.ts`): Parse `cf-mtls-cert` headers, check against trusted signers in D1, generate auth tokens post-validation.
4. **Configuration** (`tls-config.ts`): Certificate parsing, hostname validation, PEM/DER conversion, validation mode management.
5. **Tunneling** (`tunnel.ts`): TLS-in-TLS over WebSocket for connecting through proxies.

### trace/ -- Distributed Observability

Follows OpenTelemetry patterns adapted for Workers:

- **Propagation**: `W3CTraceContextPropagator` handles `traceparent`/`tracestate` injection and extraction. `W3CBaggagePropagator` handles the `baggage` header.
- **Context**: `TraceContext` carries span context through the request lifecycle. `TraceState` is an immutable key-value store following the W3C spec (max 32 entries, 512 bytes).
- **Storage**: Attributes can be stored in KV (<25KB), R2 (larger payloads), or D1 (structured queries). `AnyValue` provides type converters for Analytics Engine (numeric only) and Logpush (structured JSON).

### genai/ -- AI Dispatch

Multi-provider LLM routing built around a plugin architecture:

- **Plugin** (`index.ts`): `CloudflareAIPlugin` manages model/embedder references. Provider is selected by name prefix (`openai:gpt-4o`, `anthropic:claude-3`).
- **Client** (`client.ts`): Low-level HTTP client with provider-specific endpoint routing and header management.
- **Adapters** (`gemini.ts`): Provider-specific request/response transformation. OpenAI and Anthropic have full implementations; DeepSeek uses OpenAI-compatible format.
- **Media** (`imagen.ts`, `veo.ts`): Image generation via Stability AI / DALL-E with R2 storage and Queue-based async processing. Video generation with D1-backed operation tracking.
- **Embeddings** (`embedder.ts`): Caching via KV, persistence to R2, batch processing with rate limiting.

### migration/ -- Data Operations

Firebase-to-Cloudflare migration toolkit:

- **Export** (`user-export.ts`): Paginated user export to R2 in CSV or JSON. Firebase-compatible field mapping and base64 handling.
- **Import** (`user-import.ts`): Validate and store users in D1. Supports 10 hash algorithms (HMAC-SHA512, BCRYPT, SCRYPT, PBKDF2, etc.). Provider user info linking for Google, Facebook, Twitter, GitHub.
- **Config** (`env-config.ts`): Hierarchical configuration stored in D1, cached in KV, backed up to R2. Dot-notation keys, recursive set/unset, reserved namespace protection.
- **HTTP** (`http-client.ts`): General-purpose HTTP client with auth, retry (exponential backoff with jitter), timeout, streaming, and multiple response types.
