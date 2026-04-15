/**
 * HTTP client for Cloudflare Workers with built-in authentication and retry logic.
 * Replaces Google-specific authentication with Cloudflare Access tokens.
 */

// NOTE: Removed Node.js dependencies (url, stream, proxy-agent, retry, abort-controller, node-fetch, form-data)
// Using Web APIs and Cloudflare Workers runtime instead

export const STANDARD_HEADERS = {
    Connection: "keep-alive",
    "User-Agent": `CloudflareWorker/1.0`,
    "X-Client-Version": `CloudflareWorker/1.0`,
} as const;

const CLOUDFLARE_QUOTA_USER_HEADER = "x-cloudflare-quota-user";
const CLOUDFLARE_USER_PROJECT_HEADER = "x-cloudflare-user-project";

// NOTE: Using Cloudflare Workers secrets/env vars instead of Google Cloud quota project
const CLOUDFLARE_QUOTA_PROJECT = ""; // Set via env var if needed

let accessToken = "";
let refreshToken = "";

/**
 * Set refresh token for token exchange (if using external OAuth)
 */
export function setRefreshToken(token = ""): void {
    refreshToken = token;
}

/**
 * Set access token directly (for testing or manual token management)
 */
export function setAccessToken(token = ""): void {
    accessToken = token;
}

/**
 * Get access token for authenticated requests
 * NOTE: Replaces Google STS with Cloudflare Access JWT verification
 * In Cloudflare Workers, authentication is typically handled via:
 * 1. Cloudflare Access JWT in request headers
 * 2. API tokens with specific permissions
 * 3. mTLS client certificates
 */
export async function getAccessToken(env?: Env): Promise<string> {
    // If we have a valid access token, use it
    if (accessToken) {
        return accessToken;
    }

    // NOTE: In Cloudflare Workers, authentication is typically handled by:
    // - Cloudflare Access: JWT in CF-Access-JWT-Assertion header
    // - API tokens: Use env variables or KV for token storage
    // - mTLS: Client certificates for mutual TLS
    
    // For external APIs, you might need to exchange tokens
    // This is a simplified version - implement based on your auth provider
    if (refreshToken) {
        // Exchange refresh token for access token
        // Replace with your OAuth provider's token endpoint
        const tokenResponse = await fetch("https://your-auth-provider.com/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: env?.CLIENT_ID || "",
                client_secret: env?.CLIENT_SECRET || "",
            }),
        });

        if (tokenResponse.ok) {
            const data = await tokenResponse.json();
            accessToken = data.access_token;
            return accessToken;
        }
    }

    // Fallback: Use Cloudflare API token from env
    // NOTE: Cloudflare API tokens are for accessing Cloudflare APIs, not general auth
    if (env?.CLOUDFLARE_API_TOKEN) {
        return env.CLOUDFLARE_API_TOKEN;
    }

    throw new Error("No valid authentication method available");
}

export interface RequestOptions {
    method?: string;
    path: string;
    headers?: HeadersInit;
    body?: any;
    queryParams?: Record<string, string | number | boolean> | URLSearchParams;
    responseType?: "json" | "text" | "stream" | "arrayBuffer" | "blob";
    resolveOnHTTPError?: boolean;
    retries?: number;
    retryMinTimeout?: number;
    retryMaxTimeout?: number;
    retryCodes?: number[];
    timeout?: number;
    skipLog?: {
        queryParams?: boolean;
        body?: boolean;
        resBody?: boolean;
    };
    ignoreQuotaProject?: boolean;
    compress?: boolean;
    redirect?: RequestRedirect;
    signal?: AbortSignal;
}

export interface Response<T = any> {
    status: number;
    response: globalThis.Response;
    body: T;
}

export interface ClientOptions {
    urlPrefix: string;
    apiVersion?: string;
    auth?: boolean;
    env?: Env;
}

// Cloudflare Workers bindings interface
export interface Env {
    // Authentication
    CLOUDFLARE_API_TOKEN?: string;
    CLIENT_ID?: string;
    CLIENT_SECRET?: string;
    
    // Storage
    DB?: D1Database;
    BUCKET?: R2Bucket;
    KV?: KVNamespace;
    
    // Other bindings
    [key: string]: any;
}

export class Client {
    private opts: ClientOptions;

    constructor(opts: ClientOptions) {
        this.opts = opts;
        
        if (this.opts.auth === undefined) {
            this.opts.auth = true;
        }
        
        if (this.opts.urlPrefix.endsWith("/")) {
            this.opts.urlPrefix = this.opts.urlPrefix.substring(0, this.opts.urlPrefix.length - 1);
        }
    }

