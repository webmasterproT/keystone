/**
 * Cloudflare Workers mTLS Tunnel Implementation
 * 
 * Provides TLS-in-TLS tunneling capabilities for Cloudflare Workers.
 * This is a simplified implementation focused on Workers' fetch-based architecture.
 */

// NOTE: This is a conceptual port - Cloudflare Workers don't have direct socket access.
// We're implementing a TLS tunneling proxy that works over HTTP CONNECT method.
// The original Python SSLTransport is for socket-level TLS wrapping, which isn't
// directly available in Workers. Instead, we implement a TLS-over-HTTP tunnel.

export interface TunnelOptions {
  /** Target hostname for the TLS connection */
  serverHostname: string;
  /** TLS ALPN protocols to negotiate */
  alpnProtocols?: string[];
  /** Whether to suppress ragged EOFs (default: true) */
  suppressRaggedEofs?: boolean;
  /** Optional client certificate for mTLS */
  clientCertificate?: ArrayBuffer;
  /** Optional client private key for mTLS */
  clientPrivateKey?: CryptoKey;
}

export class TunnelError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export class SSLTransport {
  private socket: WebSocket | null = null;
  private sslContext: SSLContext;
  private options: Required<TunnelOptions>;
  private incomingBuffer: Uint8Array[] = [];
  private outgoingBuffer: Uint8Array[] = [];
  private isClosed = false;
  private handshakeComplete = false;

  constructor(
    socket: WebSocket,
    sslContext: SSLContext,
    options: TunnelOptions
  ) {
    this.socket = socket;
    this.sslContext = sslContext;
    this.options = {
      suppressRaggedEofs: true,
      alpnProtocols: [],
      ...options
    };

    // Set up WebSocket event handlers
    socket.addEventListener('message', this.handleMessage.bind(this));
    socket.addEventListener('close', this.handleClose.bind(this));
    socket.addEventListener('error', this.handleError.bind(this));
  }

  /**
   * Validate SSL context for TLS-in-TLS support
   */
  static validateSSLContext(sslContext: SSLContext): void {
    if (!sslContext.wrap) {
      throw new TunnelError(
        'TLS in TLS requires SSLContext.wrap() method',
        'UNSUPPORTED_CONTEXT'
      );
    }
  }

  /**
   * Perform TLS handshake
   */
  async handshake(): Promise<void> {
    if (this.handshakeComplete) {
      return;
    }

    try {
      // Perform TLS handshake through the WebSocket tunnel
      await this.performTLSHandshake();
      this.handshakeComplete = true;
    } catch (error) {
      throw new TunnelError(
        'TLS handshake failed',
        'HANDSHAKE_FAILED',
        error
      );
    }
  }

  /**
   * Read data from the TLS tunnel
   */
  async read(length: number = 1024): Promise<Uint8Array> {
    if (this.isClosed) {
      throw new TunnelError('Tunnel is closed', 'CLOSED');
    }

    // Wait for data if buffer is empty
    while (this.incomingBuffer.length === 0 && !this.isClosed) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    if (this.isClosed) {
      return new Uint8Array(0);
    }

    // Concatenate buffered data
    const totalLength = this.incomingBuffer.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(Math.min(length, totalLength));
    
    let offset = 0;
    while (offset < result.length && this.incomingBuffer.length > 0) {
      const chunk = this.incomingBuffer[0];
      const toCopy = Math.min(chunk.length, result.length - offset);
      
      result.set(chunk.subarray(0, toCopy), offset);
      offset += toCopy;
      
      if (toCopy === chunk.length) {
        this.incomingBuffer.shift();
      } else {
        this.incomingBuffer[0] = chunk.subarray(toCopy);
      }
    }

    return result;
  }

  /**
   * Write data to the TLS tunnel
   */
  async write(data: Uint8Array): Promise<number> {
    if (this.isClosed) {
      throw new TunnelError('Tunnel is closed', 'CLOSED');
    }

    if (!this.handshakeComplete) {
      await this.handshake();
    }

    try {
      // Encrypt and send data through WebSocket
      const encrypted = await this.sslContext.encrypt(data);
      await this.sendThroughWebSocket(encrypted);
      return data.length;
    } catch (error) {
      throw new TunnelError(
        'Failed to write data',
        'WRITE_FAILED',
        error
      );
    }
  }

  /**
   * Close the TLS tunnel
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    
    try {
      // Send TLS close_notify if possible
      await this.sslContext.close();
    } catch (error) {
      // Ignore errors during cleanup
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, 'Normal closure');
    }
    
    this.socket = null;
  }

  /**
   * Get peer certificate (simplified for Workers)
   */
  async getPeerCertificate(): Promise<Record<string, any> | null> {
    // NOTE: In Workers, we don't have direct access to peer certificates
    // This would need to be implemented via a custom API or external service
    return null;
  }

  /**
   * Get negotiated cipher suite
   */
  async getCipher(): Promise<{ name: string; version: string } | null> {
    return this.sslContext.getCipher();
  }

  /**
   * Get negotiated ALPN protocol
   */
  async getSelectedAlpnProtocol(): Promise<string | null> {
    return this.sslContext.getSelectedAlpnProtocol();
  }

