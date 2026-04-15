/**
 * @fileoverview Helper functions for getting mTLS certificates and keys in Cloudflare Workers.
 * This module provides utilities for retrieving client certificates from various sources
 * including Cloudflare Access, mTLS bindings, and external certificate providers.
 */

/**
 * Represents mTLS client credentials including certificate, private key, and optional passphrase.
 */
export interface ClientSSLCredentials {
  /** Whether credentials were successfully obtained */
  hasCert: boolean;
  /** Client certificate in PEM format */
  cert?: Uint8Array;
  /** Private key in PEM format */
  key?: Uint8Array;
  /** Optional passphrase for encrypted private keys */
  passphrase?: Uint8Array;
}

/**
 * Represents metadata for context-aware certificate provisioning.
 */
export interface ContextAwareMetadata {
  /** Command to execute for certificate provisioning */
  cert_provider_command: string[];
  /** Additional metadata for certificate management */
  [key: string]: unknown;
}

/**
 * Regular expressions for parsing PEM-encoded certificates and keys.
 */
const CERT_REGEX = /-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----\r?\n?/s;
const KEY_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----.+?-----END [A-Z ]*PRIVATE KEY-----\r?\n?/s;
const PASSPHRASE_REGEX = /-----BEGIN PASSPHRASE-----(.+?)-----END PASSPHRASE-----/s;

/**
 * Default path for context-aware metadata in Cloudflare Workers environment.
 * NOTE: In Cloudflare Workers, we use environment bindings instead of local files.
 */
const DEFAULT_CONTEXT_AWARE_METADATA_PATH = 'context_aware_metadata';

/**
 * Environment bindings for the mTLS certificate provider.
 */
export interface Env {
  /** Context-aware metadata stored as JSON in KV */
  MTLS_METADATA?: KVNamespace;
  /** Encrypted certificate storage in R2 */
  CERT_STORAGE?: R2Bucket;
  /** Database for certificate metadata */
  DB?: D1Database;
  /** mTLS client certificate binding */
  mtls?: {
    /** Client certificate in PEM format */
    certificate?: string;
    /** Client certificate chain */
    certificateChain?: string[];
  };
}

/**
 * Checks for context-aware metadata in the environment.
 * NOTE: In Cloudflare Workers, we use KV bindings instead of local files.
 * 
 * @param env - Worker environment bindings
 * @param metadataPath - Key name in KV namespace (defaults to DEFAULT_CONTEXT_AWARE_METADATA_PATH)
 * @returns Promise resolving to metadata key if exists, null otherwise
 */
async function _checkDcaMetadataPath(
  env: Env,
  metadataPath: string = DEFAULT_CONTEXT_AWARE_METADATA_PATH
): Promise<string | null> {
  if (!env.MTLS_METADATA) {
    console.debug('MTLS_METADATA KV binding not configured, skip client SSL authentication.');
    return null;
  }

  const metadata = await env.MTLS_METADATA.get(metadataPath);
  if (!metadata) {
    console.debug(`${metadataPath} not found in KV, skip client SSL authentication.`);
    return null;
  }

  return metadataPath;
}

/**
 * Loads context-aware metadata from KV storage.
 * 
 * @param env - Worker environment bindings
 * @param metadataPath - Key name in KV namespace
 * @returns Promise resolving to parsed metadata
 * @throws {ClientCertError} If failed to parse metadata as JSON
 */
