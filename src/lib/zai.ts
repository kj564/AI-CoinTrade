// ZAI SDK config loader + retry-aware call wrapper.
//
// The z-ai-web-dev-sdk loads config from /etc/.z-ai-config (or project/home dir).
// The SDK's loadConfig() checks `baseUrl && apiKey` but does NOT verify `token`.
// If the sandbox refreshes the config file and the `token` field is momentarily
// empty/missing while baseUrl+apiKey are present, the SDK loads an incomplete
// config, skips the X-Token header, and the API returns 401 "missing X-Token".
//
// This module wraps ZAI.create() with token validation + provides a retry
// wrapper for chat/image/audio calls that handles the config-refresh race.

import ZAI from "z-ai-web-dev-sdk";
import fs from "fs/promises";
import path from "path";
import os from "os";

export interface ZaiConfig {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
  chatId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface ZaiConfigStatus {
  found: boolean;
  path: string | null;
  hasBaseUrl: boolean;
  hasApiKey: boolean;
  hasToken: boolean;
  tokenLength: number;
  apiKeyLength: number;
  valid: boolean; // baseUrl + apiKey + token all present
  error?: string;
}

const CONFIG_PATHS = [
  path.join(process.cwd(), ".z-ai-config"),
  path.join(os.homedir(), ".z-ai-config"),
  "/etc/.z-ai-config",
];

// Read the raw config file (for diagnostics). Does not throw.
export async function readZaiConfig(): Promise<{ config: ZaiConfig | null; path: string | null; error?: string }> {
  for (const filePath of CONFIG_PATHS) {
    try {
      const configStr = await fs.readFile(filePath, "utf-8");
      const config = JSON.parse(configStr);
      return { config, path: filePath };
    } catch (e: any) {
      if (e.code === "ENOENT") continue; // try next path
      // JSON parse error or other — record but continue
      const lastPath = filePath;
      try {
        const next = CONFIG_PATHS[CONFIG_PATHS.indexOf(filePath) + 1];
        if (next) {
          const cfg = await fs.readFile(next, "utf-8");
          return { config: JSON.parse(cfg), path: next };
        }
      } catch { /* ignore */ }
      return { config: null, path: lastPath, error: e.message };
    }
  }
  return { config: null, path: null, error: "No .z-ai-config found in project, home, or /etc" };
}

// Check the config status (for /api/zai/health).
export async function getZaiConfigStatus(): Promise<ZaiConfigStatus> {
  const { config, path: foundPath, error } = await readZaiConfig();
  if (!config) {
    return {
      found: false,
      path: foundPath,
      hasBaseUrl: false,
      hasApiKey: false,
      hasToken: false,
      tokenLength: 0,
      apiKeyLength: 0,
      valid: false,
      error,
    };
  }
  const hasBaseUrl = !!config.baseUrl;
  const hasApiKey = !!config.apiKey;
  const hasToken = !!config.token;
  return {
    found: true,
    path: foundPath,
    hasBaseUrl,
    hasApiKey,
    hasToken,
    tokenLength: (config.token || "").length,
    apiKeyLength: (config.apiKey || "").length,
    valid: hasBaseUrl && hasApiKey && hasToken,
  };
}

// Create a ZAI instance, but validate that the token is present first.
// If the token is missing (config-refresh race), wait briefly and retry
// reading the config before giving up.
export async function createZaiWithTokenCheck(maxWaitMs = 3000): Promise<any> {
  const deadline = Date.now() + maxWaitMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      // Read the config directly first to check for token
      const { config, path: cfgPath } = await readZaiConfig();
      if (config && config.baseUrl && config.apiKey && config.token) {
        // Config looks complete — delegate to the SDK
        return await ZAI.create();
      }
      // Config incomplete (token missing) — likely a refresh race.
      // Wait briefly and retry.
      lastError = new Error(
        config
          ? `ZAI config at ${cfgPath} missing token field (baseUrl=${!!config.baseUrl}, apiKey=${!!config.apiKey}, token=${!!config.token}). Retrying — config may be mid-refresh.`
          : `ZAI config not found at any path. Retrying.`,
      );
      console.warn("[zai] " + lastError.message);
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Final attempt — let the SDK try its own loading (it may succeed even
  // without token, in case the API accepts apiKey-only auth)
  try {
    return await ZAI.create();
  } catch (e) {
    throw lastError ?? e;
  }
}

// Wrap a ZAI call with retry-on-401 logic. If the first attempt fails with
// 401 "missing X-Token header", the config was likely mid-refresh. Wait
// briefly, re-create the ZAI instance (which re-reads config), and retry.
export async function withZaiRetry<T>(
  fn: (zai: any) => Promise<T>,
  opts: { maxRetries?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const zai = await createZaiWithTokenCheck();
      return await fn(zai);
    } catch (e: any) {
      lastError = e;
      const msg = e.message || String(e);
      // Retry only on 401 "missing X-Token header" (config-refresh race)
      // or on config-not-found errors.
      const is401MissingToken = msg.includes("401") && msg.includes("X-Token");
      const isConfigError = msg.includes("Configuration file not found") || msg.includes("missing token field");
      if (attempt < maxRetries && (is401MissingToken || isConfigError)) {
        console.warn(`[zai] attempt ${attempt + 1} failed (${msg.slice(0, 80)}), retrying in ${retryDelayMs}ms…`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
