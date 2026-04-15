/**
 * Cloudflare Workers implementation of token exchange based on RFC 8693.
 * Replaces Google STS with Cloudflare Access token exchange patterns.
 * 
 * @module auth/token-exchange
 */

/**
 * Token exchange options for requesting a new token.
 */
export interface TokenExchangeOptions {
  /** OAuth 2.0 grant type, must be "urn:ietf:params:oauth:grant-type:token-exchange" */
  grantType: string;
  /** The resource for which the token is being requested */
  resource?: string;
  /** The audience for which the token is being requested */
  audience?: string;
  /** Space-separated list of scopes */
  scope?: string[];
  /** Type of token being requested */
  requestedTokenType?: string;
  /** The token being exchanged */
  subjectToken: string;
  /** Type of the subject token */
  subjectTokenType: string;
  /** Acting party information for delegation scenarios */
  actingParty?: {
    actorToken: string;
    actorTokenType: string;
  };
}

/**
 * Successful token exchange response.
 */
export interface TokenExchangeResponse {
  /** The issued access token */
  access_token: string;
  /** Type of the issued token */
  issued_token_type: string;
  /** Type of the token (usually "Bearer") */
  token_type: string;
  /** Lifetime in seconds of the issued token */
  expires_in?: number;
  /** Scope of the issued token */
  scope?: string;
  /** Refresh token (if applicable) */
  refresh_token?: string;
}

/**
 * Error response from token exchange endpoint.
 */
export interface TokenExchangeError {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Configuration for the token exchange client.
 */
export interface TokenExchangeConfig {
  /** Cloudflare Access token exchange endpoint */
  tokenExchangeEndpoint: string;
  /** Client ID for authentication */
  clientId?: string;
  /** Client secret for authentication */
  clientSecret?: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
}

/**
 * Implements OAuth 2.0 token exchange based on RFC 8693 for Cloudflare Workers.
 * Uses Cloudflare Access patterns instead of Google STS.
 */
export class TokenExchangeClient {
  private config: TokenExchangeConfig;
  
  /**
   * Creates a new token exchange client.
   * @param config Configuration for the token exchange client
   */
  constructor(config: TokenExchangeConfig) {
    this.config = config;
  }
  
  /**
   * Exchanges a token for another type of token based on RFC 8693.
   * @param options Token exchange options
   * @param env Cloudflare Workers environment bindings
   * @returns Promise resolving to the token exchange response
   */
  async exchangeToken(
    options: TokenExchangeOptions,
    env?: Env
  ): Promise<TokenExchangeResponse> {
    // NOTE: Using Cloudflare Access token exchange patterns instead of Google STS
    // Cloudflare Access provides JWT verification and token exchange capabilities
    
    const formData = new URLSearchParams();
    
    // Add required parameters
    formData.append('grant_type', options.grantType);
    formData.append('subject_token', options.subjectToken);
    formData.append('subject_token_type', options.subjectTokenType);
    
    // Add optional parameters
    if (options.resource) {
      formData.append('resource', options.resource);
    }
    if (options.audience) {
      formData.append('audience', options.audience);
    }
    if (options.scope && options.scope.length > 0) {
      formData.append('scope', options.scope.join(' '));
    }
    if (options.requestedTokenType) {
      formData.append('requested_token_type', options.requestedTokenType);
    }
    if (options.actingParty) {
      formData.append('actor_token', options.actingParty.actorToken);
      formData.append('actor_token_type', options.actingParty.actorTokenType);
    }
    
    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...this.config.headers,
    };
    
    // Add client authentication if configured
    if (this.config.clientId && this.config.clientSecret) {
      const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
      headers['Authorization'] = `Basic ${credentials}`;
    }
    
    // NOTE: In Cloudflare Workers, we can use the built-in fetch API
    // instead of Google's gaxios library
    const response = await fetch(this.config.tokenExchangeEndpoint, {
      method: 'POST',
      headers,
      body: formData.toString(),
    });
    
    if (!response.ok) {
      const errorData = await response.json() as TokenExchangeError;
      throw new TokenExchangeErrorResponse(
        errorData.error,
        errorData.error_description,
        errorData.error_uri,
        response.status
      );
    }
    
    const responseData = await response.json() as TokenExchangeResponse;
    return responseData;
  }
  
