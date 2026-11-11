// L2 Rate Limiting — backward-compat re-export shim.
//
// The rate-limit implementation has been split into focused modules under
// src/lib/rate-limit/* for cleaner module boundaries:
//   - types.ts     shared interfaces
//   - memory.ts    InMemoryRateLimiter (default, single-instance)
//   - redis.ts     RedisRateLimiter (dynamic ioredis import, multi-instance)
//   - factory.ts   backend selection + convenience helpers
//
// This file re-exports the public API so existing imports
// (`import { ... } from "@/lib/trading/l2-rate-limit"`) continue to work.
// New code should import directly from the focused modules.

export type { RateLimiter, RateLimitResult } from "@/lib/rate-limit/types";
export { InMemoryRateLimiter } from "@/lib/rate-limit/memory";
export { RedisRateLimiter } from "@/lib/rate-limit/redis";
export { checkCollectRateLimit, getRateLimitBackend } from "@/lib/rate-limit/factory";
