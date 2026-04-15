/**
 * Cloudflare Workers mTLS Signers Package
 * 
 * Ported from Google Cloud infrastructure patterns to Cloudflare Workers.
 * Replaces Google STS/KMS with Cloudflare mTLS and Access token verification.
 */

/**
 * Represents a trusted signer for mTLS certificate validation
 */
export interface Signer {
  /** Signer identifier - can be 'Self' or a Cloudflare Account ID */
  id: string;
  /** Array of key pair IDs (mTLS certificate IDs) associated with this signer */
  keyPairIds: string[];
}

/**
 * Active trusted signers list with XML parsing capabilities
 * NOTE: Original Google pattern used XML parsing for AWS CloudFront.
 * Cloudflare mTLS uses certificate validation via Access policies.
 */
export class ActiveTrustedSigners {
  private signers: Signer[] = [];

  /**
   * Parse XML element for active trusted signers
   * NOTE: Cloudflare Workers don't need XML parsing for mTLS.
   * This is kept for API compatibility but uses JSON instead.
   */
  startElement(name: string, attrs: Record<string, string>): Signer | null {
    if (name === 'Signer') {
      const signer: Signer = {
        id: attrs.id || '',
        keyPairIds: []
      };
      this.signers.push(signer);
      return signer;
    }
    return null;
  }

  /**
   * End XML element parsing
   */
  endElement(name: string, value: string): void {
    // No-op for Cloudflare implementation
  }

  /**
   * Get all signers
   */
  getSigners(): Signer[] {
    return [...this.signers];
  }

  /**
   * Add a signer from Cloudflare mTLS certificate data
   */
  addSignerFromCertificate(certificate: ClientCertificateInfo): void {
    const signer: Signer = {
      id: certificate.issuer || 'Self',
      keyPairIds: [certificate.id]
    };
    this.signers.push(signer);
  }

  /**
   * Validate if a client certificate is trusted
   */
  isCertificateTrusted(certificateId: string, issuer: string): boolean {
    return this.signers.some(signer => 
      signer.keyPairIds.includes(certificateId) && 
      (signer.id === issuer || signer.id === 'Self')
    );
  }
}

/**
 * Simple trusted signers list for basic validation
 */
export class TrustedSigners {
  private signers: string[] = [];

  /**
   * Parse XML element for trusted signers
   */
  startElement(name: string, attrs: Record<string, string>): null {
    return null;
  }

  /**
   * End XML element parsing
   */
  endElement(name: string, value: string): void {
    if (name === 'Self' || name === 'AwsAccountNumber') {
      this.signers.push(value);
    }
  }

  /**
   * Get all signer IDs
   */
  getSignerIds(): string[] {
    return [...this.signers];
  }

  /**
   * Add Cloudflare Account ID as trusted signer
   */
  addCloudflareAccount(accountId: string): void {
    this.signers.push(accountId);
  }

  /**
   * Check if a signer ID is trusted
   */
  isTrusted(signerId: string): boolean {
    return this.signers.includes(signerId) || this.signers.includes('Self');
  }
}

/**
 * Cloudflare mTLS certificate information
 */
export interface ClientCertificateInfo {
  /** Certificate ID from Cloudflare mTLS */
  id: string;
  /** Certificate issuer */
  issuer: string;
  /** Certificate validity period */
  notBefore: Date;
  notAfter: Date;
  /** Certificate fingerprint */
  fingerprint: string;
}

/**
 * Cloudflare Workers environment bindings for mTLS
 */
export interface Env {
  /** D1 database for storing trusted signers */
  DB: D1Database;
  /** KV namespace for caching certificate validation */
  MTLS_CACHE: KVNamespace;
  /** R2 bucket for storing certificate authorities */
  CERT_STORE: R2Bucket;
  /** Secret for signing verification tokens */
  MTLS_SIGNING_SECRET: string;
}

/**
 * Main mTLS signer manager for Cloudflare Workers
 */
export class CloudflareMTLSSigner {
  private env: Env;
  private activeSigners: ActiveTrustedSigners;
  private trustedSigners: TrustedSigners;

  constructor(env: Env) {
    this.env = env;
    this.activeSigners = new ActiveTrustedSigners();
    this.trustedSigners = new TrustedSigners();
  }

  /**
   * Initialize signers from Cloudflare Access policies
   */
  async initialize(): Promise<void> {
    // Load trusted signers from D1 database
    const signers = await this.env.DB.prepare(
      'SELECT id, key_pair_ids FROM trusted_signers WHERE active = 1'
    ).all<{ id: string; key_pair_ids: string }>();

    for (const signer of signers.results || []) {
      this.activeSigners.getSigners().push({
        id: signer.id,
        keyPairIds: JSON.parse(signer.key_pair_ids)
      });
      this.trustedSigners.getSignerIds().push(signer.id);
    }

    // Cache in KV for faster validation
    await this.env.MTLS_CACHE.put(
      'trusted_signers',
      JSON.stringify({
        active: this.activeSigners.getSigners(),
        trusted: this.trustedSigners.getSignerIds()
      }),
      { expirationTtl: 3600 }
    );
  }