  private async performTLSHandshake(): Promise<void> {
    // Perform TLS handshake through the WebSocket
    const handshakeData = await this.sslContext.handshake(this.options.serverHostname);
    
    if (handshakeData) {
      await this.sendThroughWebSocket(handshakeData);
    }

    // Wait for handshake completion
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (this.handshakeComplete) {
          clearInterval(checkInterval);
          resolve();
        }
        if (this.isClosed) {
          clearInterval(checkInterval);
          reject(new TunnelError('Connection closed during handshake'));
        }
      }, 10);
    });
  }

  private async sendThroughWebSocket(data: Uint8Array): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new TunnelError('WebSocket is not open', 'WS_CLOSED');
    }
    
    this.socket.send(data);
  }

  private handleMessage(event: MessageEvent): void {
    if (this.isClosed) {
      return;
    }

    const data = event.data;
    let buffer: Uint8Array;

    if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      buffer = data;
    } else if (typeof data === 'string') {
      buffer = new TextEncoder().encode(data);
    } else {
      console.warn('Unknown message type received in tunnel');
      return;
    }

    // Process TLS data
    this.processIncomingTLSData(buffer);
  }

  private async processIncomingTLSData(data: Uint8Array): Promise<void> {
    try {
      // Decrypt TLS data
      const decrypted = await this.sslContext.decrypt(data);
      
      if (decrypted.length > 0) {
        this.incomingBuffer.push(decrypted);
      }
    } catch (error) {
      if (this.options.suppressRaggedEofs && 
          error instanceof Error && 
          error.message.includes('EOF')) {
        // Suppress ragged EOF as requested
        return;
      }
      
      console.error('Failed to process TLS data:', error);
      await this.close();
    }
  }

  private handleClose(): void {
    this.isClosed = true;
    this.socket = null;
  }

  private handleError(event: Event): void {
    console.error('WebSocket error in tunnel:', event);
    this.close().catch(() => {});
  }
}

/**
 * Simplified SSL Context for Workers
 * NOTE: This is a conceptual interface - actual TLS implementation would
 * require either a WebAssembly crypto library or external service
 */
export interface SSLContext {
  wrap(data: Uint8Array): Promise<Uint8Array>;
  unwrap(data: Uint8Array): Promise<Uint8Array>;
  encrypt(data: Uint8Array): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<Uint8Array>;
  handshake(serverName: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
  getCipher(): Promise<{ name: string; version: string } | null>;
  getSelectedAlpnProtocol(): Promise<string | null>;
}

/**
 * Create a TLS tunnel through Cloudflare Workers
 * This establishes a WebSocket connection that tunnels TLS traffic
 */
export async function createTunnel(
  targetUrl: string,
  options: TunnelOptions,
  env?: Env
): Promise<SSLTransport> {
  // NOTE: Cloudflare Workers can establish WebSocket connections to upstream
  // This creates a WebSocket tunnel to the target server
  
  const wsUrl = targetUrl.replace(/^http/, 'ws');
  const ws = new WebSocket(wsUrl);
  
  // Create a simple SSL context (conceptual - would need actual implementation)
  const sslContext: SSLContext = {
    async wrap(data) { return data; },
    async unwrap(data) { return data; },
    async encrypt(data) { return data; },
    async decrypt(data) { return data; },
    async handshake() { return null; },
    async close() {},
    async getCipher() { return null; },
    async getSelectedAlpnProtocol() { return null; }
  };
  
  const transport = new SSLTransport(ws, sslContext, options);
  
  // Wait for WebSocket to open
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (event) => reject(new TunnelError('WebSocket connection failed', 'WS_ERROR', event)));
  });
  
  return transport;
}

/**
 * Worker binding types for mTLS tunnel
 */
export interface Env {
  /** Optional D1 database for certificate storage */
  MTLS_DB?: D1Database;
  /** Optional KV for session state */
  MTLS_KV?: KVNamespace;
  /** Optional R2 for certificate storage */
  MTLS_CERTS?: R2Bucket;
  /** API token for external TLS services */
  TLS_SERVICE_TOKEN?: string;
}

/**
 * Utility to handle TLS-in-TLS for HTTP CONNECT proxies
 */
export class HTTPTunnel {
  constructor(private env?: Env) {}

  /**
   * Handle HTTP CONNECT request and establish TLS tunnel
   */
  async handleConnect(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = request.headers.get('X-Target-Host') || url.searchParams.get('host');
    
    if (!target) {
      return new Response('Missing target host', { status: 400 });
    }

    // Extract client certificate from request
    const clientCert = await this.extractClientCertificate(request);
    
    // Create WebSocket pair for tunneling
    const { 0: client, 1: server } = new WebSocketPair();
    
    // Set up server WebSocket to connect to target
    server.accept();
    
    const options: TunnelOptions = {
      serverHostname: target,
      clientCertificate: clientCert,
      suppressRaggedEofs: true
    };

    try {
      const transport = new SSLTransport(server, await this.createSSLContext(), options);
      await transport.handshake();
      
      // Return WebSocket response
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    } catch (error) {
      return new Response(`Tunnel setup failed: ${error}`, { status: 502 });
    }
  }

  private async extractClientCertificate(request: Request): Promise<ArrayBuffer | undefined> {
    // NOTE: Cloudflare Workers can access client certificates via request.cf
    // but only in Enterprise plans with mTLS enabled
    const cf = (request as any).cf as { clientCert?: { cert: string } } | undefined;
    
    if (cf?.clientCert?.cert) {
      return new TextEncoder().encode(cf.clientCert.cert);
    }
    
    return undefined;
  }

  private async createSSLContext(): Promise<SSLContext> {
    // NOTE: This is a stub - actual implementation would require
    // a WebAssembly TLS library or external TLS service
    return {
      async wrap(data) { return data; },
      async unwrap(data) { return data; },
      async encrypt(data) { return data; },
      async decrypt(data) { return data; },
      async handshake() { return null; },
      async close() {},
      async getCipher() { return null; },
      async getSelectedAlpnProtocol() { return null; }
    };
  }
}