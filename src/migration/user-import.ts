/**
 * Cloudflare Workers user import utility
 * Ported from Google Cloud authentication patterns
 */

// NOTE: This is a simplified port focusing on user validation and import logic.
// Cloudflare Workers don't have direct Firebase Auth equivalents, so we're
// adapting the validation logic for a generic user import system.

export interface User {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  salt?: string;
  displayName?: string;
  photoUrl?: string;
  createdAt?: string;
  lastLoginAt?: string;
  phoneNumber?: string;
  providerUserInfo?: ProviderUserInfo[];
  disabled?: boolean;
  customAttributes?: string;
}

export interface ProviderUserInfo {
  providerId: string;
  rawId?: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
}

export interface HashOptions {
  hashAlgo?: string;
  hashKey?: string;
  saltSeparator?: string;
  rounds?: number;
  memCost?: number;
  cpuMemCost?: number;
  parallelization?: number;
  blockSize?: number;
  dkLen?: number;
  passwordHashOrder?: string;
  valid: boolean;
}

export interface ImportOptions {
  hashAlgo?: string;
  hashKey?: string;
  saltSeparator?: string;
  rounds?: string;
  memCost?: string;
  parallelization?: string;
  blockSize?: string;
  dkLen?: string;
  hashInputOrder?: string;
}

export interface ValidationResult {
  error?: string;
}

export interface ImportResult {
  success: boolean;
  importedCount: number;
  errors?: Array<{
    account: string;
    reason: string;
  }>;
}

const ALLOWED_JSON_KEYS = [
  "localId",
  "email",
  "emailVerified",
  "passwordHash",
  "salt",
  "displayName",
  "photoUrl",
  "createdAt",
  "lastSignedInAt",
  "providerUserInfo",
  "phoneNumber",
  "disabled",
  "customAttributes",
];

const ALLOWED_JSON_KEYS_RENAMING: Record<string, string> = {
  lastSignedInAt: "lastLoginAt",
};

const ALLOWED_PROVIDER_USER_INFO_KEYS = ["providerId", "rawId", "email", "displayName", "photoUrl"];
const ALLOWED_PROVIDER_IDS = ["google.com", "facebook.com", "twitter.com", "github.com"];

/**
 * Validates if a string is valid base64
 * Uses Web Crypto API compatible validation
 */
