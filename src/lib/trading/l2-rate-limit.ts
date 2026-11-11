// L2 API Rate Limiter — pluggable interface with InMemory and Redis backends.
//
// InMemory: default, single-instance. Works in the sandbox.
// Redis:    for multi-instance deployments. Activates when REDIS_URL env is set.
//           Falls back to InMemory if Redis is unreachable (graceful degradation).
//
// Uses a fixed sliding-window counter per source key.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

export interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  readonly backend: "memory" | "redis";
}

// ── In-memory backend ──

class InMemoryRateLimiter implements RateLimiter {
  readonly backend = "memory" as const;
  private buckets = new Map<string, { count: number; windowStart: number }>();

  async check(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bk = `${key}:${Math.floor(now / windowMs)}`;
    let bucket = this.buckets.get(bk);
    if (!bucket) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(bk, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, max - bucket.count);
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((windowMs - (now - bucket.windowStart)) / 1000);
      return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec), remaining: 0 };
    }
    // Lazy GC: drop stale buckets
    if (this.buckets.size > 1000) {
      for (const [k, b] of this.buckets) {
        if (now - b.windowStart > windowMs * 2) this.buckets.delete(k);
      }
    }
    return { allowed: true, retryAfterSec: 0, remaining };
  }
}

// ── Redis backend (multi-instance) ──

class RedisRateLimiter implements RateLimiter {
  readonly backend = "redis" as const;
  private redis: any;
  private fallback = new InMemoryRateLimiter();
  private available = false;

  constructor(redisUrl: string) {
    // Lazy-load ioredis only when REDIS_URL is set. Uses a guarded require
    // so the module loads even in ESM contexts where require isn't global.
    try {
      const req: any = typeof globalThis !== "undefined" && (globalThis as any).require
        ? (globalThis as any).require
        : typeof require !== "undefined" ? require : null;
      if (!req) throw new Error("require unavailable in this context");
      const Redis = req("ioredis");
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
      this.redis.connect().catch(() => { this.available = false; });
    } catch (e) {
      console.warn("[l2-rate-limit] ioredis unavailable, using in-memory:", e instanceof Error ? e.message : e);
    }
  }

  async check(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    if (!this.available || !this.redis) {
      // Fall back to in-memory when Redis isn't connected
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
      // Redis error → fall back to in-memory for this request
      console.warn("[l2-rate-limit] Redis check failed, using in-memory fallback:", e instanceof Error ? e.message : e);
      this.available = false;
      return this.fallback.check(key, max, windowMs);
    }
  }
}

// ── Singleton factory ──

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
