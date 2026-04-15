/**
 * Hardware Security Key Interface for Cloudflare Workers
 * 
 * Implements a high-level FIDO U2F-like API for hardware security keys
 * using WebAuthn standards and Cloudflare's mTLS infrastructure.
 * 
 * NOTE: This is a conceptual port - actual hardware key interaction
 * requires browser WebAuthn API or platform authenticators.
 * For Cloudflare Workers, we focus on mTLS client certificates
 * and WebAuthn passkey authentication patterns.
 */

export interface Env {
  // D1 database for storing key registrations
  DB: D1Database;
  // R2 bucket for storing attestation data
  BUCKET: R2Bucket;
  // KV namespace for caching challenge data
  KV: KVNamespace;
  // Optional: mTLS client certificate binding
  mTLS?: {
    clientCert: string;
    clientKey: string;
  };
}

/**
 * Client data structure for WebAuthn operations
 */
export interface ClientData {
  type: 'webauthn.create' | 'webauthn.get';
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
  tokenBinding?: {
    status: 'present' | 'supported' | 'not-supported';
    id?: string;
  };
}

/**
 * Public key credential descriptor
 */
export interface PublicKeyCredentialDescriptor {
  type: 'public-key';
  id: string;
  transports?: ('usb' | 'nfc' | 'ble' | 'internal')[];
}

/**
 * Authenticator attestation response
 */
export interface AuthenticatorAttestationResponse {
  clientDataJSON: ArrayBuffer;
  attestationObject: ArrayBuffer;
  getTransports?(): string[];
  getAuthenticatorData?(): ArrayBuffer;
  getPublicKey?(): ArrayBuffer;
  getPublicKeyAlgorithm?(): number;
}

/**
 * Authenticator assertion response
 */
export interface AuthenticatorAssertionResponse {
  clientDataJSON: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  signature: ArrayBuffer;
  userHandle?: ArrayBuffer;
}

/**
 * Registration response
 */
export interface RegistrationResponse {
  id: string;
  rawId: string;
  response: AuthenticatorAttestationResponse;
  type: 'public-key';
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  transports?: string[];
}

/**
 * Authentication response
 */
export interface AuthenticationResponse {
  id: string;
  rawId: string;
  response: AuthenticatorAssertionResponse;
  type: 'public-key';
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
}

/**
 * Registered key information
 */
export interface RegisteredKey {
  version: string;
  key_handle: string;
  app_id: string;
  transports?: string[];
  created_at: number;
  user_id?: string;
}

/**
 * Hardware key errors
 */
export class HardwareKeyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'HardwareKeyError';
  }

  static DEVICE_INELIGIBLE = 'DEVICE_INELIGIBLE';
  static TIMEOUT = 'TIMEOUT';
  static BAD_REQUEST = 'BAD_REQUEST';
  static NOT_SUPPORTED = 'NOT_SUPPORTED';
  static INVALID_KEY = 'INVALID_KEY';
}

/**
 * High-level hardware key interface for Cloudflare Workers
 * 
 * NOTE: This implementation focuses on WebAuthn standards rather than
 * direct USB HID communication, which isn't available in Workers.
 * For actual hardware key interaction, users would need to use the
 * browser's WebAuthn API and pass credentials to the Worker.
 */
export class HardwareKeyInterface {
  private origin: string;
  private env: Env;

  constructor(env: Env, origin?: string) {
    this.env = env;
    this.origin = origin || 'https://workers.cloudflare.com';
  }

  /**
   * Generate a random challenge for WebAuthn operations
   */
  private async generateChallenge(): Promise<ArrayBuffer> {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    return challenge.buffer;
  }

  /**
   * Hash data using SHA-256
   */
  private async sha256(data: string | ArrayBuffer): Promise<ArrayBuffer> {
    const buffer = typeof data === 'string' 
      ? new TextEncoder().encode(data)
      : data;
    
    return await crypto.subtle.digest('SHA-256', buffer);
  }

  /**
   * Store a challenge in KV for later validation
   */
  private async storeChallenge(
    challenge: string,
    userId: string,
    operation: 'registration' | 'authentication',
    ttl: number = 300 // 5 minutes
  ): Promise<void> {
    const key = `challenge:${operation}:${userId}:${challenge}`;
    await this.env.KV.put(key, 'active', { expirationTtl: ttl });
  }

