/**
 * Cloudflare Workers implementation of scoped tokens (downscoped credentials).
 * This provides a way to create short-lived, limited-permission tokens from
 * a higher-privilege source token, similar to Google's DownscopedClient.
 */

/**
 * The maximum number of access boundary rules a Credential Access Boundary
 * can contain.
 */
export const MAX_ACCESS_BOUNDARY_RULES_COUNT = 10;

/**
 * Offset to take into account network delays and server clock skews.
 */
export const EXPIRATION_TIME_OFFSET = 30 * 1000; // 30 seconds in milliseconds

/**
 * Cloudflare Workers environment bindings.
 */
export interface Env {
  // D1 database for storing token metadata and rules
  DB: D1Database;
  
  // R2 bucket for storing encrypted source tokens (if needed)
  BUCKET?: R2Bucket;
  
  // KV namespace for caching tokens and rules
  KV: KVNamespace;
  
  // Secret for signing/verifying tokens
  TOKEN_SECRET: string;
  
  // Optional: mTLS client certificate binding
  MTLS_CERTIFICATE?: string;
  
  // Optional: Analytics Engine for logging
  ANALYTICS?: AnalyticsEngineDataset;
}

/**
 * Internal interface for tracking the access token expiration time.
 */
interface CredentialsWithResponse extends Credentials {
  res?: Response | null;
}

/**
 * Internal interface for tracking and returning the scoped access token
 * expiration time in epoch time (seconds).
 */
export interface ScopedAccessTokenResponse extends GetAccessTokenResponse {
  expirationTime?: number | null;
}

/**
 * Defines an upper bound of permissions available for a credential.
 * Similar to Google's CredentialAccessBoundary but adapted for Cloudflare.
 */
export interface CredentialAccessBoundary {
  accessBoundary: {
    accessBoundaryRules: AccessBoundaryRule[];
  };
}

/** 
 * Defines an upper bound of permissions on a particular resource.
 * NOTE: Adapted from Google's model to work with Cloudflare's permission model.
 */
export interface AccessBoundaryRule {
  // Available permissions (e.g., "read", "write", "delete" for R2)
  availablePermissions: string[];
  
  // Resource identifier (e.g., "r2://my-bucket/*" or "kv:namespace/*")
  availableResource: string;
  
  // Optional condition for further restriction
  availabilityCondition?: AvailabilityCondition;
}

/**
 * An optional condition that can be used as part of a
 * CredentialAccessBoundary to further restrict permissions.
 */
export interface AvailabilityCondition {
  // Expression in a simple DSL (e.g., "time.before('2024-12-31')")
  expression: string;
  
  title?: string;
  description?: string;
}

/**
 * Options for creating a ScopedTokenClient.
 */
export interface ScopedTokenClientOptions {
  /**
   * The source AuthClient to be downscoped based on the provided 
   * Credential Access Boundary rules.
   */
  authClient: AuthClient;
  
  /**
   * The Credential Access Boundary which contains a list of access boundary rules.
   * Each rule contains information on the resource that the rule applies to, 
   * the upper bound of the permissions that are available on that resource 
   * and an optional condition to further restrict permissions.
   */
  credentialAccessBoundary: CredentialAccessBoundary;
  
  /**
   * Cloudflare Workers environment bindings.
   */
  env: Env;
  
  /**
   * Optional: Token lifetime in seconds (default: 3600 = 1 hour)
   */
  tokenLifetime?: number;
}

/**
 * Credentials interface for token management.
 */
export interface Credentials {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scopes?: string[];
}

/**
 * Response from getAccessToken method.
 */
export interface GetAccessTokenResponse {
  token?: string;
  res?: Response | null;
}

/**
 * Authentication client interface.
 */
export interface AuthClient {
  getAccessToken(): Promise<GetAccessTokenResponse>;
  getRequestHeaders(): Promise<Headers>;
  request<T>(url: string | Request, options?: RequestInit): Promise<Response>;
}