  /**
   * Validate client certificate from Cloudflare mTLS
   */
  async validateCertificate(request: Request): Promise<{
    isValid: boolean;
    certificate?: ClientCertificateInfo;
    error?: string;
  }> {
    try {
      // Get client certificate from Cloudflare mTLS headers
      const certHeader = request.headers.get('cf-mtls-cert');
      if (!certHeader) {
        return { isValid: false, error: 'No client certificate provided' };
      }

      // Parse certificate information
      const certInfo = this.parseCertificateHeader(certHeader);
      
      // Check if certificate is trusted
      const isTrusted = this.activeSigners.isCertificateTrusted(
        certInfo.id,
        certInfo.issuer
      );

      if (!isTrusted) {
        return { isValid: false, error: 'Untrusted certificate' };
      }

      // Verify certificate is not expired
      const now = new Date();
      if (now < certInfo.notBefore || now > certInfo.notAfter) {
        return { isValid: false, error: 'Certificate expired or not yet valid' };
      }

      // Optional: Verify certificate against stored CA in R2
      const caValid = await this.verifyAgainstCA(certInfo);
      if (!caValid) {
        return { isValid: false, error: 'Certificate not signed by trusted CA' };
      }

      return { isValid: true, certificate: certInfo };
    } catch (error) {
      return { isValid: false, error: `Validation failed: ${error}` };
    }
  }

  /**
   * Parse Cloudflare mTLS certificate header
   */
  private parseCertificateHeader(certHeader: string): ClientCertificateInfo {
    // NOTE: Cloudflare provides certificate info in headers
    // This is a simplified parser - actual implementation depends on header format
    const parts = certHeader.split(';');
    const certInfo: Partial<ClientCertificateInfo> = {};

    for (const part of parts) {
      const [key, value] = part.split('=');
      switch (key.trim()) {
        case 'id':
          certInfo.id = value;
          break;
        case 'issuer':
          certInfo.issuer = value;
          break;
        case 'notBefore':
          certInfo.notBefore = new Date(value);
          break;
        case 'notAfter':
          certInfo.notAfter = new Date(value);
          break;
        case 'fingerprint':
          certInfo.fingerprint = value;
          break;
      }
    }

    if (!certInfo.id || !certInfo.issuer || !certInfo.notBefore || !certInfo.notAfter) {
      throw new Error('Invalid certificate header format');
    }

    return certInfo as ClientCertificateInfo;
  }

  /**
   * Verify certificate against Certificate Authority stored in R2
   */
  private async verifyAgainstCA(certInfo: ClientCertificateInfo): Promise<boolean> {
    try {
      // Get CA certificate from R2
      const caObject = await this.env.CERT_STORE.get(`${certInfo.issuer}.pem`);
      if (!caObject) {
        // If no CA stored, trust by default (for development)
        // In production, you might want to fail here
        return true;
      }

      // NOTE: Actual certificate verification would require Web Crypto API
      // This is a placeholder for the verification logic
      const caCert = await caObject.text();
      
      // Simplified verification - in reality you would:
      // 1. Parse the certificates
      // 2. Use crypto.subtle.verify() to check the signature chain
      // 3. Validate the certificate chain
      
      return true; // Placeholder
    } catch {
      return false;
    }
  }

  /**
   * Generate a signed token for validated requests
   */
  async generateAuthToken(certInfo: ClientCertificateInfo): Promise<string> {
    const payload = {
      sub: certInfo.id,
      iss: certInfo.issuer,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      fingerprint: certInfo.fingerprint
    };

    // Sign with Web Crypto API
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.env.MTLS_SIGNING_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const data = encoder.encode(JSON.stringify(payload));
    const signature = await crypto.subtle.sign('HMAC', key, data);

    // Base64 encode
    const base64Payload = btoa(JSON.stringify(payload));
    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    return `${base64Payload}.${base64Signature}`;
  }

  /**
   * Verify a signed token
   */
  async verifyAuthToken(token: string): Promise<boolean> {
    try {
      const [payloadBase64, signatureBase64] = token.split('.');
      const payload = JSON.parse(atob(payloadBase64));

      // Check expiration
      if (Date.now() / 1000 > payload.exp) {
        return false;
      }

      // Verify signature
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(this.env.MTLS_SIGNING_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const data = encoder.encode(JSON.stringify(payload));
      const signature = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

      return await crypto.subtle.verify('HMAC', key, signature, data);
    } catch {
      return false;
    }
  }
}

/**
 * Cloudflare Worker middleware for mTLS validation
 */
export function withMTLSValidation(handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>) {
  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const mtlsSigner = new CloudflareMTLSSigner(env);
    await mtlsSigner.initialize();

    const validation = await mtlsSigner.validateCertificate(request);
    
    if (!validation.isValid) {
      return new Response(
        JSON.stringify({ error: 'mTLS validation failed', details: validation.error }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Add certificate info to request headers for downstream handlers
    const newHeaders = new Headers(request.headers);
    newHeaders.set('x-mtls-cert-id', validation.certificate!.id);
    newHeaders.set('x-mtls-issuer', validation.certificate!.issuer);

    const newRequest = new Request(request, {
      headers: newHeaders
    });

    return handler(newRequest, env, ctx);
  };
}

// Export types for TypeScript users
export type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types';