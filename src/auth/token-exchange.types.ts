/**
 * Cloudflare Workers implementation of OAuth 2.0 Token Exchange (RFC 8693)
 * 
 * This module provides token exchange functionality for Cloudflare Workers,
 * replacing Google's STS service with Cloudflare Access token exchange patterns.
 * 
 * @see https://tools.ietf.org/html/rfc8693
 */

// NOTE: Replaced Google-specific GaxiosResponse with standard Response
// NOTE: Removed Google OAuth client dependencies in favor of Cloudflare-native auth

/**
 * Cloudflare Workers environment bindings for token exchange
 */
export interface Env {
  /**
   * Cloudflare Access service token for token exchange
   * This would typically be configured as a secret or binding
   */
  ACCESS_SERVICE_TOKEN?: string;
  
  /**
   * Token exchange endpoint URL
   * For Cloudflare Access, this would be the Access token exchange endpoint
   */
  TOKEN_EXCHANGE_ENDPOINT?: string;
  
  /**
   * Optional KV namespace for caching exchanged tokens
   */
  TOKEN_CACHE?: KVNamespace;
  
  /**
   * Optional D1 database for token metadata and audit logging
   */
  DB?: D1Database;
  
  /**
   * Optional R2 bucket for storing token exchange configurations
   */
  CONFIG_BUCKET?: R2Bucket;
}

/**
 * Defines the interface needed to initialize a token exchange request.
 * Based on RFC 8693 Section 2.1, adapted for Cloudflare Workers.
 */
export interface StsCredentialsOptions {
  /**
   * REQUIRED. The value "urn:ietf:params:oauth:grant-type:token-exchange"
   * indicates that a token exchange is being performed.
   */
  grantType: string;
  
  /**
   * OPTIONAL. A URI that indicates the target service or resource where the
   * client intends to use the requested security token.
   */
  resource?: string;
  
  /**
   * OPTIONAL. The logical name of the target service where the client
   * intends to use the requested security token. This serves a purpose
   * similar to the "resource" parameter but with the client providing a
   * logical name for the target service.
   */
  audience?: string;
  
  /**
   * OPTIONAL. A list of space-delimited, case-sensitive strings that allow
   * the client to specify the desired scope of the requested security token
   * in the context of the service or resource where the token will be used.
   */
  scope?: string[];
  
  /**
   * OPTIONAL. An identifier for the type of the requested security token.
   * Example: "urn:ietf:params:oauth:token-type:access_token"
   */
  requestedTokenType?: string;
  
  /**
   * REQUIRED. A security token that represents the identity of the party on
   * behalf of whom the request is being made.
   */
  subjectToken: string;
  
  /**
   * REQUIRED. An identifier that indicates the type of the security token
   * in the "subject_token" parameter.
   */
  subjectTokenType: string;
  
  /**
   * OPTIONAL. Information about the acting party if different from the subject.
   */
  actingParty?: {
    /**
     * OPTIONAL. A security token that represents the identity of the acting
     * party. Typically, this will be the party that is authorized to use the
     * requested security token and act on behalf of the subject.
     */
    actorToken: string;
    
    /**
     * REQUIRED when "actor_token" is present. An identifier that indicates
     * the type of the security token in the "actor_token" parameter.
     */
    actorTokenType: string;
  };
}

/**
 * Defines the OAuth 2.0 token exchange successful response based on
 * RFC 8693 Section 2.2.1
 */
export interface StsSuccessfulResponse {
  /** REQUIRED. The security token issued by the authorization server */
  access_token: string;
  
  /** REQUIRED. An identifier for the type of token issued */
  issued_token_type: string;
  
  /** REQUIRED. The type of token issued */
  token_type: string;
  
  /** OPTIONAL. The lifetime in seconds of the issued token */
  expires_in?: number;
  
  /** OPTIONAL. Refresh token for obtaining additional access tokens */
  refresh_token?: string;
  
  /** OPTIONAL. The scope of the issued token */
  scope?: string;
  
  /** OPTIONAL. Additional response metadata */
  metadata?: Record<string, unknown>;
  
