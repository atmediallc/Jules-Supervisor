/**
 * In-memory fixed-window rate limiter for the web control plane (Edge-safe).
 *
 * NOTE: The bucket map is per-process/per-instance. For multi-instance (or
 * serverless) deployments, replace with a shared store (e.g. Redis token
 * bucket) — this implementation is correct for a single self-hosted instance,
 * which is the deployment model for this monorepo.
 */

import type { Redis } from "ioredis";

interface Bucket {
  count: number;
  windowStart: number;
}

export type RateLimitKind = "api" | "auth";

export const RATE_LIMIT_POLICY: Record<RateLimitKind, { limit: number; windowMs: number }> = {
  // General API surface: 120 requests per minute per IP.
  api: { limit: 120, windowMs: 60_000 },
  // Login / credentials callback: 10 attempts per minute per IP (brute-force).
  auth: { limit: 10, windowMs: 60_000 },
};

const buckets = new Map<string, Bucket>();

const MAX_BUCKETS = 10_000;

/** Prune expired buckets occasionally so the map cannot grow unbounded. */
function pruneExpired(windowMs: number): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
    if (buckets.size <= MAX_BUCKETS) break;
  }
}

/**
 * Returns true when the request for `key` exceeds the configured limit for
 * `kind`. A fresh window is opened on the first request.
 */
export function isRateLimited(key: string, kind: RateLimitKind): boolean {
  const { limit, windowMs } = RATE_LIMIT_POLICY[kind];
  const now = Date.now();
  const bucket = buckets.get(key);

  if (buckets.size >= MAX_BUCKETS) pruneExpired(windowMs);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) return true;
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count++;
  return bucket.count > limit;
}

/**
 * Redis-backed distributed atomic rate limiter using an atomic Lua script.
 * Enforces limits across multiple web instances / serverless workers.
 *
 * Lua Script ensures:
 * 1. INCR the counter key
 * 2. If it's the first hit, set PEXPIRE
 * 3. Returns the current counter value
 */
const REDIS_RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export async function isRateLimitedDistributed(
  redis: Redis,
  key: string,
  kind: RateLimitKind,
): Promise<boolean> {
  const policy = RATE_LIMIT_POLICY[kind];
  const redisKey = `ratelimit:${key}`;

  try {
    const current = (await redis.eval(
      REDIS_RATE_LIMIT_LUA,
      1,
      redisKey,
      String(policy.windowMs),
    )) as number;

    return current > policy.limit;
  } catch {
    // Fail-safe: fall back to local in-memory limiter on Redis error
    return isRateLimited(key, kind);
  }
}

/** Best-effort client IP, preferring the left-most untrusted proxy value. */
export function clientIpFromHeaders(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Rate limit key scoped by kind + IP. */
export function rateLimitKey(kind: RateLimitKind, ip: string): string {
  return `${kind}:${ip}`;
}
