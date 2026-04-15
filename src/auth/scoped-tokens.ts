/**
 * Cloudflare Workers implementation of scoped token exchange.
 * Replaces Google's STS (Security Token Service) with Cloudflare Access token exchange.
 * 
 * NOTE: This implementation uses Cloudflare's token exchange patterns where:
 * - Source tokens are Cloudflare Access JWT tokens
 * - Downscoping is achieved by creating new tokens with reduced permissions
 * - Token exchange happens via Cloudflare Workers binding to Access Service Tokens
 */

export interface Env {
  // Cloudflare Access Service Token for token exchange
  ACCESS_SERVICE_TOKEN: string;
  
  // For storing token mappings and permissions
  TOKEN_STORE: KVNamespace;
  
  // For audit logging
  LOGS: D1Database;
  
  // Optional: For encrypted token storage
  ENCRYPTION_KEY?: string;
}

/**
 * Represents a permission scope for Cloudflare resources
 */
export interface ResourceScope {
  // Cloudflare resource type (e.g., 'zone', 'account', 'user')
  resourceType: string;
  
  // Resource identifier (e.g., zone ID, account ID)
  resourceId: string;
  
  // Allowed permissions for this resource
  permissions: string[];
  
  // Optional: Resource path pattern for fine-grained access
  pathPattern?: string;
}

/**
 * Credential Access Boundary defines the maximum permissions
 * a downscoped token can have
 */
export interface CredentialAccessBoundary {
  accessBoundary: {
    accessBoundaryRules: ResourceScope[];
  };
}

/**
 * Downscoped token response
 */
export interface DownscopedTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token';
}

/**
 * Source token information
 */
export interface SourceTokenInfo {
  token: string;
  permissions: string[];
  expires_at: number;
  identity: {
    email?: string;
    id?: string;
    type: 'user' | 'service' | 'api_token';
  };
}

/**
 * Maximum number of access boundary rules
 */
export const MAX_ACCESS_BOUNDARY_RULES_COUNT = 10;

/**
 * Offset for network delays and clock skew (5 minutes in milliseconds)
 */
export const EXPIRATION_TIME_OFFSET = 5 * 60 * 1000;

/**
 * Token exchange grant type (RFC 8693)
 */
const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/**
 * Requested token type (RFC 8693)
 */
const REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * Subject token type for Cloudflare Access tokens
 */
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * Cloudflare Workers implementation of downscoped token exchange
 * 
 * This class enables exchanging a source token with broad permissions
 * for a new token with reduced, scoped permissions.
 */
export class DownscopedTokenClient {
  private sourceToken: string;
  private credentialAccessBoundary: CredentialAccessBoundary;
  private cachedDownscopedToken: DownscopedTokenResponse | null = null;
  private tokenExpiry: number = 0;
  
  /**
   * Creates a new DownscopedTokenClient
   * 
   * @param sourceToken - The source Cloudflare Access token or API token
   * @param credentialAccessBoundary - The access boundary defining reduced permissions
   */
  constructor(
    sourceToken: string,
    credentialAccessBoundary: CredentialAccessBoundary
  ) {
    this.sourceToken = sourceToken;
    this.credentialAccessBoundary = credentialAccessBoundary;
    
    // Validate access boundary rules
    this.validateAccessBoundary();
  }
  
  /**
   * Validates the credential access boundary
   * @throws Error if validation fails
   */
  private validateAccessBoundary(): void {
    const rules = this.credentialAccessBoundary.accessBoundary.accessBoundaryRules;
    
    if (rules.length === 0) {
      throw new Error('At least one access boundary rule needs to be defined.');
    }
    
    if (rules.length > MAX_ACCESS_BOUNDARY_RULES_COUNT) {
      throw new Error(`The provided access boundary has more than ${MAX_ACCESS_BOUNDARY_RULES_COUNT} access boundary rules.`);
    }
    
    for (const rule of rules) {
      if (rule.permissions.length === 0) {
        throw new Error('At least one permission should be defined in access boundary rules.');
      }
      
      // Validate resource type and ID
      if (!rule.resourceType || !rule.resourceId) {
        throw new Error('Resource type and ID are required for each access boundary rule.');
      }
    }
  }
  