  /**
   * Validate a challenge from KV
   */
  private async validateChallenge(
    challenge: string,
    userId: string,
    operation: 'registration' | 'authentication'
  ): Promise<boolean> {
    const key = `challenge:${operation}:${userId}:${challenge}`;
    const value = await this.env.KV.get(key);
    if (value === 'active') {
      await this.env.KV.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Create registration options for WebAuthn
   */
  async createRegistrationOptions(
    userId: string,
    userName: string,
    userDisplayName: string,
    excludeCredentials?: PublicKeyCredentialDescriptor[]
  ): Promise<CredentialCreationOptions> {
    const challenge = await this.generateChallenge();
    const challengeBase64 = btoa(String.fromCharCode(...new Uint8Array(challenge)));
    
    // Store challenge for later validation
    await this.storeChallenge(challengeBase64, userId, 'registration');

    return {
      publicKey: {
        rp: {
          name: 'Cloudflare Workers',
          id: new URL(this.origin).hostname,
        },
        user: {
          id: new TextEncoder().encode(userId),
          name: userName,
          displayName: userDisplayName,
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },  // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        timeout: 60000,
        attestation: 'direct',
        excludeCredentials,
        authenticatorSelection: {
          authenticatorAttachment: 'cross-platform',
          requireResidentKey: false,
          userVerification: 'preferred',
        },
      },
    };
  }

  /**
   * Verify a registration response
   */
  async verifyRegistration(
    userId: string,
    response: RegistrationResponse,
    expectedChallenge: string
  ): Promise<RegisteredKey> {
    // Validate the challenge
    const isValidChallenge = await this.validateChallenge(
      expectedChallenge,
      userId,
      'registration'
    );
    
    if (!isValidChallenge) {
      throw new HardwareKeyError(
        'Invalid or expired challenge',
        HardwareKeyError.BAD_REQUEST
      );
    }

    // NOTE: In a production environment, you would:
    // 1. Parse and validate the attestation object
    // 2. Verify the attestation signature
    // 3. Check the credential ID isn't already registered
    // 4. Store the public key and credential ID

    const keyHandle = btoa(String.fromCharCode(...new Uint8Array(response.rawId)));
    
    const registeredKey: RegisteredKey = {
      version: 'U2F_V2',
      key_handle: keyHandle,
      app_id: this.origin,
      transports: response.response.getTransports?.(),
      created_at: Date.now(),
      user_id: userId,
    };

    // Store in D1 database
    await this.env.DB.prepare(
      `INSERT INTO hardware_keys (
        key_handle, user_id, app_id, version, transports, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      registeredKey.key_handle,
      registeredKey.user_id,
      registeredKey.app_id,
      registeredKey.version,
      JSON.stringify(registeredKey.transports || []),
      registeredKey.created_at
    ).run();

    // Store attestation data in R2
    await this.env.BUCKET.put(
      `attestations/${registeredKey.key_handle}`,
      JSON.stringify({
        clientDataJSON: Array.from(new Uint8Array(response.response.clientDataJSON)),
        attestationObject: Array.from(new Uint8Array(response.response.attestationObject)),
      })
    );

    return registeredKey;
  }

  /**
   * Create authentication options for WebAuthn
   */
  async createAuthenticationOptions(
    userId: string,
    registeredKeys: RegisteredKey[]
  ): Promise<CredentialRequestOptions> {
    const challenge = await this.generateChallenge();
    const challengeBase64 = btoa(String.fromCharCode(...new Uint8Array(challenge)));
    
    // Store challenge for later validation
    await this.storeChallenge(challengeBase64, userId, 'authentication');

    const allowCredentials: PublicKeyCredentialDescriptor[] = registeredKeys.map(key => ({
      type: 'public-key',
      id: Uint8Array.from(atob(key.key_handle), c => c.charCodeAt(0)),
      transports: key.transports as ('usb' | 'nfc' | 'ble' | 'internal')[],
    }));

    return {
      publicKey: {
        challenge,
        timeout: 60000,
        rpId: new URL(this.origin).hostname,
        allowCredentials,
        userVerification: 'preferred',
      },
    };
  }

  /**
   * Verify an authentication response
   */
  async verifyAuthentication(
    userId: string,
    response: AuthenticationResponse,
    expectedChallenge: string,
    registeredKeys: RegisteredKey[]
  ): Promise<{
    keyHandle: string;
    signatureData: ArrayBuffer;
    clientData: ClientData;
  }> {
    // Validate the challenge
    const isValidChallenge = await this.validateChallenge(
      expectedChallenge,
      userId,
      'authentication'
    );
    
    if (!isValidChallenge) {
      throw new HardwareKeyError(
        'Invalid or expired challenge',
        HardwareKeyError.BAD_REQUEST
      );
    }

    const keyHandle = btoa(String.fromCharCode(...new Uint8Array(response.rawId)));
    
    // Find the matching registered key
    const matchingKey = registeredKeys.find(key => key.key_handle === keyHandle);
    if (!matchingKey) {
      throw new HardwareKeyError(
        'Key not registered',
        HardwareKeyError.DEVICE_INELIGIBLE
      );
    }

    // NOTE: In a production environment, you would:
    // 1. Retrieve the stored public key from D1
    // 2. Verify the signature using the public key
    // 3. Validate the authenticator data
    // 4. Check the user handle if present

    // Parse client data
    const clientDataJson = new TextDecoder().decode(response.response.clientDataJSON);
    const clientData: ClientData = JSON.parse(clientDataJson);

    // Verify origin matches
    if (clientData.origin !== this.origin) {
      throw new HardwareKeyError(
        'Origin mismatch',
        HardwareKeyError.BAD_REQUEST
      );
    }

    // Verify type is authentication
    if (clientData.type !== 'webauthn.get') {
      throw new HardwareKeyError(
        'Invalid client data type',
        HardwareKeyError.BAD_REQUEST
      );
    }

    return {
      keyHandle,
      signatureData: response.response.signature,
      clientData,
    };
  }

  /**
   * Get registered keys for a user
   */
  async getRegisteredKeys(userId: string): Promise<RegisteredKey[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM hardware_keys WHERE user_id = ?`
    ).bind(userId).all();

    return results.map(row => ({
      version: row.version as string,
      key_handle: row.key_handle as string,
      app_id: row.app_id as string,
      transports: JSON.parse(row.transports as string),
      created_at: row.created_at as number,
      user_id: row.user_id as string,
    }));
  }

  /**
   * Remove a registered key
   */
  async removeKey(keyHandle: string, userId: string): Promise<void> {
    await this.env.DB.prepare(
      `DELETE FROM hardware_keys WHERE key_handle = ? AND user_id = ?`
    ).bind(keyHandle, userId).run();

    // Also remove from R2
    await this.env.BUCKET.delete(`attestations/${keyHandle}`);
  }

  /**
   * Initialize database schema
   */
  static async initDatabase(env: Env): Promise<void> {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS hardware_keys (
        key_handle TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        version TEXT NOT NULL,
        transports TEXT,
        created_at INTEGER NOT NULL,
        INDEX idx_user_id (user_id),
        INDEX idx_app_id (app_id)
      )
    `);
  }
}

/**
 * Helper function to create a hardware key interface
 * 
 * NOTE: Unlike the original Python version, we don't scan for USB devices.
 * Instead, we rely on the browser's WebAuthn API and platform authenticators.
 */
export async function createHardwareKeyInterface(
  env: Env,
  origin?: string
): Promise<HardwareKeyInterface> {
  // Initialize database if needed
  await HardwareKeyInterface.initDatabase(env);
  
  return new HardwareKeyInterface(env, origin);
}

/**
 * Cloudflare Worker handler for hardware key operations
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const interface = await createHardwareKeyInterface(env, url.origin);

    try {
      if (url.pathname === '/register/options' && request.method === 'POST') {
        const { userId, userName, userDisplayName } = await request.json();
        const options = await interface.createRegistrationOptions(
          userId,
          userName,
          userDisplayName
        );
        return Response.json(options);
      }

      if (url.pathname === '/register/verify' && request.method === 'POST') {
        const { userId, response, challenge } = await request.json();
        const result = await interface.verifyRegistration(
          userId,
          response,
          challenge
        );
        return Response.json(result);
      }

      if (url.pathname === '/authenticate/options' && request.method === 'POST') {
        const { userId } = await request.json();
        const keys = await interface.getRegisteredKeys(userId);
        const options = await interface.createAuthenticationOptions(userId, keys);
        return Response.json(options);
      }

      if (url.pathname === '/authenticate/verify' && request.method === 'POST') {
        const { userId, response, challenge } = await request.json();
        const keys = await interface.getRegisteredKeys(userId);
        const result = await interface.verifyAuthentication(
          userId,
          response,
          challenge,
          keys
        );
        return Response.json(result);
      }

      if (url.pathname === '/keys' && request.method === 'GET') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          return new Response('Missing userId', { status: 400 });
        }
        const keys = await interface.getRegisteredKeys(userId);
        return Response.json(keys);
      }

      if (url.pathname === '/keys' && request.method === 'DELETE') {
        const { keyHandle, userId } = await request.json();
        await interface.removeKey(keyHandle, userId);
        return new Response(null, { status: 204 });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      if (error instanceof HardwareKeyError) {
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          { status: error.status, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      console.error('Hardware key error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};