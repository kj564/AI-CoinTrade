// L2 Rate Limiting — in-memory backend (default).
//
// Fixed sliding-window counter per source key. Single-instance only.
// For multi-instance deployments, use the Redis backend (factory picks it
// automatically when REDIS_URL is set).

import type { RateLimiter, RateLimitResult } from "./types";

export class InMemoryRateLimiter implements RateLimiter {
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