  /**
   * Exchanges the source token for a downscoped token
   * 
   * NOTE: In Cloudflare's model, we simulate token exchange by:
   * 1. Validating the source token
   * 2. Creating a new token with reduced permissions
   * 3. Storing the mapping in KV for validation
   * 
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to the downscoped token response
   */
  async exchangeToken(env: Env): Promise<DownscopedTokenResponse> {
    // Validate source token first
    const sourceTokenInfo = await this.validateSourceToken(env);
    
    // Check if we have a valid cached token
    if (this.cachedDownscopedToken && !this.isTokenExpired()) {
      return this.cachedDownscopedToken;
    }
    
    // Create downscoped permissions
    const downscopedPermissions = this.createDownscopedPermissions(sourceTokenInfo.permissions);
    
    // Generate a new token (in real implementation, this would call Cloudflare's token service)
    const downscopedToken = await this.generateDownscopedToken(env, downscopedPermissions);
    
    // Store token mapping for validation
    await this.storeTokenMapping(env, downscopedToken.access_token, {
      sourceToken: this.sourceToken,
      permissions: downscopedPermissions,
      identity: sourceTokenInfo.identity,
      expiresAt: Date.now() + (downscopedToken.expires_in * 1000)
    });
    
    // Cache the token
    this.cachedDownscopedToken = downscopedToken;
    this.tokenExpiry = Date.now() + (downscopedToken.expires_in * 1000);
    
    // Log the token exchange
    await this.logTokenExchange(env, sourceTokenInfo, downscopedToken);
    
    return downscopedToken;
  }
  
