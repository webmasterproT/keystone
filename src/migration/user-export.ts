/**
 * Cloudflare Workers user export utility
 * Ported from Google Cloud Identity Platform export pattern
 * 
 * Exports user data from Cloudflare Access/Auth to R2 storage
 */

export interface UserExportOptions {
  /** Export format: 'csv' or 'json' */
  format: 'csv' | 'json';
  /** Batch size for pagination */
  batchSize?: number;
  /** Next page token for continuation */
  nextPageToken?: string;
  /** Target R2 bucket for export */
  bucket: R2Bucket;
  /** File path in R2 bucket */
  filePath: string;
  /** Timeout retry count */
  timeoutRetryCount?: number;
}

export interface UserRecord {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  salt?: string;
  displayName?: string;
  photoUrl?: string;
  lastLoginAt?: string;
  createdAt?: string;
  phoneNumber?: string;
  disabled?: boolean;
  customAttributes?: string;
  providerUserInfo?: ProviderUserInfo[];
  version?: number;
}

export interface ProviderUserInfo {
  providerId: string;
  rawId: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
}

export interface ExportResult {
  success: boolean;
  exportedCount: number;
  nextPageToken?: string;
  fileUrl?: string;
  error?: string;
}

// NOTE: Replaced Google-specific provider IDs with generic OAuth providers
const PROVIDER_ID_INDEX_MAP = new Map([
  ["oauth.google", 7],
  ["oauth.facebook", 11],
  ["oauth.twitter", 15],
  ["oauth.github", 19],
]);

const EXPORTED_JSON_KEYS = [
  "localId",
  "email",
  "emailVerified",
  "passwordHash",
  "salt",
  "displayName",
  "photoUrl",
  "lastLoginAt",
  "createdAt",
  "phoneNumber",
  "disabled",
  "customAttributes",
];

const EXPORTED_JSON_KEYS_RENAMING: Record<string, string> = {
  lastLoginAt: "lastSignedInAt",
};

const EXPORTED_PROVIDER_USER_INFO_KEYS = [
  "providerId",
  "rawId",
  "email",
  "displayName",
  "photoUrl",
];

/**
 * Validate export options
 */
export function validateOptions(options: Partial<UserExportOptions>, fileName: string): UserExportOptions {
  const exportOptions: UserExportOptions = {
    format: 'json',
    bucket: options.bucket!,
    filePath: fileName,
    batchSize: options.batchSize || 1000,
  };

  if (!fileName) {
    throw new Error("Must specify data file name");
  }

  const extName = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  if (extName === ".csv") {
    exportOptions.format = "csv";
  } else if (extName === ".json") {
    exportOptions.format = "json";
  } else if (options.format) {
    const format = options.format.toLowerCase();
    if (format === "csv" || format === "json") {
      exportOptions.format = format;
    } else {
      throw new Error("Unsupported data file format, should be csv or json");
    }
  } else {
    throw new Error("Please specify data file format in file name, or use `format` parameter");
  }

  if (!options.bucket) {
    throw new Error("Must specify R2 bucket binding");
  }

  return exportOptions;
}

/**
 * Escape commas for CSV formatting
 */
function escapeComma(str: string): string {
  if (str.includes(",")) {
    return `"${str}"`;
  }
  return str;
}

/**
 * Convert base64 URL safe to normal base64
 */
function convertToNormalBase64(data: string): string {
  return data.replace(/_/g, "/").replace(/-/g, "+");
}

/**
 * Add provider user info to array
 */
function addProviderUserInfo(providerInfo: ProviderUserInfo, arr: string[], startPos: number): void {
  arr[startPos] = providerInfo.rawId;
  arr[startPos + 1] = providerInfo.email || "";
  arr[startPos + 2] = escapeComma(providerInfo.displayName || "");
  arr[startPos + 3] = providerInfo.photoUrl || "";
}

/**
 * Convert user to CSV array
 */