  /**
   * Exchanges a Cloudflare Access JWT for a service token.
   * This is a Cloudflare-specific convenience method.
   * @param accessJwt Cloudflare Access JWT
   * @param serviceAudience Audience for the service token
   * @param env Cloudflare Workers environment bindings
   * @returns Promise resolving to the service token
   */
  async exchangeAccessTokenForServiceToken(
    accessJwt: string,
    serviceAudience: string,
    env?: Env
  ): Promise<TokenExchangeResponse> {
    // NOTE: Cloudflare Access provides JWT verification through Workers
    // This pattern replaces Google's service account token exchange
    
    return this.exchangeToken({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subjectToken: accessJwt,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      audience: serviceAudience,
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    }, env);
  }
  
  /**
   * Validates a token exchange response and extracts the access token.
   * @param response Token exchange response
   * @returns The access token
   * @throws If the response is invalid
   */
  validateTokenExchangeResponse(response: TokenExchangeResponse): string {
    if (!response.access_token) {
      throw new Error('Token exchange response missing access_token');
    }
    if (!response.token_type) {
      throw new Error('Token exchange response missing token_type');
    }
    if (response.token_type.toLowerCase() !== 'bearer') {
      throw new Error(`Unsupported token type: ${response.token_type}`);
    }
    
    return response.access_token;
  }
}

/**
 * Custom error class for token exchange errors.
 */
export class TokenExchangeErrorResponse extends Error {
  constructor(
    public error: string,
    public errorDescription?: string,
    public errorUri?: string,
    public statusCode?: number
  ) {
    super(errorDescription || error);
    this.name = 'TokenExchangeErrorResponse';
  }
}

/**
 * Cloudflare Workers environment bindings for token exchange.
 * Extend this interface based on your actual bindings.
 */
export interface Env {
  /** Cloudflare Access token exchange endpoint */
  TOKEN_EXCHANGE_ENDPOINT?: string;
  /** Client ID for token exchange */
  CLIENT_ID?: string;
  /** Client secret for token exchange */
  CLIENT_SECRET?: string;
  /** D1 database for token storage/auditing */
  DB?: D1Database;
  /** KV namespace for caching tokens */
  TOKEN_CACHE?: KVNamespace;
}

/**
 * Creates a token exchange client from Cloudflare Workers environment bindings.
 * @param env Workers environment bindings
 * @returns Configured token exchange client
 */
export function createTokenExchangeClientFromEnv(env: Env): TokenExchangeClient {
  if (!env.TOKEN_EXCHANGE_ENDPOINT) {
    throw new Error('TOKEN_EXCHANGE_ENDPOINT environment variable is required');
  }
  
  return new TokenExchangeClient({
    tokenExchangeEndpoint: env.TOKEN_EXCHANGE_ENDPOINT,
    clientId: env.CLIENT_ID,
    clientSecret: env.CLIENT_SECRET,
  });
}

/**
 * Middleware for Cloudflare Workers that handles token exchange.
 * Use this in your Worker's fetch handler.
 */
export function withTokenExchange(
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
  options?: {
    /** Required scopes for the token */
    requiredScopes?: string[];
    /** Required audience for the token */
    requiredAudience?: string;
    /** Whether to exchange the token for a service token */
    exchangeForServiceToken?: boolean;
    /** Service audience if exchanging tokens */
    serviceAudience?: string;
  }
): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return async (request: Request, env: Env, ctx: ExecutionContext) => {
    try {
      // Extract token from Authorization header
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Missing or invalid Authorization header', { status: 401 });
      }
      
      const token = authHeader.substring(7);
      
      // If token exchange is requested, perform the exchange
      if (options?.exchangeForServiceToken && options?.serviceAudience) {
        const client = createTokenExchangeClientFromEnv(env);
        const exchangeResponse = await client.exchangeAccessTokenForServiceToken(
          token,
          options.serviceAudience,
          env
        );
        
        // Add the new token to the request headers
        const newRequest = new Request(request, {
          headers: {
            ...Object.fromEntries(request.headers.entries()),
            'Authorization': `Bearer ${exchangeResponse.access_token}`,
          },
        });
        
        return handler(newRequest, env, ctx);
      }
      
      // Otherwise, just pass through with token validation
      // NOTE: In production, you should validate the JWT here
      // using Cloudflare Access JWT verification
      
      return handler(request, env, ctx);
    } catch (error) {
      if (error instanceof TokenExchangeErrorResponse) {
        return new Response(
          JSON.stringify({
            error: error.error,
            error_description: error.errorDescription,
            error_uri: error.errorUri,
          }),
          {
            status: error.statusCode || 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      
      console.error('Token exchange error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}