/**
 * Callback for body response.
 */
export type BodyResponseCallback<T> = (err: Error | null, res?: Response | null, body?: T) => void;

/**
 * Defines a set of credentials that are scoped (downscoped) from an existing set
 * of credentials. This is useful to restrict the permissions that a short-lived 
 * credential can use.
 * 
 * The common pattern of usage is to have a token broker with elevated access
 * generate these scoped credentials from higher access source credentials
 * and pass the scoped short-lived access tokens to a token consumer via
 * some secure authenticated channel for limited access to Cloudflare resources.
 */
export class ScopedTokenClient implements AuthClient {
  private readonly authClient: AuthClient;
  private readonly credentialAccessBoundary: CredentialAccessBoundary;
  private readonly env: Env;
  private readonly tokenLifetime: number;
  
  private cachedScopedAccessToken: Credentials | null = null;
  
  /**
   * Instantiates a scoped token client object using the provided source
   * AuthClient and credential access boundary rules.
   * 
   * To scope permissions of a source AuthClient, a Credential Access
   * Boundary that specifies which resources the new credential can access, as
   * well as an upper bound on the permissions that are available on each
   * resource, has to be defined. A scoped client can then be instantiated
   * using the source AuthClient and the Credential Access Boundary.
   */
  constructor(options: ScopedTokenClientOptions) {
    this.authClient = options.authClient;
    this.credentialAccessBoundary = options.credentialAccessBoundary;
    this.env = options.env;
    this.tokenLifetime = options.tokenLifetime || 3600; // Default 1 hour
    
    // Validate access boundary rules count
    if (this.credentialAccessBoundary.accessBoundary.accessBoundaryRules.length > MAX_ACCESS_BOUNDARY_RULES_COUNT) {
      throw new Error(`Exceeded maximum access boundary rules count of ${MAX_ACCESS_BOUNDARY_RULES_COUNT}`);
    }
  }
  
  /**
   * Provides a mechanism to inject scoped access tokens directly.
   * The expiry_date field is required to facilitate determination of the token
   * expiration which would make it easier for the token consumer to handle.
   */
  setCredentials(credentials: Credentials): void {
    this.cachedScopedAccessToken = credentials;
  }
  
  /**
   * Gets a scoped access token, either from cache or by generating a new one.
   */
  async getAccessToken(): Promise<ScopedAccessTokenResponse> {
    // Check if we have a valid cached token
    if (this.cachedScopedAccessToken && !this.isExpired(this.cachedScopedAccessToken)) {
      return {
        token: this.cachedScopedAccessToken.access_token,
        expirationTime: this.cachedScopedAccessToken.expiry_date
      };
    }
    
    // Generate new scoped token
    const credentials = await this.refreshAccessTokenAsync();
    this.cachedScopedAccessToken = credentials;
    
    return {
      token: credentials.access_token,
      res: credentials.res,
      expirationTime: credentials.expiry_date
    };
  }
  
  /**
   * The main authentication interface. Returns a Promise which
   * resolves with authorization header fields.
   *
   * The result has the form:
   * { Authorization: 'Bearer <access_token_value>' }
   */
  async getRequestHeaders(): Promise<Headers> {
    const tokenResponse = await this.getAccessToken();
    const headers = new Headers();
    
    if (tokenResponse.token) {
      headers.set('Authorization', `Bearer ${tokenResponse.token}`);
    }
    
    return headers;
  }
  
  /**
   * Provides a request implementation with authentication flow. In cases of
   * HTTP 401 and 403 responses, it automatically asks for a new access token
   * and replays the unsuccessful request.
   */
  async request<T>(url: string | Request, options?: RequestInit): Promise<Response> {
    return this.requestAsync(url, options);
  }
  