function transUserToArray(user: UserRecord): string[] {
  const arr = Array(28).fill("");
  arr[0] = user.localId;
  arr[1] = user.email || "";
  arr[2] = String(user.emailVerified || false);
  arr[3] = user.passwordHash ? convertToNormalBase64(user.passwordHash) : "";
  arr[4] = user.salt ? convertToNormalBase64(user.salt) : "";
  arr[5] = escapeComma(user.displayName || "");
  arr[6] = user.photoUrl || "";

  if (user.providerUserInfo) {
    for (const providerInfo of user.providerUserInfo) {
      const providerIndex = PROVIDER_ID_INDEX_MAP.get(providerInfo.providerId);
      if (providerIndex) {
        addProviderUserInfo(providerInfo, arr, providerIndex);
      }
    }
  }

  arr[23] = user.createdAt || "";
  arr[24] = user.lastLoginAt || "";
  arr[25] = user.phoneNumber || "";
  arr[26] = String(user.disabled || false);
  arr[27] = user.customAttributes
    ? `"${(user.customAttributes || "").replace(/(?<!\\)"/g, '""')}"`
    : "";

  return arr;
}

/**
 * Convert user to JSON object
 */
function transUserJson(user: UserRecord): Record<string, any> {
  const newUser: Record<string, any> = {};
  const pickedUser: Record<string, any> = {};

  for (const k of EXPORTED_JSON_KEYS) {
    if (user[k as keyof UserRecord] !== undefined) {
      pickedUser[k] = user[k as keyof UserRecord];
    }
  }

  for (const [key, value] of Object.entries(pickedUser)) {
    const newKey = EXPORTED_JSON_KEYS_RENAMING[key] || key;
    newUser[newKey] = value;
  }

  if (newUser.passwordHash) {
    newUser.passwordHash = convertToNormalBase64(newUser.passwordHash);
  }
  if (newUser.salt) {
    newUser.salt = convertToNormalBase64(newUser.salt);
  }

  if (user.providerUserInfo) {
    newUser.providerUserInfo = [];
    for (const providerInfo of user.providerUserInfo) {
      if (PROVIDER_ID_INDEX_MAP.has(providerInfo.providerId)) {
        const picked: Record<string, any> = {};
        for (const k of EXPORTED_PROVIDER_USER_INFO_KEYS) {
          if (providerInfo[k as keyof ProviderUserInfo] !== undefined) {
            picked[k] = providerInfo[k as keyof ProviderUserInfo];
          }
        }
        newUser.providerUserInfo.push(picked);
      }
    }
  }

  return newUser;
}

/**
 * Create a function to write users to R2
 */
function createWriteUsersToR2(bucket: R2Bucket, filePath: string, format: 'csv' | 'json'): {
  write: (userList: UserRecord[]) => Promise<void>;
  finalize: () => Promise<string>;
} {
  let buffer: string[] = [];
  let isFirstJson = true;

  return {
    write: async (userList: UserRecord[]) => {
      for (const user of userList) {
        // NOTE: In Cloudflare Workers, we don't store password hashes by default
        // Remove sensitive data if not version 0
        const processedUser = { ...user };
        if (processedUser.passwordHash && processedUser.version !== 0) {
          delete processedUser.passwordHash;
          delete processedUser.salt;
        }

        if (format === "csv") {
          buffer.push(transUserToArray(processedUser).join(","));
        } else {
          const jsonStr = JSON.stringify(transUserJson(processedUser), null, 2);
          if (isFirstJson) {
            buffer.push(jsonStr);
            isFirstJson = false;
          } else {
            buffer.push("," + jsonStr);
          }
        }
      }
    },
    finalize: async (): Promise<string> => {
      let content = "";
      if (format === "csv") {
        // Add CSV header
        const headers = [
          "localId", "email", "emailVerified", "passwordHash", "salt",
          "displayName", "photoUrl", "googleId", "googleEmail", "googleDisplayName",
          "googlePhotoUrl", "facebookId", "facebookEmail", "facebookDisplayName",
          "facebookPhotoUrl", "twitterId", "twitterEmail", "twitterDisplayName",
          "twitterPhotoUrl", "githubId", "githubEmail", "githubDisplayName",
          "githubPhotoUrl", "createdAt", "lastSignedInAt", "phoneNumber",
          "disabled", "customAttributes"
        ];
        content = headers.join(",") + "\n" + buffer.join("\n");
      } else {
        content = "[" + buffer.join("") + "]";
      }

      // Upload to R2
      await bucket.put(filePath, content, {
        httpMetadata: {
          contentType: format === "csv" ? "text/csv" : "application/json",
        },
      });

      return filePath;
    }
  };
}