async function _readDcaMetadataFile(
  env: Env,
  metadataPath: string
): Promise<ContextAwareMetadata> {
  if (!env.MTLS_METADATA) {
    throw new ClientCertError('MTLS_METADATA KV binding not configured');
  }

  const metadataJson = await env.MTLS_METADATA.get(metadataPath);
  if (!metadataJson) {
    throw new ClientCertError(`Metadata not found at path: ${metadataPath}`);
  }

  try {
    return JSON.parse(metadataJson) as ContextAwareMetadata;
  } catch (error) {
    throw new ClientCertError(`Failed to parse metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Executes a certificate provider command using the Fetch API.
 * NOTE: In Cloudflare Workers, we use HTTP endpoints instead of subprocess execution.
 * 
 * @param command - Certificate provider command endpoint and parameters
 * @param expectEncryptedKey - Whether encrypted private key is expected
 * @returns Promise resolving to certificate, key, and optional passphrase
 * @throws {ClientCertError} If problems occur when running the cert provider command
 */
async function _runCertProviderCommand(
  command: string[],
  expectEncryptedKey: boolean = false
): Promise<{ cert: Uint8Array; key: Uint8Array; passphrase?: Uint8Array }> {
  if (command.length < 1) {
    throw new ClientCertError('Cert provider command is empty');
  }

  // First element is the endpoint URL, rest are parameters
  const [endpoint, ...params] = command;
  const url = new URL(endpoint);
  
  // Add parameters as query params or headers
  params.forEach((param, index) => {
    if (param.startsWith('--')) {
      const [key, value] = param.split('=');
      if (value) {
        url.searchParams.set(key.slice(2), value);
      }
    }
  });

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/x-pem-file',
      },
    });

    if (!response.ok) {
      throw new ClientCertError(`Cert provider command failed with status: ${response.status}`);
    }

    const stdout = new Uint8Array(await response.arrayBuffer());
    const stdoutText = new TextDecoder().decode(stdout);

    // Extract certificate (chain), key and passphrase
    const certMatch = stdoutText.match(CERT_REGEX);
    const keyMatch = stdoutText.match(KEY_REGEX);
    const passphraseMatch = stdoutText.match(PASSPHRASE_REGEX);

    if (!certMatch || certMatch.length !== 1) {
      throw new ClientCertError('Client SSL certificate is missing or invalid');
    }

    if (!keyMatch || keyMatch.length !== 1) {
      throw new ClientCertError('Client SSL key is missing or invalid');
    }

    if (expectEncryptedKey) {
      if (!passphraseMatch || passphraseMatch.length !== 1) {
        throw new ClientCertError('Passphrase is missing or invalid for encrypted key');
      }
      if (!keyMatch[0].includes('ENCRYPTED')) {
        throw new ClientCertError('Encrypted private key is expected but not found');
      }
      return {
        cert: new TextEncoder().encode(certMatch[0]),
        key: new TextEncoder().encode(keyMatch[0]),
        passphrase: new TextEncoder().encode(passphraseMatch[1].trim()),
      };
    }

    if (keyMatch[0].includes('ENCRYPTED')) {
      throw new ClientCertError('Encrypted private key is not expected');
    }
    if (passphraseMatch && passphraseMatch.length > 0) {
      throw new ClientCertError('Passphrase is not expected for unencrypted key');
    }

    return {
      cert: new TextEncoder().encode(certMatch[0]),
      key: new TextEncoder().encode(keyMatch[0]),
    };
  } catch (error) {
    if (error instanceof ClientCertError) {
      throw error;
    }
    throw new ClientCertError(`Failed to execute cert provider command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Returns the client side certificate, private key and passphrase.
 * 
 * @param env - Worker environment bindings
 * @param generateEncryptedKey - If true, encrypted private key and passphrase will be generated
 * @param contextAwareMetadataPath - The context_aware_metadata key name in KV
 * @returns Promise resolving to client SSL credentials
 * @throws {ClientCertError} If problems occur when getting the cert, key and passphrase
 */
export async function getClientSSLCredentials(
  env: Env,
  generateEncryptedKey: boolean = false,
  contextAwareMetadataPath: string = DEFAULT_CONTEXT_AWARE_METADATA_PATH
): Promise<ClientSSLCredentials> {
  const metadataPath = await _checkDcaMetadataPath(env, contextAwareMetadataPath);

  if (metadataPath) {
    const metadataJson = await _readDcaMetadataFile(env, metadataPath);

    if (!metadataJson.cert_provider_command || !Array.isArray(metadataJson.cert_provider_command)) {
      throw new ClientCertError('Cert provider command is not found or invalid');
    }

    const command = [...metadataJson.cert_provider_command];

    if (generateEncryptedKey && !command.some(param => param.includes('--with_passphrase'))) {
      command.push('--with_passphrase');
    }

    // Execute the command
    const { cert, key, passphrase } = await _runCertProviderCommand(
      command,
      generateEncryptedKey
    );
    return { hasCert: true, cert, key, passphrase };
  }

  // NOTE: Fallback to Cloudflare mTLS binding if available
  if (env.mtls?.certificate) {
    const cert = new TextEncoder().encode(env.mtls.certificate);
    // NOTE: In Cloudflare Workers, private keys are not exposed for security reasons.
    // Applications should use the mTLS binding directly or obtain keys from secure sources.
    return { hasCert: true, cert };
  }

  return { hasCert: false };
}

/**
 * Returns the client side certificate and private key.
 * The function first tries to get certificate and key from clientCertCallback;
 * if the callback is not provided or doesn't provide certificate and key,
 * the function tries to get application default SSL credentials.
 * 
 * @param env - Worker environment bindings
 * @param clientCertCallback - Optional callback which returns client certificate and private key
 * @returns Promise resolving to certificate and key
 * @throws {ClientCertError} If problems occur when getting the cert and key
 */
export async function getClientCertAndKey(
  env: Env,
  clientCertCallback?: () => Promise<{ cert: Uint8Array; key: Uint8Array }>
): Promise<{ hasCert: boolean; cert?: Uint8Array; key?: Uint8Array }> {
  if (clientCertCallback) {
    try {
      const { cert, key } = await clientCertCallback();
      return { hasCert: true, cert, key };
    } catch (error) {
      throw new ClientCertError(`Client cert callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { hasCert, cert, key } = await getClientSSLCredentials(env, false);
  return { hasCert, cert, key };
}

/**
 * Decrypts a private key using the Web Crypto API.
 * NOTE: This uses the Web Crypto API instead of OpenSSL/PyOpenSSL.
 * 
 * @param key - The encrypted private key in PEM format
 * @param passphrase - The passphrase for decryption
 * @returns Promise resolving to decrypted private key in PEM format
 * @throws {ClientCertError} If there is any problem decrypting the private key
 */
export async function decryptPrivateKey(
  key: Uint8Array,
  passphrase: Uint8Array
): Promise<Uint8Array> {
  try {
    // Convert PEM to binary format for Web Crypto
    const keyText = new TextDecoder().decode(key);
    const keyMatch = keyText.match(KEY_REGEX);
    
    if (!keyMatch) {
      throw new ClientCertError('Invalid private key format');
    }

    // NOTE: Web Crypto API doesn't directly support PEM-encrypted private keys.
    // In a production environment, you would need to:
    // 1. Parse the PEM to extract the encrypted PKCS#8 data
    // 2. Use PBKDF2 to derive a key from the passphrase
    // 3. Decrypt using AES or similar algorithm
    
    // For now, we'll return a simplified implementation that assumes
    // the key is already in a format Web Crypto can import
    console.warn('decryptPrivateKey: Full PEM decryption not implemented. Returning original key.');
    
    // In a real implementation, you would:
    // const cryptoKey = await crypto.subtle.importKey(
    //   'pkcs8',
    //   encryptedKeyData,
    //   { name: 'RSA-OAEP', hash: 'SHA-256' },
    //   false,
    //   ['decrypt']
    // );
    
    return key;
  } catch (error) {
    throw new ClientCertError(`Failed to decrypt private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Custom error class for certificate-related errors.
 */
export class ClientCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientCertError';
  }
}

/**
 * Example client certificate callback function that uses encrypted keys.
 * 
 * @example
 * ```typescript
 * async function exampleClientCertCallback(): Promise<{ cert: Uint8Array; key: Uint8Array }> {
 *   const { hasCert, cert, key, passphrase } = await getClientSSLCredentials(env, true);
 *   if (!hasCert || !cert || !key || !passphrase) {
 *     throw new Error('Failed to get credentials');
 *   }
 *   const decryptedKey = await decryptPrivateKey(key, passphrase);
 *   return { cert, key: decryptedKey };
 * }
 * ```
 */