  /** Cloudflare-specific: The raw Response object for debugging */
  res?: Response | null;
}

/**
 * Client authentication credentials for token exchange
 */
export interface ClientAuthentication {
  /** Client identifier */
  clientId: string;
  
  /** Client secret or API key */
  clientSecret: string;
  
  /** Optional authentication method */
  authMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
}

/**
 * Construction options for StsCredentials
 */
export interface StsCredentialsConstructionOptions {
  /**
   * The client authentication credentials if available.
   */
  clientAuthentication?: ClientAuthentication;
  
  /**
   * The token exchange endpoint.
   * For Cloudflare, this would be the Access token exchange endpoint.
   */
  tokenExchangeEndpoint: string | URL;
  
  /**
   * Optional additional headers to include in all requests
   */
  headers?: Record<string, string>;
  
  /**
   * Optional request timeout in milliseconds
   */
  timeout?: number;
  
  /**
   * Optional retry configuration
   */
  retry?: {
    maxAttempts: number;
    backoffFactor: number;
  };
}

/**
 * Implements the OAuth 2.0 token exchange based on RFC 8693
 * for Cloudflare Workers environment.
 * 
 * NOTE: This replaces Google's OAuthClientAuthHandler with a Cloudflare-native
 * implementation using fetch API and Web Crypto for security.
 */
export class StsCredentials {
  private tokenExchangeEndpoint: URL;
  private clientAuthentication?: ClientAuthentication;
  private defaultHeaders: Record<string, string>;
  private timeout: number;
  private retryConfig?: { maxAttempts: number; backoffFactor: number };
  
  /**
   * Initializes an STS credentials instance for Cloudflare Workers.
   * 
   * @param options The STS credentials instance options
   */
  constructor(options: StsCredentialsConstructionOptions) {
    this.tokenExchangeEndpoint = typeof options.tokenExchangeEndpoint === 'string' 
      ? new URL(options.tokenExchangeEndpoint)
      : options.tokenExchangeEndpoint;
    
    this.clientAuthentication = options.clientAuthentication;
    this.defaultHeaders = options.headers || {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };
    this.timeout = options.timeout || 30000; // 30 seconds default
    this.retryConfig = options.retry;
  }
  
  /**
   * Exchanges the provided token for another type of token based on RFC 8693.
   * 
   * @param stsCredentialsOptions The token exchange options
   * @param additionalHeaders Optional additional headers
   * @param options Optional additional non-spec defined options
   * @return A promise that resolves with the token exchange response
   */
  async exchangeToken(
    stsCredentialsOptions: StsCredentialsOptions,
    additionalHeaders?: Record<string, string>,
    options?: Record<string, unknown>
  ): Promise<StsSuccessfulResponse> {
    // Prepare the request body according to RFC 8693
    const body = new URLSearchParams();
    body.append('grant_type', stsCredentialsOptions.grantType);
    body.append('subject_token', stsCredentialsOptions.subjectToken);
    body.append('subject_token_type', stsCredentialsOptions.subjectTokenType);
    
    if (stsCredentialsOptions.resource) {
      body.append('resource', stsCredentialsOptions.resource);
    }
    
    if (stsCredentialsOptions.audience) {
      body.append('audience', stsCredentialsOptions.audience);
    }
    
    if (stsCredentialsOptions.scope && stsCredentialsOptions.scope.length > 0) {
      body.append('scope', stsCredentialsOptions.scope.join(' '));
    }
    
    if (stsCredentialsOptions.requestedTokenType) {
      body.append('requested_token_type', stsCredentialsOptions.requestedTokenType);
    }
    
    if (stsCredentialsOptions.actingParty) {
      body.append('actor_token', stsCredentialsOptions.actingParty.actorToken);
      body.append('actor_token_type', stsCredentialsOptions.actingParty.actorTokenType);
    }
    
    // Add client authentication if provided
    if (this.clientAuthentication) {
      switch (this.clientAuthentication.authMethod) {
        case 'client_secret_basic':
          // Basic auth via Authorization header
          const credentials = btoa(`${this.clientAuthentication.clientId}:${this.clientAuthentication.clientSecret}`);
          additionalHeaders = {
            ...additionalHeaders,
            'Authorization': `Basic ${credentials}`
          };
          break;
          
        case 'client_secret_post':
          // Client credentials in request body
          body.append('client_id', this.clientAuthentication.clientId);
          body.append('client_secret', this.clientAuthentication.clientSecret);
          break;
          
        case 'none':
        default:
          // No client authentication
          break;
      }
    }
    
    // Add additional options as JSON if provided
    if (options) {
      body.append('options', JSON.stringify(options));
    }
    
    // Prepare headers
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...additionalHeaders,
    };
    
