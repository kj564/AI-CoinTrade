// L2 Rate Limiting — factory + convenience helpers.
//
// Selects the backend based on REDIS_URL env var. Singleton per process
// (stored on globalThis to survive hot-reloads in dev).

import type { RateLimiter, RateLimitResult } from "./types";
import { InMemoryRateLimiter } from "./memory";
import { RedisRateLimiter } from "./redis";

const globalForRL = globalThis as unknown as { __l2RateLimiter?: RateLimiter };

function getRateLimiter(): RateLimiter {
  if (!globalForRL.__l2RateLimiter) {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      console.log("[l2-rate-limit] Redis backend selected (REDIS_URL set)");
      globalForRL.__l2RateLimiter = new RedisRateLimiter(redisUrl);
    } else {
      console.log("[l2-rate-limit] In-memory backend selected (no REDIS_URL)");
      globalForRL.__l2RateLimiter = new InMemoryRateLimiter();
    }
  }
  return globalForRL.__l2RateLimiter;
}

// Convenience: check rate limit for the L2 collect endpoint.
// Default: 3 calls per 60s per source (IP).
export async function checkCollectRateLimit(
  source: string,
  max = 3,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  return getRateLimiter().check(`collect:${source}`, max, windowMs);
}

export function getRateLimitBackend(): "memory" | "redis" {
  return getRateLimiter().backend;
}
