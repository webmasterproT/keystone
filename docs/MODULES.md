# Module Reference

## auth/ -- Scoped Tokens & Token Exchange

### Key Types

```ts
// Access boundary rule -- defines permission limits
interface ResourceScope {
  resourceType: string;    // 'zone', 'account', 'kv', 'r2'
  resourceId: string;      // resource identifier
  permissions: string[];   // ['read', 'write', 'delete']
  pathPattern?: string;    // optional path filter
}

// Credential access boundary -- wraps multiple rules (max 10)
interface CredentialAccessBoundary {
  accessBoundary: {
    accessBoundaryRules: ResourceScope[] | AccessBoundaryRule[];
  };
}

// STS credentials options (RFC 8693)
interface StsCredentialsOptions {
  grantType: string;
  subjectToken: string;
  subjectTokenType: string;
  resource?: string;
  audience?: string;
  scope?: string[];
  requestedTokenType?: string;
  actingParty?: { actorToken: string; actorTokenType: string };
}
```

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `DownscopedTokenClient` | class | Exchange tokens with KV-backed storage and D1 audit logging |
| `ScopedTokenClient` | class | AuthClient-compatible scoped credential with JWT signing |
| `TokenExchangeClient` | class | Simple RFC 8693 client with convenience methods |
| `StsCredentials` | class | Full STS implementation with retry and client auth |
| `handleTokenExchange` | function | Worker request handler for `/token` endpoint |
| `withTokenExchange` | function | Middleware for automatic token exchange |
| `verifyScopedToken` | function | Verify HMAC-signed scoped tokens |
| `createTokenExchangeClientFromEnv` | function | Factory from env bindings |

### Required Bindings

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "TOKEN_STORE"     # or TOKEN_CACHE
id = "..."

[[d1_databases]]
binding = "DB"              # or LOGS
database_name = "..."
database_id = "..."

[vars]
TOKEN_SECRET = "..."        # for JWT signing
```

---

## mtls/ -- Mutual TLS & Device Trust

### Key Types

```ts
// Client certificate credentials
interface ClientSSLCredentials {
  hasCert: boolean;
  cert?: Uint8Array;
  key?: Uint8Array;
  passphrase?: Uint8Array;
}

// Certificate metadata
interface ClientCertificateInfo {
  id: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  fingerprint: string;
}

// WebAuthn registered key
interface RegisteredKey {
  version: string;
  key_handle: string;
  app_id: string;
  transports?: string[];
  created_at: number;
  user_id?: string;
}

// TLS tunnel options
interface TunnelOptions {
  serverHostname: string;
  alpnProtocols?: string[];
  suppressRaggedEofs?: boolean;
  clientCertificate?: ArrayBuffer;
  clientPrivateKey?: CryptoKey;
}
```

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `getClientSSLCredentials` | function | Retrieve certs from KV/R2/mTLS binding |
| `HardwareKeyInterface` | class | WebAuthn registration and authentication |
| `CloudflareMTLSSigner` | class | Certificate validation with D1 signer store |
| `TLSConfig` | class | Request validation with configurable modes |
| `SSLTransport` | class | TLS-in-TLS over WebSocket |
| `HTTPTunnel` | class | HTTP CONNECT proxy handler |
| `withMTLSValidation` | function | Middleware for mTLS enforcement |
| `parseCertificate` | function | PEM certificate parsing |
| `derToPem` / `pemToDer` | function | Format conversion |
| `ClientCertError` | class | Certificate-specific error type |
| `HardwareKeyError` | class | WebAuthn-specific error type |

### Required Bindings

```toml
[[d1_databases]]
binding = "DB"
database_name = "..."
database_id = "..."

[[r2_buckets]]
binding = "CERT_STORE"     # or BUCKET
bucket_name = "..."

[[kv_namespaces]]
binding = "MTLS_CACHE"     # or KV
id = "..."
```

---

## trace/ -- Observability

### Key Types

```ts
// Span context (W3C Trace Context)
interface SpanContext {
  traceId: string;       // 32 hex chars
  spanId: string;        // 16 hex chars
  traceFlags: TraceFlags;
  traceState?: TraceState;
  isRemote?: boolean;
}

// Baggage entry
interface BaggageEntry {
  value: string;
  metadata?: Record<string, string>;
}

