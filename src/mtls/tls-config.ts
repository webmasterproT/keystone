// NOTE: This is a simplified TLS configuration module for Cloudflare Workers.
// Cloudflare Workers handle TLS termination at the edge, so most SSL/TLS
// configuration is managed by Cloudflare. This module provides utilities
// for working with client certificates (mTLS) and certificate validation
// in Cloudflare Workers.

/**
 * TLS configuration utilities for Cloudflare Workers
 * 
 * Cloudflare Workers handle TLS termination at the edge, but you can:
 * 1. Validate client certificates for mTLS
 * 2. Work with certificate data in requests
 * 3. Configure certificate validation policies
 */

export interface Certificate {
  /** PEM-encoded certificate */
  pem: string;
  /** Certificate subject */
  subject: Record<string, string>;
  /** Certificate issuer */
  issuer: Record<string, string>;
  /** Validity period */
  validFrom: Date;
  validTo: Date;
  /** Serial number */
  serialNumber: string;
  /** Subject Alternative Names */
  subjectAltName?: {
    dnsNames?: string[];
    ipAddresses?: string[];
  };
}

export interface CertificateValidationOptions {
  /** Whether to require a client certificate */
  requireClientCertificate?: boolean;
  /** List of trusted CA certificates (PEM format) */
  trustedCAs?: string[];
  /** Whether to validate certificate expiration */
  checkExpiration?: boolean;
  /** Whether to validate hostname against certificate */
  checkHostname?: boolean;
  /** Expected hostname for validation */
  expectedHostname?: string;
}

export enum CertificateValidationResult {
  VALID = 'VALID',
  INVALID = 'INVALID',
  EXPIRED = 'EXPIRED',
  UNTRUSTED = 'UNTRUSTED',
  HOSTNAME_MISMATCH = 'HOSTNAME_MISMATCH',
  MISSING = 'MISSING'
}

export enum TLSVersion {
  TLSv1_0 = 'TLSv1.0',
  TLSv1_1 = 'TLSv1.1',
  TLSv1_2 = 'TLSv1.2',
  TLSv1_3 = 'TLSv1.3'
}

/**
 * Parse a PEM-encoded certificate
 */
export function parseCertificate(pem: string): Certificate | null {
  try {
    // NOTE: In Cloudflare Workers, we can't parse X.509 certificates directly
    // without external libraries. This is a simplified implementation.
    // For production use, consider using a WebAssembly module or
    // Cloudflare's built-in certificate validation.
    
    // Extract basic info from PEM
    const lines = pem.trim().split('\n');
    if (lines.length < 3) return null;
    
    // Simple regex to extract common fields (this is very basic)
    const subjectMatch = pem.match(/CN=([^,\n]+)/);
    const issuerMatch = pem.match(/Issuer:.*CN=([^,\n]+)/);
    const dateMatches = pem.match(/Not Before : ([^\n]+)\n.*Not After : ([^\n]+)/);
    
    return {
      pem,
      subject: { commonName: subjectMatch?.[1] || 'Unknown' },
      issuer: { commonName: issuerMatch?.[1] || 'Unknown' },
      validFrom: dateMatches?.[1] ? new Date(dateMatches[1]) : new Date(),
      validTo: dateMatches?.[2] ? new Date(dateMatches[2]) : new Date(),
      serialNumber: '0', // Would need proper parsing
      subjectAltName: undefined
    };
  } catch {
    return null;
  }
}

/**
 * Validate a certificate against options
 */
export function validateCertificate(
  certificate: Certificate | null,
  options: CertificateValidationOptions = {}
): CertificateValidationResult {
  if (!certificate) {
    return options.requireClientCertificate ? 
      CertificateValidationResult.MISSING : 
      CertificateValidationResult.VALID;
  }

  // Check expiration
  if (options.checkExpiration !== false) {
    const now = new Date();
    if (now < certificate.validFrom) {
      return CertificateValidationResult.INVALID;
    }
    if (now > certificate.validTo) {
      return CertificateValidationResult.EXPIRED;
    }
  }

  // Check hostname
  if (options.checkHostname && options.expectedHostname) {
    if (!validateHostname(certificate, options.expectedHostname)) {
      return CertificateValidationResult.HOSTNAME_MISMATCH;
    }
  }

  // NOTE: In Cloudflare Workers, certificate chain validation is handled
  // by Cloudflare at the edge. For custom CA validation, you would need
  // to implement or use a WebAssembly module.
  
  return CertificateValidationResult.VALID;
}

