/**
 * Cloudflare Workers environment configuration management
 * 
 * This module provides utilities for managing environment variables and configuration
 * in Cloudflare Workers, replacing Google Cloud Runtime Config patterns.
 * 
 * @module env-config
 */

/**
 * Reserved namespace prefixes that cannot be used for configuration
 */
export const RESERVED_NAMESPACES = ["firebase", "cloudflare", "workers"];

/**
 * Configuration variable identifier
 */
export interface ConfigVariable {
  config: string;
  variable: string;
}

/**
 * Parsed set argument
 */
export interface SetArgument {
  configId: string;
  varId: string;
  val: string;
}

/**
 * Parsed unset argument
 */
export interface UnsetArgument {
  configId: string;
  varId: string;
}

/**
 * Environment bindings for Cloudflare Workers
 */
export interface Env {
  /**
   * D1 database for storing configuration
   */
  DB: D1Database;
  
  /**
   * KV namespace for caching configuration
   */
  CONFIG_KV: KVNamespace;
  
  /**
   * R2 bucket for storing configuration backups
   */
  CONFIG_BUCKET?: R2Bucket;
  
  /**
   * Environment variables from wrangler.toml or dashboard
   */
  ENV_VARS?: Record<string, string>;
}

/**
 * Configuration table schema for D1 database
 */
const CONFIG_SCHEMA = `
CREATE TABLE IF NOT EXISTS config_variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_name TEXT NOT NULL,
  variable_path TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(config_name, variable_path)
);

CREATE INDEX IF NOT EXISTS idx_config_name ON config_variables(config_name);
CREATE INDEX IF NOT EXISTS idx_variable_path ON config_variables(variable_path);
`;

/**
 * Initialize the configuration database schema
 */
export async function initializeConfigDatabase(env: Env): Promise<void> {
  try {
    await env.DB.exec(CONFIG_SCHEMA);
  } catch (error) {
    console.error('Failed to initialize config database:', error);
    throw error;
  }
}

/**
 * Convert a dot-notation key to config and variable IDs
 */
function keyToIds(key: string): ConfigVariable {
  const keyParts = key.split(".");
  const variable = keyParts.slice(1).join("/");
  return {
    config: keyParts[0],
    variable: variable,
  };
}

/**
 * Check if a namespace is reserved
 */
function isReservedNamespace(id: ConfigVariable): boolean {
  return RESERVED_NAMESPACES.some((reserved) => {
    return id.config.toLowerCase().startsWith(reserved);
  });
}

/**
 * Convert variable name to config and variable IDs
 */
