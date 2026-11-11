// L2 Rate Limiting — Redis backend (multi-instance).
//
// Uses ioredis loaded via dynamic `import()` so the dep is only pulled into
// the runtime when REDIS_URL is set. Falls back to in-memory if Redis is
// unreachable (graceful degradation).
//
// This replaces the previous `guardedRequire("ioredis")` pattern which
// relied on `globalThis.require`. The dynamic import is ESM-native and
// Turbopack-safe.

import type { RateLimiter, RateLimitResult } from "./types";
import { InMemoryRateLimiter } from "./memory";

export class RedisRateLimiter implements RateLimiter {
  readonly backend = "redis" as const;
  private redis: any = null;
  private fallback = new InMemoryRateLimiter();
  private available = false;
  private initPromise: Promise<void>;

  constructor(redisUrl: string) {
    this.initPromise = this.init(redisUrl);
  }

  private async init(redisUrl: string): Promise<void> {
    try {
      const mod = await import("ioredis");
      const Redis = mod.default ?? mod.Redis ?? mod;
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      this.redis.on("error", (e: Error) => {
        console.warn("[l2-rate-limit] Redis error, falling back to in-memory:", e.message);
        this.available = false;
      });
      this.redis.on("ready", () => {
        this.available = true;
      });
      await this.redis.connect().catch(() => { this.available = false; });
    } catch (e) {
      console.warn("[l2-rate-limit] ioredis unavailable, using in-memory:", e instanceof Error ? e.message : e);
      this.available = false;
    }
  }

  async check(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    // Ensure init has run at least once before checking.
    await this.initPromise.catch(() => {});
    if (!this.available || !this.redis) {
      return this.fallback.check(key, max, windowMs);
    }
    try {
      const now = Date.now();
      const bucketKey = `l2rl:${key}:${Math.floor(now / windowMs)}`;
      // Atomic INCR + EXPIRE pipeline
      const pipeline = this.redis.pipeline();
      pipeline.incr(bucketKey);
      pipeline.pexpire(bucketKey, windowMs * 2); // keep bucket for 2 windows
      const results = await pipeline.exec();
      const count = results?.[0]?.[1] ?? 0;
      const remaining = Math.max(0, max - count);
      if (count > max) {
        const retryAfterSec = Math.ceil(windowMs / 1000);
        return { allowed: false, retryAfterSec, remaining: 0 };
      }
      return { allowed: true, retryAfterSec: 0, remaining };
    } catch (e) {
      console.warn("[l2-rate-limit] Redis check failed, using in-memory fallback:", e instanceof Error ? e.message : e);
      this.available = false;
      return this.fallback.check(key, max, windowMs);
    }
  }
}