/**
 * Validate hostname against certificate
 * Simplified version for Cloudflare Workers
 */
export function validateHostname(
  certificate: Certificate,
  hostname: string
): boolean {
  // Check common name
  const cn = certificate.subject.commonName;
  if (cn && matchesHostname(cn, hostname)) {
    return true;
  }

  // Check subject alternative names
  const sans = certificate.subjectAltName;
  if (sans?.dnsNames) {
    for (const dnsName of sans.dnsNames) {
      if (matchesHostname(dnsName, hostname)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Simple hostname matching (supports basic wildcards)
 */
function matchesHostname(pattern: string, hostname: string): boolean {
  // Convert to lowercase for case-insensitive comparison
  pattern = pattern.toLowerCase();
  hostname = hostname.toLowerCase();

  // Exact match
  if (pattern === hostname) {
    return true;
  }

  // Wildcard match (only supports *.example.com format)
  if (pattern.startsWith('*.')) {
    const patternDomain = pattern.substring(2);
    const hostnameDomain = hostname.substring(hostname.indexOf('.') + 1);
    return patternDomain === hostnameDomain;
  }

  return false;
}

/**
 * Extract client certificate from Cloudflare Workers request
 * Cloudflare passes client certificate info in headers when mTLS is enabled
 */
export function getClientCertificate(request: Request): Certificate | null {
  // NOTE: Cloudflare adds client certificate info in headers when mTLS is enabled
  // The actual headers depend on your Cloudflare configuration
  const certHeader = request.headers.get('ssl-client-cert');
  
  if (!certHeader) {
    return null;
  }

  // Certificate is usually URL-encoded in headers
  try {
    const certPem = decodeURIComponent(certHeader.replace(/\+/g, ' '));
    return parseCertificate(certPem);
  } catch {
    return null;
  }
}

/**
 * Create a TLS context for outbound requests
 * NOTE: Cloudflare Workers handle TLS for fetch() automatically
 * This is for configuration/documentation purposes
 */
export interface TLSContext {
  minVersion?: TLSVersion;
  maxVersion?: TLSVersion;
  rejectUnauthorized?: boolean;
  checkServerIdentity?: (hostname: string, cert: Certificate) => boolean;
}

/**
 * Apply TLS context to fetch options
 */
export function applyTLSContext(
  options: RequestInit,
  context: TLSContext
): RequestInit {
  // NOTE: Cloudflare Workers fetch() doesn't support custom TLS contexts
  // TLS settings are configured at the zone level in Cloudflare dashboard
  // This function is for API compatibility only
  
  const headers = new Headers(options.headers);
  
  // We can pass TLS requirements as custom headers for upstream services
  if (context.minVersion) {
    headers.set('X-TLS-Min-Version', context.minVersion);
  }
  if (context.maxVersion) {
    headers.set('X-TLS-Max-Version', context.maxVersion);
  }
  
  return {
    ...options,
    headers
  };
}

/**
 * Convert certificate time string to Date
 * Supports formats like "Jan  1 00:00:00 2023 GMT"
 */
export function certTimeToDate(timeStr: string): Date {
  // NOTE: This is a simplified implementation
  // Full implementation would need to parse various date formats
  
  try {
    // Try to parse as ISO string first
    const isoDate = new Date(timeStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
    
    // Try common certificate date formats
    const months: Record<string, number> = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
      'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    
    // Try format: "Mon DD HH:MM:SS YYYY [GMT]"
    const parts = timeStr.trim().split(/\s+/);
    if (parts.length >= 5) {
      const month = months[parts[0]];
      const day = parseInt(parts[1], 10);
      const timeParts = parts[2].split(':');
      const year = parseInt(parts[3], 10);
      
      if (month !== undefined && !isNaN(day) && timeParts.length === 3 && !isNaN(year)) {
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);
        const second = parseInt(timeParts[2], 10);
        
        return new Date(Date.UTC(year, month, day, hour, minute, second));
      }
    }
  } catch {
    // Fallback to current date if parsing fails
  }
  
  return new Date();
}

/**
 * Convert DER certificate to PEM format
 */
export function derToPem(derBytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...derBytes));
  const chunks = [];
  
  for (let i = 0; i < base64.length; i += 64) {
    chunks.push(base64.slice(i, i + 64));
  }
  
  return `-----BEGIN CERTIFICATE-----\n${chunks.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Convert PEM certificate to DER format
 */
export function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  return bytes;
}

/**
 * TLS configuration for Cloudflare Workers environment
 */
export interface CloudflareTLSConfig {
  /** Minimum TLS version required */
  minTlsVersion?: '1.0' | '1.1' | '1.2' | '1.3';
  /** Whether to enable mTLS (client certificates) */
  mtlsEnabled?: boolean;
  /** List of allowed client certificate policies (configured in Cloudflare dashboard) */
  mtlsPolicies?: string[];
}

/**
 * Environment bindings for TLS configuration
 */
export interface Env {
  /** mTLS configuration (if using Cloudflare mTLS) */
  MTLS_CONFIG?: string;
  /** Trusted CA certificates (stored in KV or as secret) */
  TRUSTED_CAS?: string;
  /** Certificate validation mode */
  CERT_VALIDATION_MODE?: 'NONE' | 'OPTIONAL' | 'REQUIRED';
}

/**
 * Main TLS configuration class for Cloudflare Workers
 */
export class TLSConfig {
  private trustedCAs: string[] = [];
  private validationMode: 'NONE' | 'OPTIONAL' | 'REQUIRED' = 'NONE';
  
  constructor(private env: Env) {
    this.loadConfiguration();
  }
  
  private loadConfiguration(): void {
    // Load trusted CAs from environment
    if (this.env.TRUSTED_CAS) {
      this.trustedCAs = this.env.TRUSTED_CAS.split('-----END CERTIFICATE-----')
        .filter(cert => cert.trim())
        .map(cert => cert.trim() + '-----END CERTIFICATE-----');
    }
    
    // Set validation mode
    if (this.env.CERT_VALIDATION_MODE) {
      this.validationMode = this.env.CERT_VALIDATION_MODE;
    }
  }
  
  /**
   * Validate request with TLS requirements
   */
  async validateRequest(request: Request): Promise<{
    isValid: boolean;
    certificate?: Certificate;
    error?: CertificateValidationResult;
  }> {
    const certificate = getClientCertificate(request);
    
    if (this.validationMode === 'NONE') {
      return { isValid: true, certificate };
    }
    
    if (!certificate) {
      if (this.validationMode === 'REQUIRED') {
        return { 
          isValid: false, 
          error: CertificateValidationResult.MISSING 
        };
      }
      return { isValid: true };
    }
    
    const result = validateCertificate(certificate, {
      requireClientCertificate: this.validationMode === 'REQUIRED',
      trustedCAs: this.trustedCAs,
      checkExpiration: true,
      checkHostname: true,
      expectedHostname: new URL(request.url).hostname
    });
    
    return {
      isValid: result === CertificateValidationResult.VALID,
      certificate,
      error: result !== CertificateValidationResult.VALID ? result : undefined
    };
  }
  
  /**
   * Get TLS context for outbound requests
   */
  getOutboundContext(): TLSContext {
    return {
      rejectUnauthorized: this.validationMode !== 'NONE',
      checkServerIdentity: (hostname, cert) => {
        return validateHostname(cert, hostname);
      }
    };
  }
}

// Export constants for compatibility
export const CERT_NONE = 'NONE';
export const CERT_OPTIONAL = 'OPTIONAL';
export const CERT_REQUIRED = 'REQUIRED';

export const PROTOCOL_TLSv1 = TLSVersion.TLSv1_0;
export const PROTOCOL_TLSv1_1 = TLSVersion.TLSv1_1;
export const PROTOCOL_TLSv1_2 = TLSVersion.TLSv1_2;
export const PROTOCOL_TLSv1_3 = TLSVersion.TLSv1_3;
export const PROTOCOL_TLS = TLSVersion.TLSv1_2; // Default to TLS 1.2

// Default export
export default {
  parseCertificate,
  validateCertificate,
  validateHostname,
  getClientCertificate,
  applyTLSContext,
  certTimeToDate,
  derToPem,
  pemToDer,
  TLSConfig,
  CertificateValidationResult,
  TLSVersion,
  CERT_NONE,
  CERT_OPTIONAL,
  CERT_REQUIRED,
  PROTOCOL_TLSv1,
  PROTOCOL_TLSv1_1,
  PROTOCOL_TLSv1_2,
  PROTOCOL_TLSv1_3,
  PROTOCOL_TLS
};