// Attribute types
type AttributeValue = string | number | boolean | Array<null | undefined | string | number | boolean> | null | undefined;
type AnyValue = null | string | boolean | number | Array<AnyValue> | { [key: string]: AnyValue };
```

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `W3CTraceContextPropagator` | class | Inject/extract `traceparent` and `tracestate` |
| `W3CBaggagePropagator` | class | Inject/extract `baggage` header |
| `TraceState` / `TraceStateImpl` | class | Immutable tracestate management |
| `TraceContext` | class | Carry span context through request lifecycle |
| `CloudflareBaggageHelpers` | class | Workers-specific convenience methods |
| `extractTraceFromRequest` | function | One-liner trace extraction |
| `injectTraceIntoResponse` | function | One-liner trace injection |
| `createSpanContext` | function | Generate new span with optional parent |
| `generateTraceIds` | function | Random trace ID and span ID via Web Crypto |
| `parseTraceParent` | function | Parse `traceparent` header string |
| `withBaggagePropagation` | function | Middleware for automatic baggage forwarding |
| `sanitizeAttributes` | function | Validate and truncate attributes for Workers limits |
| `toAnalyticsEngineData` | function | Convert attributes for Analytics Engine |
| `storeAttributes` | function | Auto-route to KV/R2/D1 based on size |

### Required Bindings

```toml
# Optional -- tracing works without storage bindings
[[kv_namespaces]]
binding = "TRACES_KV"
id = "..."

[[analytics_engine_datasets]]
binding = "ANALYTICS"
```

---

## genai/ -- AI Routing

### Key Types

```ts
// LLM request (OpenAI-compatible)
interface LLMRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

// Function calling
interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

// Embedding config
interface EmbeddingConfig {
  taskType?: TaskType;
  outputDimensionality?: number;
  cacheTtl?: number;
  persistToR2?: boolean;
}

// Multi-provider enum
enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  DEEPSEEK = 'deepseek',
  CLOUDFLARE = 'cloudflare',
}
```

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `CloudflareAIPlugin` | class | Plugin with model/embedder registration |
| `LLMClient` | class | Multi-provider LLM client with caching |
| `CloudflareLLMClient` | class | Provider-routed generation with tool support |
| `CloudflareEmbedder` | class | Embedding with KV cache and R2 persistence |
| `ImageGenerationServiceRegistry` | class | Image gen via Stability AI / DALL-E |
| `defineModel` (veo) | function | Video generation with D1 operation tracking |
| `cloudflareAIPlugin` | function | Factory for creating the plugin |
| `LLMError` | class | Typed errors with status codes |

### Required Bindings

```toml
[[d1_databases]]
binding = "DB"
database_name = "..."
database_id = "..."

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "..."

[[kv_namespaces]]
binding = "KV"
id = "..."

# Set via wrangler secret put
# OPENAI_API_KEY
# ANTHROPIC_API_KEY
# DEEPSEEK_API_KEY
```

---

## migration/ -- User Import/Export

### Key Types

```ts
// User record (Firebase-compatible)
interface UserRecord {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  salt?: string;
  displayName?: string;
  providerUserInfo?: ProviderUserInfo[];
  disabled?: boolean;
  customAttributes?: string;
}

// Hash algorithm options
interface HashOptions {
  hashAlgo?: string;      // HMAC_SHA512, BCRYPT, SCRYPT, PBKDF2_SHA256, etc.
  hashKey?: string;
  saltSeparator?: string;
  rounds?: number;
  memCost?: number;
  valid: boolean;
}

// Config variable
interface ConfigVariable {
  config: string;
  variable: string;
}
```

### Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `importUsers` | function | Validate and bulk-import users to D1 |
| `serialExportUsers` | function | Paginated export to R2 (CSV/JSON) |
| `serialImportUsers` | function | Batched import with sequential processing |
| `validateOptions` | function | Validate hash algorithm configuration |
| `validateUserJson` | function | Validate user record structure |
| `transArrayToUser` | function | Convert CSV row to user object |
| `materializeAll` | function | Load all config from D1, cache in KV |
| `materializeConfig` | function | Load specific config namespace |
| `setVariablesRecursive` | function | Set nested config with dot-notation |
| `Client` | class | Authenticated HTTP client with retry |
| `handleUserExport` | function | Worker handler for export endpoint |

### Required Bindings

```toml
[[d1_databases]]
binding = "DB"
database_name = "..."
database_id = "..."

[[r2_buckets]]
binding = "IMPORT_BUCKET"      # or USER_EXPORT_BUCKET
bucket_name = "..."

[[kv_namespaces]]
binding = "CONFIG_KV"          # or USER_CACHE
id = "..."
```