  /**
   * Authenticates the provided HTTP request, processes it and resolves with the
   * returned response.
   */
  protected async requestAsync<T>(
    url: string | Request, 
    options?: RequestInit,
    reAuthRetried: boolean = false
  ): Promise<Response> {
    // Get authentication headers
    const authHeaders = await this.getRequestHeaders();
    
    // Merge headers
    const requestOptions: RequestInit = {
      ...options,
      headers: new Headers({
        ...Object.fromEntries(authHeaders.entries()),
        ...(options?.headers ? Object.fromEntries(new Headers(options.headers).entries()) : {})
      })
    };
    
    // Make the request
    const response = await fetch(url, requestOptions);
    
    // If unauthorized and we haven't retried yet, refresh token and retry
    if ((response.status === 401 || response.status === 403) && !reAuthRetried) {
      // Clear cached token and retry
      this.cachedScopedAccessToken = null;
      return this.requestAsync(url, options, true);
    }
    
    return response;
  }
  
  /**
   * Forces token refresh, even if unexpired tokens are currently cached.
   * Source access tokens are retrieved from authclient object/source credential.
   * Then source access tokens are exchanged for scoped access tokens.
   */
  protected async refreshAccessTokenAsync(): Promise<CredentialsWithResponse> {
    // Get source token from the auth client
    const sourceTokenResponse = await this.authClient.getAccessToken();
    
    if (!sourceTokenResponse.token) {
      throw new Error('Failed to obtain source access token');
    }
    
    // NOTE: In Google's implementation, this would call STS endpoint.
    // For Cloudflare, we generate a signed JWT with the access boundary rules.
    const scopedToken = await this.generateScopedToken(
      sourceTokenResponse.token,
      this.credentialAccessBoundary
    );
    
    const expiryDate = Date.now() + (this.tokenLifetime * 1000);
    
    return {
      access_token: scopedToken,
      expiry_date: expiryDate,
      token_type: 'Bearer'
    };
  }
  
  /**
   * Generates a scoped JWT token with embedded access boundary rules.
   * This is a simplified implementation for Cloudflare Workers.
   */
  private async generateScopedToken(
    sourceToken: string, 
    accessBoundary: CredentialAccessBoundary
  ): Promise<string> {
    // Create JWT header
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };
    
    // Create JWT payload with access boundary rules
    const payload = {
      iss: 'cloudflare-scoped-token',
      sub: 'scoped-credential',
      aud: 'cloudflare-resources',
      exp: Math.floor(Date.now() / 1000) + this.tokenLifetime,
      iat: Math.floor(Date.now() / 1000),
      source_token_hash: await this.hashToken(sourceToken),
      access_boundary: accessBoundary,
      // Add metadata for auditing
      generated_at: new Date().toISOString(),
      token_id: crypto.randomUUID()
    };
    
    // Encode header and payload
    const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '');
    const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '');
    
    // Create signature
    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.env.TOKEN_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(data)
    );
    
    // Convert signature to base64
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    
    return `${data}.${encodedSignature}`;
  }
  
  /**
   * Hashes a token for storage/verification (not the actual token).
   */
  private async hashToken(token: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  
  /**
   * Returns whether the provided credentials are expired or not.
   * If there is no expiry time, assumes the token is not expired or expiring.
   */
  private isExpired(credentials: Credentials): boolean {
    if (!credentials.expiry_date) {
      return false;
    }
    
    // Check if token is expired or will expire within the offset period
    const now = Date.now();
    return credentials.expiry_date <= now + EXPIRATION_TIME_OFFSET;
  }
}

/**
 * Utility function to validate and parse a scoped token.
 * This would be used by resource servers to verify tokens.
 */
export async function verifyScopedToken(
  token: string, 
  env: Env
): Promise<{
  valid: boolean;
  payload?: any;
  error?: string;
}> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format' };
    }
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify signature
    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.TOKEN_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    // Decode signature
    const signatureBytes = Uint8Array.from(
      atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      encoder.encode(data)
    );
    
    if (!isValid) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    // Decode payload
    const payload = JSON.parse(atob(encodedPayload));
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired', payload };
    }
    
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}