    get(path: string, options: Omit<RequestOptions, "method" | "path"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "GET",
            path,
        };
        return this.request(reqOptions);
    }

    post(path: string, body: any, options: Omit<RequestOptions, "method" | "path" | "body"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "POST",
            path,
            body,
        };
        return this.request(reqOptions);
    }

    patch(path: string, body: any, options: Omit<RequestOptions, "method" | "path" | "body"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "PATCH",
            path,
            body,
        };
        return this.request(reqOptions);
    }

    put(path: string, body: any, options: Omit<RequestOptions, "method" | "path" | "body"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "PUT",
            path,
            body,
        };
        return this.request(reqOptions);
    }

    delete(path: string, options: Omit<RequestOptions, "method" | "path"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "DELETE",
            path,
        };
        return this.request(reqOptions);
    }

    options(path: string, options: Omit<RequestOptions, "method" | "path"> = {}): Promise<Response> {
        const reqOptions: RequestOptions = {
            ...options,
            method: "OPTIONS",
            path,
        };
        return this.request(reqOptions);
    }

    async request(reqOptions: RequestOptions): Promise<Response> {
        if (!reqOptions.responseType) {
            reqOptions.responseType = "json";
        }

        if (reqOptions.responseType === "stream" && !reqOptions.resolveOnHTTPError) {
            throw new Error("Client will not handle HTTP errors while streaming. Set `resolveOnHTTPError` and check res.status >= 400 on your own");
        }

        let internalReqOptions = {
            ...reqOptions,
            headers: new Headers(reqOptions.headers),
        };

        internalReqOptions = this.addRequestHeaders(internalReqOptions);
        
        if (this.opts.auth) {
            internalReqOptions = await this.addAuthHeader(internalReqOptions);
        }

        try {
            return await this.doRequest(internalReqOptions);
        } catch (thrown) {
            const err = thrown instanceof Error ? thrown : new Error(String(thrown));
            throw new Error(`Failed to make request: ${err.message}`);
        }
    }

    private addRequestHeaders(reqOptions: RequestOptions & { headers: Headers }): RequestOptions & { headers: Headers } {
        for (const [h, v] of Object.entries(STANDARD_HEADERS)) {
            if (!reqOptions.headers.has(h)) {
                reqOptions.headers.set(h, v);
            }
        }

        if (!reqOptions.headers.has("Content-Type")) {
            if (reqOptions.responseType === "json" && reqOptions.body) {
                reqOptions.headers.set("Content-Type", "application/json");
            }
        }

        // NOTE: Cloudflare doesn't have quota projects like Google Cloud
        // This is kept for compatibility if needed
        if (!reqOptions.ignoreQuotaProject && CLOUDFLARE_QUOTA_PROJECT) {
            reqOptions.headers.set(CLOUDFLARE_USER_PROJECT_HEADER, CLOUDFLARE_QUOTA_PROJECT);
        }

        return reqOptions;
    }

    private async addAuthHeader(reqOptions: RequestOptions & { headers: Headers }): Promise<RequestOptions & { headers: Headers }> {
        // NOTE: For local development or insecure requests, use simple auth
        if (isLocalInsecureRequest(this.opts.urlPrefix)) {
            reqOptions.headers.set("Authorization", "Bearer owner");
            return reqOptions;
        }

        const token = await getAccessToken(this.opts.env);
        reqOptions.headers.set("Authorization", `Bearer ${token}`);
        
        return reqOptions;
    }

    private requestURL(options: RequestOptions): string {
        const versionPath = this.opts.apiVersion ? `/${this.opts.apiVersion}` : "";
        return `${this.opts.urlPrefix}${versionPath}${options.path}`;
    }

    private async doRequest(options: RequestOptions & { headers: Headers }): Promise<Response> {
        if (!options.path.startsWith("/")) {
            options.path = "/" + options.path;
        }

        let fetchURL = this.requestURL(options);
        
        if (options.queryParams) {
            const searchParams = new URLSearchParams();
            
            if (options.queryParams instanceof URLSearchParams) {
                options.queryParams.forEach((value, key) => {
                    searchParams.append(key, value);
                });
            } else {
                for (const [key, value] of Object.entries(options.queryParams)) {
                    searchParams.append(key, String(value));
                }
            }
            
            const queryString = searchParams.toString();
            if (queryString) {
                fetchURL += `?${queryString}`;
            }
        }

        const fetchOptions: RequestInit = {
            headers: options.headers,
            method: options.method,
            redirect: options.redirect,
            // NOTE: Cloudflare Workers fetch doesn't support compress option
        };

        // NOTE: Cloudflare Workers handles proxies automatically via fetch()
        // No need for manual proxy configuration

        let controller: AbortController | undefined;
        let timeoutId: number | undefined;

        if (options.timeout) {
            controller = new AbortController();
            timeoutId = setTimeout(() => {
                controller!.abort();
            }, options.timeout) as unknown as number;
            fetchOptions.signal = controller.signal;
        }

        if (options.signal) {
            // Combine signals if both timeout and external signal are provided
            if (controller) {
                const combinedController = new AbortController();
                options.signal.addEventListener("abort", () => {
                    combinedController.abort();
                });
                controller.signal.addEventListener("abort", () => {
                    combinedController.abort();
                });
                fetchOptions.signal = combinedController.signal;
            } else {
                fetchOptions.signal = options.signal;
            }
        }

        if (options.body !== undefined) {
            if (typeof options.body === "string" || options.body instanceof ArrayBuffer || 
                options.body instanceof ReadableStream || options.body instanceof FormData) {
                fetchOptions.body = options.body;
            } else {
                fetchOptions.body = JSON.stringify(options.body);
            }
        }

        const maxRetries = options.retries || 2;
        const retryMinTimeout = options.retryMinTimeout || 1000;
        const retryMaxTimeout = options.retryMaxTimeout || 5000;
        const retryCodes = options.retryCodes || [];

        let lastError: Error | undefined;
        
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                if (attempt > 1) {
                    console.debug(`[Client] Retrying request. Attempt ${attempt}/${maxRetries + 1}`);
                    
                    // Exponential backoff with jitter
                    const baseDelay = Math.min(
                        retryMaxTimeout,
                        retryMinTimeout * Math.pow(2, attempt - 2)
                    );
                    const jitter = Math.random() * 0.3 * baseDelay;
                    const delay = baseDelay + jitter;
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

                this.logRequest(options);
                
                const res = await fetch(fetchURL, fetchOptions);
                
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                let body: any;
                
                switch (options.responseType) {
                    case "json":
                        try {
                            body = await res.json();
                        } catch {
                            const text = await res.text();
                            body = text || undefined;
                        }
                        break;
                    case "text":
                        body = await res.text();
                        break;
                    case "stream":
                        body = res.body;
                        break;
                    case "arrayBuffer":
                        body = await res.arrayBuffer();
                        break;
                    case "blob":
                        body = await res.blob();
                        break;
                    default:
                        throw new Error(`Unsupported responseType: ${options.responseType}`);
                }

                this.logResponse(res, body, options);

                if (res.status >= 400) {
                    // Handle 401 Unauthorized
                    if (res.status === 401 && this.opts.auth) {
                        console.debug("Got 401 Unauthorized. Refreshing access token.");
                        setAccessToken(""); // Clear invalid token
                        setAccessToken(await getAccessToken(this.opts.env));
                        
                        // Retry with new token
                        if (attempt <= maxRetries) {
                            const newOptions = { ...options };
                            newOptions.headers = new Headers(options.headers);
                            newOptions.headers.set("Authorization", `Bearer ${await getAccessToken(this.opts.env)}`);
                            continue;
                        }
                    }

                    // Check if we should retry based on status code
                    if (retryCodes.includes(res.status) && attempt <= maxRetries) {
                        lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
                        continue;
                    }

                    if (!options.resolveOnHTTPError) {
                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }
                }

                return {
                    status: res.status,
                    response: res,
                    body,
                };

            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                
                // Check if it's an abort error
                if (error instanceof DOMException && error.name === "AbortError") {
                    throw new Error(`Timeout reached making request to ${fetchURL}`);
                }

                // Retry on network errors
                if (attempt <= maxRetries) {
                    continue;
                }
                
                throw lastError;
            }
        }

        throw lastError || new Error("Request failed after all retries");
    }

    private logRequest(options: RequestOptions): void {
        let queryParamsLog = "[none]";
        if (options.queryParams) {
            queryParamsLog = "[omitted]";
            if (!options.skipLog?.queryParams) {
                if (options.queryParams instanceof URLSearchParams) {
                    queryParamsLog = options.queryParams.toString();
                } else {
                    queryParamsLog = JSON.stringify(options.queryParams);
                }
            }
        }

        const logURL = this.requestURL(options);
        console.debug(`[Client] ${options.method} ${logURL} ${queryParamsLog}`);

        if (options.headers instanceof Headers && options.headers.has(CLOUDFLARE_QUOTA_USER_HEADER)) {
            console.debug(`[Client] ${options.method} ${logURL} ${CLOUDFLARE_QUOTA_USER_HEADER}=${options.headers.get(CLOUDFLARE_QUOTA_USER_HEADER)}`);
        }

        if (options.body !== undefined) {
            let logBody = "[omitted]";
            if (!options.skipLog?.body) {
                logBody = bodyToString(options.body);
            }
            console.debug(`[Client] ${options.method} ${logURL} ${logBody}`);
        }
    }

    private logResponse(res: globalThis.Response, body: any, options: RequestOptions): void {
        const logURL = this.requestURL(options);
        console.debug(`[Client] ${options.method} ${logURL} ${res.status}`);

        let logBody = "[omitted]";
        if (!options.skipLog?.resBody) {
            logBody = bodyToString(body);
        }
        console.debug(`[Client] ${options.method} ${logURL} ${logBody}`);
    }
}

function isLocalInsecureRequest(urlPrefix: string): boolean {
    try {
        const u = new URL(urlPrefix);
        return u.protocol === "http:";
    } catch {
        return false;
    }
}

function bodyToString(body: any): string {
    if (body instanceof ReadableStream || body instanceof FormData) {
        return "[stream]";
    } else if (body instanceof ArrayBuffer || body instanceof Blob) {
        return `[${body.constructor.name}]`;
    } else {
        try {
            return JSON.stringify(body);
        } catch {
            return String(body);
        }
    }
}