/**
 * Serial export users with pagination
 * NOTE: Replaced Google Identity Toolkit API with Cloudflare Access/Auth pattern
 * In production, you would integrate with your actual user store (D1, KV, or external auth provider)
 */
export async function serialExportUsers(
  env: Env,
  options: UserExportOptions
): Promise<ExportResult> {
  const writer = createWriteUsersToR2(options.bucket, options.filePath, options.format);
  const timeoutRetryCount = options.timeoutRetryCount || 0;

  try {
    // NOTE: This is a placeholder for actual user data fetching
    // In production, you would:
    // 1. Query D1 database for users
    // 2. Or call Cloudflare Access API
    // 3. Or integrate with external auth provider
    
    // Simulated user data fetch with pagination
    const mockUsers: UserRecord[] = [
      {
        localId: "user1",
        email: "user1@example.com",
        emailVerified: true,
        displayName: "User One",
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        disabled: false,
        providerUserInfo: [
          {
            providerId: "oauth.google",
            rawId: "google123",
            email: "user1@gmail.com",
            displayName: "Google User",
          }
        ]
      }
    ];

    if (mockUsers.length > 0) {
      await writer.write(mockUsers);
      
      // NOTE: In production, implement actual pagination with nextPageToken
      const nextPageToken = undefined; // Set if more pages exist
      
      if (!nextPageToken) {
        const fileUrl = await writer.finalize();
        return {
          success: true,
          exportedCount: mockUsers.length,
          fileUrl: fileUrl,
        };
      } else {
        // Continue with next page
        options.nextPageToken = nextPageToken;
        return serialExportUsers(env, options);
      }
    }

    return {
      success: true,
      exportedCount: 0,
    };
  } catch (err) {
    // NOTE: Simplified error handling for Cloudflare Workers
    if (timeoutRetryCount < 5) {
      options.timeoutRetryCount = (options.timeoutRetryCount || 0) + 1;
      return serialExportUsers(env, options);
    }
    
    return {
      success: false,
      exportedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Main Worker handler for user export
 */
export async function handleUserExport(request: Request, env: Env): Promise<Response> {
  try {
    // NOTE: Add authentication/authorization here
    // Verify Cloudflare Access JWT or API token
    
    const url = new URL(request.url);
    const format = url.searchParams.get('format') as 'csv' | 'json' || 'json';
    const batchSize = parseInt(url.searchParams.get('batchSize') || '1000');
    const fileName = url.searchParams.get('fileName') || `users-export-${Date.now()}.${format}`;
    
    const options = validateOptions({
      format,
      batchSize,
      bucket: env.USER_EXPORT_BUCKET,
    }, fileName);
    
    const result = await serialExportUsers(env, options);
    
    if (result.success) {
      return Response.json({
        success: true,
        exportedCount: result.exportedCount,
        fileUrl: result.fileUrl,
        message: `Exported ${result.exportedCount} user(s) successfully.`,
      });
    } else {
      return Response.json({
        success: false,
        error: result.error,
      }, { status: 500 });
    }
  } catch (error) {
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 400 });
  }
}

// Cloudflare Workers bindings interface
export interface Env {
  USER_EXPORT_BUCKET: R2Bucket;
  // Add other bindings as needed:
  // DB: D1Database; // For user data storage
  // AUTH_JWT_SECRET: string; // For JWT verification
}

// NOTE: To use this in a Worker:
// 1. Add R2 bucket binding in wrangler.toml
// 2. Implement actual user data source (D1, external API, etc.)
// 3. Add proper authentication/authorization
// 4. Consider using Queues for large exports to avoid timeout