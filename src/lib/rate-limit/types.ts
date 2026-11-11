// L2 Rate Limiting — shared interfaces.
//
// Pluggable backend: InMemory (default, single-instance) or Redis
// (multi-instance, activates when REDIS_URL is set).

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

export interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  readonly backend: "memory" | "redis";
}
