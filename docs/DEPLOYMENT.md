# Deployment

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account with Workers enabled

## Setup

```bash
# Install dependencies
npm install

# Login to Cloudflare
wrangler login

# Type check
npm run check
```

## Bindings

Each module declares its own `Env` interface. When combining modules, you need the union of all required bindings.

### D1 Database

Most modules use D1 for persistent storage. Create one:

```bash
wrangler d1 create my-toolkit-db
```

Add to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-toolkit-db"
database_id = "<id-from-create>"
```

**Schema initialization.** Several modules need tables. Run these against your D1 database:

```sql
-- auth: token exchange audit logs
CREATE TABLE IF NOT EXISTS token_exchange_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  source_token_id TEXT,
  downscoped_token_id TEXT,
  source_identity TEXT,
  permissions_granted TEXT,
  expires_at INTEGER
);

-- mtls: hardware key registrations
CREATE TABLE IF NOT EXISTS hardware_keys (
  key_handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  transports TEXT,
  created_at INTEGER NOT NULL
);

-- mtls: trusted signers
CREATE TABLE IF NOT EXISTS trusted_signers (
  id TEXT PRIMARY KEY,
  key_pair_ids TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

-- migration: users
CREATE TABLE IF NOT EXISTS users (
  localId TEXT PRIMARY KEY,
  email TEXT,
  emailVerified INTEGER DEFAULT 0,
  passwordHash TEXT,
  salt TEXT,
  displayName TEXT,
  photoUrl TEXT,
  createdAt TEXT,
  lastLoginAt TEXT,
  phoneNumber TEXT,
  disabled INTEGER DEFAULT 0,
  customAttributes TEXT
);

CREATE TABLE IF NOT EXISTS user_providers (
  userId TEXT,
  providerId TEXT,
  rawId TEXT,
  email TEXT,
  displayName TEXT,
  photoUrl TEXT,
  PRIMARY KEY (userId, providerId)
);

-- migration: config variables
CREATE TABLE IF NOT EXISTS config_variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_name TEXT NOT NULL,
  variable_path TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(config_name, variable_path)
);
```

### R2 Bucket

Used by mtls (certificate storage), genai (media output), and migration (export files):

```bash
wrangler r2 bucket create my-toolkit-bucket
```

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-toolkit-bucket"
```

### KV Namespace

Used for caching tokens, config, embeddings, and trace data:

```bash
wrangler kv namespace create "TOOLKIT_KV"
```

```toml
[[kv_namespaces]]
binding = "KV"
id = "<id-from-create>"
```

### Analytics Engine

Optional. Used by trace/ and genai/ for metrics:

```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
```

### Queues

Optional. Used by genai/imagen for async image generation:

```toml
[[queues.producers]]
binding = "IMAGE_QUEUE"
queue = "image-generation"

[[queues.consumers]]
queue = "image-generation"
max_batch_size = 10
max_retries = 3
```

## Secrets

Set API keys and signing secrets via wrangler:

```bash
# GenAI provider keys
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put DEEPSEEK_API_KEY

# Auth module signing
wrangler secret put TOKEN_SECRET

# mTLS signing
wrangler secret put MTLS_SIGNING_SECRET
```

## Deploy

```bash
# Development (local)
npm run dev

# Production
npm run deploy
```

## Using Individual Modules

You do not need to deploy the entire toolkit. Copy the directory you need into your project:

```bash
# Just need token exchange?
cp -r src/auth/ my-project/src/auth/

# Just need tracing?
cp -r src/trace/ my-project/src/trace/
```

Each module works standalone with no imports from other modules.