  /**
   * Validates the source token and extracts its permissions
   */
  private async validateSourceToken(env: Env): Promise<SourceTokenInfo> {
    // NOTE: In a real implementation, this would validate against Cloudflare's token validation endpoint
    // For now, we'll simulate by parsing JWT (if it's a JWT) or checking against a known token
    
    try {
      // For Cloudflare Access JWT tokens, we would validate the signature
      // and extract claims. For API tokens, we would need to check with Cloudflare's API.
      
      // This is a simplified implementation
      const tokenParts = this.sourceToken.split('.');
      
      if (tokenParts.length === 3) {
        // Likely a JWT - decode payload
        const payload = JSON.parse(atob(tokenParts[1]));
        
        return {
          token: this.sourceToken,
          permissions: payload.permissions || [],
          expires_at: payload.exp ? payload.exp * 1000 : Date.now() + 3600000,
          identity: {
            email: payload.email,
            id: payload.sub,
            type: payload.type || 'user'
          }
        };
      } else {
        // Assume it's an API token - in real implementation, validate via Cloudflare API
        return {
          token: this.sourceToken,
          permissions: ['*'], // Assume full permissions for API tokens
          expires_at: Date.now() + 3600000, // Default 1 hour
          identity: {
            type: 'api_token'
          }
        };
      }
    } catch (error) {
      throw new Error(`Invalid source token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Creates downscoped permissions based on access boundary rules
   */
  private createDownscopedPermissions(sourcePermissions: string[]): string[] {
    const downscopedPermissions: string[] = [];
    const rules = this.credentialAccessBoundary.accessBoundary.accessBoundaryRules;
    
    for (const rule of rules) {
      // Filter source permissions to only include those allowed by the rule
      const allowedPermissions = rule.permissions.filter(permission => 
        sourcePermissions.includes('*') || sourcePermissions.includes(permission)
      );
      
      // Format permissions with resource scope
      for (const permission of allowedPermissions) {
        downscopedPermissions.push(`${permission}:${rule.resourceType}/${rule.resourceId}`);
        
        // Add path pattern if specified
        if (rule.pathPattern) {
          downscopedPermissions.push(`${permission}:${rule.resourceType}/${rule.resourceId}/${rule.pathPattern}`);
        }
      }
    }
    
    return downscopedPermissions;
  }
  
  /**
   * Generates a downscoped token
   * 
   * NOTE: In production, this would call Cloudflare's token issuance service
   * For now, we generate a synthetic token for demonstration
   */
  private async generateDownscopedToken(
    env: Env,
    permissions: string[]
  ): Promise<DownscopedTokenResponse> {
    // Generate a token ID (in production, this would come from Cloudflare)
    const tokenId = crypto.randomUUID();
    
    // Create a synthetic token
    // In real implementation, this would be signed by Cloudflare
    const tokenPayload = {
      jti: tokenId,
      iss: 'https://cloudflare.com',
      sub: 'downscoped_token',
      aud: ['https://api.cloudflare.com'],
      exp: Math.floor((Date.now() + 3600000) / 1000), // 1 hour expiry
      iat: Math.floor(Date.now() / 1000),
      permissions: permissions,
      scope: permissions.join(' ')
    };
    
    // Base64 encode the payload (in production, this would be a proper JWT)
    const encodedPayload = btoa(JSON.stringify(tokenPayload));
    const token = `cfdownscoped.${encodedPayload}.signature`;
    
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600, // 1 hour in seconds
      scope: permissions.join(' '),
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    };
  }
  
  /**
   * Stores the token mapping in KV for validation
   */
  private async storeTokenMapping(
    env: Env,
    downscopedToken: string,
    metadata: {
      sourceToken: string;
      permissions: string[];
      identity: SourceTokenInfo['identity'];
      expiresAt: number;
    }
  ): Promise<void> {
    const tokenId = downscopedToken.split('.')[1]; // Extract payload part
    
    await env.TOKEN_STORE.put(
      `token:${tokenId}`,
      JSON.stringify({
        ...metadata,
        createdAt: Date.now(),
        downscopedToken: downscopedToken
      }),
      {
        expirationTtl: Math.floor((metadata.expiresAt - Date.now()) / 1000)
      }
    );
  }
  
  /**
   * Logs the token exchange for audit purposes
   */
  private async logTokenExchange(
    env: Env,
    sourceTokenInfo: SourceTokenInfo,
    downscopedToken: DownscopedTokenResponse
  ): Promise<void> {
    if (!env.LOGS) return;
    
    try {
      await env.LOGS.prepare(`
        INSERT INTO token_exchange_logs (
          timestamp,
          source_token_id,
          downscoped_token_id,
          source_identity,
          permissions_granted,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        Date.now(),
        this.sourceToken.substring(0, 32), // Truncate for logging
        downscopedToken.access_token.substring(0, 32),
        JSON.stringify(sourceTokenInfo.identity),
        downscopedToken.scope,
        Date.now() + (downscopedToken.expires_in * 1000)
      ).run();
    } catch (error) {
      // Log to console if DB insert fails
      console.error('Failed to log token exchange:', error);
    }
  }
  
  /**
   * Checks if the cached token is expired
   */
  private isTokenExpired(): boolean {
    if (!this.cachedDownscopedToken) return true;
    
    const now = Date.now();
    return now >= (this.tokenExpiry - EXPIRATION_TIME_OFFSET);
  }
  
  /**
   * Gets the authorization header with the downscoped token
   */
  async getAuthorizationHeader(env: Env): Promise<string> {
    const tokenResponse = await this.exchangeToken(env);
    return `Bearer ${tokenResponse.access_token}`;
  }
  
  /**
   * Validates a downscoped token
   * 
   * This can be used by resource servers to validate incoming tokens
   */
  static async validateToken(
    env: Env,
    token: string,
    requiredPermission: string,
    resourcePath: string
  ): Promise<boolean> {
    try {
      // Extract token ID from the token
      const tokenParts = token.split('.');
      if (tokenParts.length < 2) return false;
      
      const tokenId = tokenParts[1];
      
      // Look up token metadata
      const metadata = await env.TOKEN_STORE.get(`token:${tokenId}`, 'json');
      if (!metadata) return false;
      
      // Check if token is expired
      if (Date.now() > metadata.expiresAt) {
        // Clean up expired token
        await env.TOKEN_STORE.delete(`token:${tokenId}`);
        return false;
      }
      
      // Check permissions
      const permissions: string[] = metadata.permissions || [];
      
      // Check for exact permission match or wildcard
      const hasPermission = permissions.some(p => {
        // Exact match
        if (p === requiredPermission || p === '*') return true;
        
        // Check if permission includes resource path
        if (p.startsWith(requiredPermission + ':')) {
          const resourcePattern = p.substring(requiredPermission.length + 1);
          
          // Simple path matching - in production, use proper path matching
          if (resourcePath.startsWith(resourcePattern) || 
              resourcePattern === '*' ||
              resourcePattern === '**') {
            return true;
          }
        }
        
        return false;
      });
      
      return hasPermission;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  }
  
  /**
   * Revokes a downscoped token
   */
  static async revokeToken(env: Env, token: string): Promise<void> {
    const tokenParts = token.split('.');
    if (tokenParts.length < 2) return;
    
    const tokenId = tokenParts[1];
    await env.TOKEN_STORE.delete(`token:${tokenId}`);
  }
}

/**
 * Worker handler for token exchange endpoint
 * 
 * This implements the RFC 8693 token exchange endpoint as a Cloudflare Worker
 */
export async function handleTokenExchange(
  request: Request,
  env: Env
): Promise<Response> {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  try {
    const formData = await request.formData();
    
    // Validate required parameters (RFC 8693)
    const grantType = formData.get('grant_type');
    const subjectToken = formData.get('subject_token');
    const subjectTokenType = formData.get('subject_token_type');
    const requestedTokenType = formData.get('requested_token_type');
    
    if (grantType !== TOKEN_EXCHANGE_GRANT_TYPE) {
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid grant type'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (subjectTokenType !== SUBJECT_TOKEN_TYPE) {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Invalid subject token type'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (requestedTokenType !== REQUESTED_TOKEN_TYPE) {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Invalid requested token type'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (!subjectToken || typeof subjectToken !== 'string') {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing subject token'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Parse access boundary from form data
    const scope = formData.get('scope');
    const resource = formData.get('resource');
    
    // NOTE: In Google's implementation, the access boundary is passed in the request
    // For Cloudflare, we might pass it differently or have it pre-configured
    // For now, we'll use a simplified approach
    
    // Create a simple access boundary from scope/resource parameters
    const accessBoundary: CredentialAccessBoundary = {
      accessBoundary: {
        accessBoundaryRules: []
      }
    };
    
    if (scope) {
      // Parse scope string into permissions
      const permissions = (scope as string).split(' ');
      
      if (resource) {
        // Parse resource into resource type and ID
        const resourceParts = (resource as string).split('/');
        if (resourceParts.length >= 2) {
          accessBoundary.accessBoundary.accessBoundaryRules.push({
            resourceType: resourceParts[0],
            resourceId: resourceParts[1],
            permissions: permissions
          });
        }
      }
    }
    
    // Create downscoped token client
    const client = new DownscopedTokenClient(subjectToken as string, accessBoundary);
    
    // Exchange token
    const tokenResponse = await client.exchangeToken(env);
    
    // Return RFC 8693 compliant response
    return new Response(JSON.stringify({
      access_token: tokenResponse.access_token,
      issued_token_type: tokenResponse.issued_token_type,
      token_type: tokenResponse.token_type,
      expires_in: tokenResponse.expires_in,
      scope: tokenResponse.scope
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache'
      }
    });
    
  } catch (error) {
    console.error('Token exchange error:', error);
    
    return new Response(JSON.stringify({
      error: 'invalid_request',
      error_description: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Example Worker using the downscoped token client
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Token exchange endpoint
    if (url.pathname === '/token' && request.method === 'POST') {
      return handleTokenExchange(request, env);
    }
    
    // Resource endpoint that validates downscoped tokens
    if (url.pathname.startsWith('/api/')) {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized', { status: 401 });
      }
      
      const token = authHeader.substring(7);
      
      // Validate the token has permission for this resource
      const hasPermission = await DownscopedTokenClient.validateToken(
        env,
        token,
        'read', // Required permission
        url.pathname // Resource path
      );
      
      if (!hasPermission) {
        return new Response('Forbidden', { status: 403 });
      }
      
      // Process the request
      return new Response(JSON.stringify({
        message: 'Access granted with downscoped token',
        path: url.pathname,
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};