    // Make the token exchange request with retry logic
    let lastError: Error;
    
    for (let attempt = 1; attempt <= (this.retryConfig?.maxAttempts || 1); attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        const response = await fetch(this.tokenExchangeEndpoint.toString(), {
          method: 'POST',
          headers,
          body: body.toString(),
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
        }
        
        const responseData = await response.json();
        
        // Validate required fields
        if (!responseData.access_token || !responseData.issued_token_type || !responseData.token_type) {
          throw new Error('Invalid token exchange response: missing required fields');
        }
        
        return {
          access_token: responseData.access_token,
          issued_token_type: responseData.issued_token_type,
          token_type: responseData.token_type,
          expires_in: responseData.expires_in,
          refresh_token: responseData.refresh_token,
          scope: responseData.scope,
          metadata: responseData.metadata,
          res: response,
        };
        
      } catch (error) {
        lastError = error as Error;
        
        // If this is the last attempt, throw the error
        if (attempt === (this.retryConfig?.maxAttempts || 1)) {
          throw lastError;
        }
        
        // Calculate backoff delay
        const backoffDelay = Math.pow(this.retryConfig?.backoffFactor || 2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
    
    throw lastError!;
  }
  
  /**
   * Validates a token exchange response against RFC 8693 requirements.
   * 
   * @param response The token exchange response to validate
   * @throws Error if the response is invalid
   */
  static validateResponse(response: StsSuccessfulResponse): void {
    if (!response.access_token) {
      throw new Error('Response missing required field: access_token');
    }
    
    if (!response.issued_token_type) {
      throw new Error('Response missing required field: issued_token_type');
    }
    
    if (!response.token_type) {
      throw new Error('Response missing required field: token_type');
    }
    
    // Validate token type format
    const validTokenTypes = [
      'urn:ietf:params:oauth:token-type:access_token',
      'urn:ietf:params:oauth:token-type:refresh_token',
      'urn:ietf:params:oauth:token-type:id_token',
      'urn:ietf:params:oauth:token-type:saml1',
      'urn:ietf:params:oauth:token-type:saml2',
      'urn:ietf:params:oauth:token-type:jwt',
    ];
    
    if (!validTokenTypes.includes(response.issued_token_type)) {
      console.warn(`Unrecognized token type: ${response.issued_token_type}`);
    }
  }
  
  /**
   * Creates a Cloudflare Workers-friendly token exchange client
   * using environment bindings.
   * 
   * @param env Cloudflare Workers environment
   * @returns Configured StsCredentials instance
   */
  static fromEnv(env: Env): StsCredentials {
    if (!env.TOKEN_EXCHANGE_ENDPOINT) {
      throw new Error('TOKEN_EXCHANGE_ENDPOINT environment variable is required');
    }
    
    const options: StsCredentialsConstructionOptions = {
      tokenExchangeEndpoint: env.TOKEN_EXCHANGE_ENDPOINT,
      headers: {
        'User-Agent': 'Cloudflare-Workers-Token-Exchange/1.0',
      },
    };
    
    // If ACCESS_SERVICE_TOKEN is provided, use it for client authentication
    if (env.ACCESS_SERVICE_TOKEN) {
      // NOTE: Cloudflare Access typically uses service tokens for machine-to-machine auth
      // This is a simplified example - actual implementation may vary
      options.clientAuthentication = {
        clientId: 'cloudflare-access',
        clientSecret: env.ACCESS_SERVICE_TOKEN,
        authMethod: 'client_secret_basic',
      };
    }
    
    return new StsCredentials(options);
  }
}