function isValidBase64(str: string): boolean {
  try {
    // Web-safe base64 validation
    const normalized = str.replace(/_/g, '/').replace(/-/g, '+');
    const decoded = atob(normalized);
    const reencoded = btoa(decoded);
    const webSafeReencoded = reencoded.replace(/\//g, '_').replace(/\+/g, '-');
    
    // Pad the input if needed for comparison
    let paddedStr = str;
    while (paddedStr.length % 4 !== 0) {
      paddedStr += '=';
    }
    
    return paddedStr === webSafeReencoded;
  } catch {
    return false;
  }
}

/**
 * Converts base64 to web-safe base64
 */
function toWebSafeBase64(data: string): string {
  return data.replace(/\//g, '_').replace(/\+/g, '-');
}

/**
 * Adds provider user info to a user object
 */
function addProviderUserInfo(user: User, providerId: string, arr: (string | undefined)[]): void {
  if (arr[0]) {
    if (!user.providerUserInfo) {
      user.providerUserInfo = [];
    }
    user.providerUserInfo.push({
      providerId: providerId,
      rawId: arr[0],
      email: arr[1],
      displayName: arr[2],
      photoUrl: arr[3],
    });
  }
}

/**
 * Transforms array data to User object
 * Array format matches Google's CSV import format
 */
export function transArrayToUser(arr: string[]): User | ValidationResult {
  const user: User = {
    localId: arr[0],
    email: arr[1],
    emailVerified: arr[2] === "true",
    passwordHash: arr[3],
    salt: arr[4],
    displayName: arr[5],
    photoUrl: arr[6],
    createdAt: arr[23],
    lastLoginAt: arr[24],
    phoneNumber: arr[25],
    providerUserInfo: [],
    disabled: arr[26] === "true",
    customAttributes: arr[27],
  };

  addProviderUserInfo(user, "google.com", arr.slice(7, 11));
  addProviderUserInfo(user, "facebook.com", arr.slice(11, 15));
  addProviderUserInfo(user, "twitter.com", arr.slice(15, 19));
  addProviderUserInfo(user, "github.com", arr.slice(19, 23));

  if (user.passwordHash && !isValidBase64(user.passwordHash)) {
    return {
      error: "Password hash should be base64 encoded.",
    };
  }

  if (user.salt && !isValidBase64(user.salt)) {
    return {
      error: "Password salt should be base64 encoded.",
    };
  }

  return user;
}

/**
 * Validates import options and returns hash options
 */
export function validateOptions(options: ImportOptions): HashOptions {
  const hashOptions = validateRequiredParameters(options);
  
  if (!hashOptions.valid) {
    return hashOptions;
  }

  const hashInputOrder = options.hashInputOrder ? options.hashInputOrder.toUpperCase() : undefined;
  
  if (hashInputOrder) {
    if (hashInputOrder !== "SALT_FIRST" && hashInputOrder !== "PASSWORD_FIRST") {
      throw new Error("Unknown password hash order flag");
    } else {
      hashOptions.passwordHashOrder =
        hashInputOrder === "SALT_FIRST" ? "SALT_AND_PASSWORD" : "PASSWORD_AND_SALT";
    }
  }

  return hashOptions;
}

/**
 * Validates required hash algorithm parameters
 */
function validateRequiredParameters(options: ImportOptions): HashOptions {
  if (!options.hashAlgo) {
    console.warn("No hash algorithm specified. Password users cannot be imported.");
    return { valid: true };
  }

  const hashAlgo = options.hashAlgo.toUpperCase();
  let roundsNum: number;

  switch (hashAlgo) {
    case "HMAC_SHA512":
    case "HMAC_SHA256":
    case "HMAC_SHA1":
    case "HMAC_MD5":
      if (!options.hashKey || options.hashKey === "") {
        throw new Error(`Must provide hash key(base64 encoded) for hash algorithm ${options.hashAlgo}`);
      }
      return { hashAlgo: hashAlgo, hashKey: options.hashKey, valid: true };

    case "MD5":
    case "SHA1":
    case "SHA256":
    case "SHA512":
      roundsNum = parseInt(options.rounds || "0", 10);
      const minRounds = hashAlgo === "MD5" ? 0 : 1;
      if (isNaN(roundsNum) || roundsNum < minRounds || roundsNum > 8192) {
        throw new Error(`Must provide valid rounds(${minRounds}..8192) for hash algorithm ${options.hashAlgo}`);
      }
      return { hashAlgo: hashAlgo, rounds: roundsNum, valid: true };

    case "PBKDF_SHA1":
    case "PBKDF2_SHA256":
      roundsNum = parseInt(options.rounds || "0", 10);
      if (isNaN(roundsNum) || roundsNum < 0 || roundsNum > 120000) {
        throw new Error(`Must provide valid rounds(0..120000) for hash algorithm ${options.hashAlgo}`);
      }
      return { hashAlgo: hashAlgo, rounds: roundsNum, valid: true };

    case "SCRYPT":
      if (!options.hashKey || options.hashKey === "") {
        throw new Error(`Must provide hash key(base64 encoded) for hash algorithm ${options.hashAlgo}`);
      }
      roundsNum = parseInt(options.rounds || "0", 10);
      if (isNaN(roundsNum) || roundsNum <= 0 || roundsNum > 8) {
        throw new Error(`Must provide valid rounds(1..8) for hash algorithm ${options.hashAlgo}`);
      }
      const memCost = parseInt(options.memCost || "0", 10);
      if (isNaN(memCost) || memCost <= 0 || memCost > 14) {
        throw new Error(`Must provide valid memory cost(1..14) for hash algorithm ${options.hashAlgo}`);
      }
      let saltSeparator = "";
      if (options.saltSeparator) {
        saltSeparator = options.saltSeparator;
      }
      return {
        hashAlgo: hashAlgo,
        hashKey: options.hashKey,
        saltSeparator: saltSeparator,
        rounds: roundsNum,
        memCost: memCost,
        valid: true,
      };

    case "BCRYPT":
      return { hashAlgo: hashAlgo, valid: true };

    case "STANDARD_SCRYPT":
      const cpuMemCost = parseInt(options.memCost || "0", 10);
      const parallelization = parseInt(options.parallelization || "0", 10);
      const blockSize = parseInt(options.blockSize || "0", 10);
      const dkLen = parseInt(options.dkLen || "0", 10);
      return {
        hashAlgo: hashAlgo,
        valid: true,
        cpuMemCost: cpuMemCost,
        parallelization: parallelization,
        blockSize: blockSize,
        dkLen: dkLen,
      };

    default:
      throw new Error(`Unsupported hash algorithm ${options.hashAlgo}`);
  }
}

/**
 * Validates provider user info
 */
function validateProviderUserInfo(providerUserInfo: ProviderUserInfo): ValidationResult {
  if (!ALLOWED_PROVIDER_IDS.includes(providerUserInfo.providerId)) {
    return {
      error: JSON.stringify(providerUserInfo, null, 2) + " has unsupported providerId",
    };
  }

  const keydiff = Object.keys(providerUserInfo).filter((k) => !ALLOWED_PROVIDER_USER_INFO_KEYS.includes(k));
  if (keydiff.length) {
    return {
      error: JSON.stringify(providerUserInfo, null, 2) + " has unsupported keys: " + keydiff.join(","),
    };
  }

  return {};
}

/**
 * Validates user JSON structure
 */
export function validateUserJson(userJson: any): ValidationResult {
  const keydiff = Object.keys(userJson).filter((k) => !ALLOWED_JSON_KEYS.includes(k));
  
  if (keydiff.length) {
    return {
      error: JSON.stringify(userJson, null, 2) + " has unsupported keys: " + keydiff.join(","),
    };
  }

  if (userJson.providerUserInfo) {
    for (let i = 0; i < userJson.providerUserInfo.length; i++) {
      const res = validateProviderUserInfo(userJson.providerUserInfo[i]);
      if (res.error) {
        return res;
      }
    }
  }

  const badFormat = JSON.stringify(userJson, null, 2) + " has invalid data format: ";
  
  if (userJson.passwordHash && !isValidBase64(userJson.passwordHash)) {
    return {
      error: badFormat + "Password hash should be base64 encoded.",
    };
  }

  if (userJson.salt && !isValidBase64(userJson.salt)) {
    return {
      error: badFormat + "Password salt should be base64 encoded.",
    };
  }

  return {};
}

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
  // NOTE: Using D1 for user storage instead of Firebase Auth
  DB: D1Database;
  
  // NOTE: Using R2 for storing import logs and backup data
  IMPORT_BUCKET: R2Bucket;
  
  // NOTE: Using KV for caching user data and import status
  USER_CACHE: KVNamespace;
  
  // NOTE: Cloudflare Access JWT for authentication
  // JWT verification would be handled by Cloudflare Access
}

/**
 * Prepares user data for storage
 * NOTE: This replaces Google's uploadAccount API with D1 database operations
 */
function prepareUserForStorage(user: User, hashOptions: HashOptions): any {
  const preparedUser = { ...user };

  if (preparedUser.passwordHash) {
    preparedUser.passwordHash = toWebSafeBase64(preparedUser.passwordHash);
  }

  if (preparedUser.salt) {
    preparedUser.salt = toWebSafeBase64(preparedUser.salt);
  }

  for (const [key, value] of Object.entries(ALLOWED_JSON_KEYS_RENAMING)) {
    if ((preparedUser as any)[key]) {
      (preparedUser as any)[value] = (preparedUser as any)[key];
      delete (preparedUser as any)[key];
    }
  }

  return preparedUser;
}

/**
 * Stores users in D1 database
 * NOTE: Replaces Google's Firebase Auth import with D1 SQL operations
 */
async function storeUsersInD1(env: Env, users: User[]): Promise<ImportResult> {
  const errors: Array<{ account: string; reason: string }> = [];
  let successCount = 0;

  for (const user of users) {
    try {
      // Insert or update user in D1
      await env.DB.prepare(`
        INSERT OR REPLACE INTO users (
          localId, email, emailVerified, passwordHash, salt,
          displayName, photoUrl, createdAt, lastLoginAt,
          phoneNumber, disabled, customAttributes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        user.localId,
        user.email || null,
        user.emailVerified ? 1 : 0,
        user.passwordHash || null,
        user.salt || null,
        user.displayName || null,
        user.photoUrl || null,
        user.createdAt || null,
        user.lastLoginAt || null,
        user.phoneNumber || null,
        user.disabled ? 1 : 0,
        user.customAttributes || null
      ).run();

      // Store provider info if present
      if (user.providerUserInfo && user.providerUserInfo.length > 0) {
        for (const provider of user.providerUserInfo) {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO user_providers (
              userId, providerId, rawId, email, displayName, photoUrl
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            user.localId,
            provider.providerId,
            provider.rawId || null,
            provider.email || null,
            provider.displayName || null,
            provider.photoUrl || null
          ).run();
        }
      }

      successCount++;
    } catch (error) {
      errors.push({
        account: JSON.stringify(user, null, 2),
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return {
    success: errors.length === 0,
    importedCount: successCount,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Main import function for Cloudflare Workers
 * NOTE: Replaces Google's serial import with parallel D1 operations
 */
export async function importUsers(
  env: Env,
  users: User[],
  hashOptions: HashOptions
): Promise<ImportResult> {
  console.info(`Starting import of ${users.length} account(s).`);

  // Validate all users first
  const validationErrors: ValidationResult[] = [];
  const validUsers: User[] = [];

  for (const user of users) {
    const validation = validateUserJson(user);
    if (validation.error) {
      validationErrors.push(validation);
    } else {
      validUsers.push(user);
    }
  }

  if (validationErrors.length > 0) {
    console.info("Encountered validation errors:");
    validationErrors.forEach(error => console.info(error.error));
  }

  if (validUsers.length === 0) {
    return {
      success: false,
      importedCount: 0,
      errors: validationErrors.map(err => ({
        account: "Validation failed",
        reason: err.error || "Unknown validation error",
      })),
    };
  }

  // Prepare users for storage
  const preparedUsers = validUsers.map(user => prepareUserForStorage(user, hashOptions));

  // Store in D1
  const result = await storeUsersInD1(env, preparedUsers);

  if (result.success) {
    console.info("Imported successfully.");
    
    // Store import log in R2 for audit trail
    const timestamp = new Date().toISOString();
    const logKey = `import-logs/${timestamp}.json`;
    
    await env.IMPORT_BUCKET.put(logKey, JSON.stringify({
      timestamp,
      importedCount: result.importedCount,
      totalUsers: users.length,
      validationErrors: validationErrors.length,
    }));
  } else if (result.errors) {
    console.info("Encountered problems while importing accounts. Details:");
    result.errors.forEach(error => {
      console.info(`Account: ${error.account}`);
      console.info(`Reason: ${error.reason}`);
    });
  }

  return result;
}

/**
 * Serial import for compatibility with original API
 * NOTE: Maintains serial execution pattern but uses D1 instead of Firebase
 */
export async function serialImportUsers(
  env: Env,
  hashOptions: HashOptions,
  userBatches: User[][],
  batchIndex: number = 0
): Promise<void> {
  if (batchIndex >= userBatches.length) {
    return;
  }

  const result = await importUsers(env, userBatches[batchIndex], hashOptions);
  
  if (batchIndex < userBatches.length - 1) {
    await serialImportUsers(env, hashOptions, userBatches, batchIndex + 1);
  }
}

/**
 * Worker handler for HTTP import requests
 * NOTE: This would be the main entry point for a Cloudflare Worker
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // NOTE: Authentication would be handled by Cloudflare Access
    // The request should include a valid JWT in the CF-Access-JWT-Assertion header
    
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      
      if (contentType.includes("application/json")) {
        const body = await request.json() as {
          users: User[];
          options?: ImportOptions;
        };
        
        const hashOptions = body.options ? validateOptions(body.options) : { valid: true };
        const result = await importUsers(env, body.users, hashOptions);
        
        return Response.json(result);
      } else if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
        // Handle CSV import
        const text = await request.text();
        const lines = text.split('\n').filter(line => line.trim());
        const users: User[] = [];
        
        for (const line of lines) {
          const arr = line.split(',').map(field => field.trim());
          const userResult = transArrayToUser(arr);
          
          if ('error' in userResult) {
            return Response.json({
              success: false,
              importedCount: 0,
              errors: [{
                account: line,
                reason: userResult.error,
              }],
            }, { status: 400 });
          }
          
          users.push(userResult);
        }
        
        const result = await importUsers(env, users, { valid: true });
        return Response.json(result);
      } else {
        return new Response("Unsupported content type", { status: 415 });
      }
    } catch (error) {
      return Response.json({
        success: false,
        importedCount: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      }, { status: 500 });
    }
  },
};