export function varNameToIds(varName: string): ConfigVariable {
  const configMatch = varName.match(/\/configs\/(.+)\/variables\//);
  const variableMatch = varName.match(/\/variables\/(.+)/);
  
  if (!configMatch || !variableMatch) {
    throw new Error(`Invalid variable name format: ${varName}`);
  }
  
  return {
    config: configMatch[1],
    variable: variableMatch[1],
  };
}

/**
 * Convert config and variable IDs to a variable name
 */
export function idsToVarName(projectId: string, configId: string, varId: string): string {
  return ["projects", projectId, "configs", configId, "variables", varId].join("/");
}

/**
 * Get the location for the application (Cloudflare Workers are globally distributed)
 * NOTE: Cloudflare Workers are globally distributed, so we return a default value
 */
export function getAppEngineLocation(): string {
  return "global";
}

/**
 * Get Firebase-like configuration from environment
 * NOTE: This simulates Firebase config but uses Cloudflare bindings
 */
export async function getFirebaseConfig(env: Env): Promise<Record<string, any>> {
  // Combine environment variables and database config
  const dbConfig = await materializeAll(env);
  const envConfig = env.ENV_VARS || {};
  
  return {
    ...dbConfig,
    ...envConfig,
    projectId: "cloudflare-workers-project",
    databaseURL: "https://cloudflare-workers-database.firebaseio.com",
    storageBucket: "cloudflare-workers-storage.appspot.com",
    locationId: "global",
  };
}

/**
 * Set a configuration variable
 */
async function setVariable(
  env: Env,
  configId: string,
  varPath: string,
  val: string
): Promise<void> {
  if (configId === "" || varPath === "") {
    throw new Error("Invalid argument, each config value must have a 2-part key (e.g. foo.bar).");
  }
  
  try {
    // Store in D1 database
    await env.DB.prepare(
      `INSERT OR REPLACE INTO config_variables (config_name, variable_path, value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(configId, varPath, val)
      .run();
    
    // Invalidate cache in KV
    const cacheKey = `config:${configId}:${varPath}`;
    await env.CONFIG_KV.delete(cacheKey);
    
    // Also invalidate the entire config cache
    await env.CONFIG_KV.delete(`config:${configId}`);
    
    // Optional: Backup to R2
    if (env.CONFIG_BUCKET) {
      const timestamp = new Date().toISOString();
      const backupKey = `backups/configs/${configId}/${varPath}/${timestamp}.json`;
      await env.CONFIG_BUCKET.put(backupKey, JSON.stringify({
        configId,
        varPath,
        value: val,
        timestamp,
      }));
    }
  } catch (error) {
    console.error(`Failed to set variable ${configId}.${varPath}:`, error);
    throw error;
  }
}

/**
 * Set variables recursively for nested objects
 */
export async function setVariablesRecursive(
  env: Env,
  configId: string,
  varPath: string,
  val: string | Record<string, any>
): Promise<void> {
  let parsed: any = val;
  
  if (typeof val === "string") {
    try {
      parsed = JSON.parse(val);
    } catch (e) {
      // Not valid JSON, treat as string
    }
  }
  
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const promises = Object.entries(parsed).map(([key, item]) => {
      const newVarPath = varPath ? [varPath, key].join("/") : key;
      return setVariablesRecursive(env, configId, newVarPath, JSON.stringify(item));
    });
    await Promise.all(promises);
    return;
  }
  
  // Handle arrays and primitive values
  const valueToStore = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
  await setVariable(env, configId, varPath, valueToStore);
}

/**
 * Materialize all variables for a specific config
 */
export async function materializeConfig(
  env: Env,
  configName: string,
  output: Record<string, any> = {}
): Promise<Record<string, any>> {
  // Try cache first
  const cacheKey = `config:${configName}`;
  const cached = await env.CONFIG_KV.get(cacheKey, "json");
  
  if (cached) {
    return cached as Record<string, any>;
  }
  
  try {
    // Query from database
    const result = await env.DB.prepare(
      `SELECT variable_path, value FROM config_variables 
       WHERE config_name = ? 
       ORDER BY variable_path`
    )
      .bind(configName)
      .all();
    
    // Build nested object structure
    for (const row of result.results as any[]) {
      const key = configName + "." + row.variable_path.split("/").join(".");
      
      // Try to parse JSON values
      let value: any = row.value;
      try {
        value = JSON.parse(row.value);
      } catch (e) {
        // Keep as string if not valid JSON
      }
      
      // Use lodash-like set functionality
      setNestedValue(output, key, value);
    }
    
    // Cache for 5 minutes
    await env.CONFIG_KV.put(cacheKey, JSON.stringify(output), {
      expirationTtl: 300,
    });
    
    return output;
  } catch (error) {
    console.error(`Failed to materialize config ${configName}:`, error);
    throw error;
  }
}

/**
 * Helper function to set nested values (simplified lodash.set)
 */
function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  
  current[keys[keys.length - 1]] = value;
}

/**
 * Materialize all configurations
 */
export async function materializeAll(env: Env): Promise<Record<string, any>> {
  const output: Record<string, any> = {};
  
  try {
    // Get all unique config names
    const result = await env.DB.prepare(
      `SELECT DISTINCT config_name FROM config_variables 
       WHERE config_name NOT LIKE 'firebase%' 
       ORDER BY config_name`
    ).all();
    
    const configs = result.results as any[];
    
    if (!configs.length) {
      return output;
    }
    
    // Materialize each config
    const promises = configs.map((row) => {
      if (row.config_name.match(/^firebase/)) {
        return Promise.resolve();
      }
      return materializeConfig(env, row.config_name, output);
    });
    
    await Promise.all(promises);
    return output;
  } catch (error) {
    console.error("Failed to materialize all configs:", error);
    throw error;
  }
}

/**
 * Parse set arguments from CLI
 */
export function parseSetArgs(args: string[]): SetArgument[] {
  const parsed: SetArgument[] = [];
  
  for (const arg of args) {
    const parts = arg.split("=");
    const key = parts[0];
    
    if (parts.length < 2) {
      throw new Error(`Invalid argument ${arg}, must be in key=val format`);
    }
    
    if (/[A-Z]/.test(key)) {
      throw new Error(`Invalid config name ${key}, cannot use upper case.`);
    }
    
    const id = keyToIds(key);
    
    if (isReservedNamespace(id)) {
      throw new Error(`Cannot set to reserved namespace ${id.config}`);
    }
    
    const val = parts.slice(1).join("=");
    parsed.push({
      configId: id.config,
      varId: id.variable,
      val: val,
    });
  }
  
  return parsed;
}

/**
 * Parse unset arguments from CLI
 */
export function parseUnsetArgs(args: string[]): UnsetArgument[] {
  const parsed: UnsetArgument[] = [];
  const splitArgs: string[] = [];
  
  for (const arg of args) {
    // Split by comma and add unique values
    const parts = arg.split(",");
    for (const part of parts) {
      if (part && !splitArgs.includes(part)) {
        splitArgs.push(part);
      }
    }
  }
  
  for (const key of splitArgs) {
    const id = keyToIds(key);
    
    if (isReservedNamespace(id)) {
      throw new Error(`Cannot unset reserved namespace ${id.config}`);
    }
    
    parsed.push({
      configId: id.config,
      varId: id.variable,
    });
  }
  
  return parsed;
}

/**
 * Unset configuration variables
 */
export async function unsetVariables(
  env: Env,
  args: UnsetArgument[]
): Promise<void> {
  const promises = args.map(async ({ configId, varId }) => {
    try {
      // Delete from database
      await env.DB.prepare(
        `DELETE FROM config_variables 
         WHERE config_name = ? AND variable_path = ?`
      )
        .bind(configId, varId)
        .run();
      
      // Invalidate cache
      await env.CONFIG_KV.delete(`config:${configId}:${varId}`);
      await env.CONFIG_KV.delete(`config:${configId}`);
      
    } catch (error) {
      console.error(`Failed to unset variable ${configId}.${varId}:`, error);
      throw error;
    }
  });
  
  await Promise.all(promises);
}

/**
 * Get a single configuration value
 */
export async function getVariable(
  env: Env,
  configId: string,
  varPath: string
): Promise<string | null> {
  // Try cache first
  const cacheKey = `config:${configId}:${varPath}`;
  const cached = await env.CONFIG_KV.get(cacheKey);
  
  if (cached !== null) {
    return cached;
  }
  
  try {
    // Query from database
    const result = await env.DB.prepare(
      `SELECT value FROM config_variables 
       WHERE config_name = ? AND variable_path = ?`
    )
      .bind(configId, varPath)
      .first();
    
    if (!result) {
      return null;
    }
    
    const value = (result as any).value;
    
    // Cache for 5 minutes
    await env.CONFIG_KV.put(cacheKey, value, {
      expirationTtl: 300,
    });
    
    return value;
  } catch (error) {
    console.error(`Failed to get variable ${configId}.${varPath}:`, error);
    throw error;
  }
}

/**
 * List all configurations
 */
export async function listConfigs(env: Env): Promise<string[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT DISTINCT config_name FROM config_variables ORDER BY config_name`
    ).all();
    
    return (result.results as any[]).map(row => row.config_name);
  } catch (error) {
    console.error("Failed to list configs:", error);
    throw error;
  }
}

/**
 * List all variables in a configuration
 */
export async function listVariables(
  env: Env,
  configId: string
): Promise<string[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT variable_path FROM config_variables 
       WHERE config_name = ? 
       ORDER BY variable_path`
    )
      .bind(configId)
      .all();
    
    return (result.results as any[]).map(row => row.variable_path);
  } catch (error) {
    console.error(`Failed to list variables for config ${configId}:`, error);
    throw error;
  }
}

// NOTE: Removed Google Cloud-specific functions:
// - ensureApi: Cloudflare Workers don't need API enablement
// - ensureLegacyRuntimeConfigCommandsEnabled: No legacy commands in Cloudflare
// - logFunctionsConfigDeprecationWarning: No Firebase Functions config in Cloudflare
// - getFunctionsConfigDeprecationMessage: No Firebase Functions config in Cloudflare