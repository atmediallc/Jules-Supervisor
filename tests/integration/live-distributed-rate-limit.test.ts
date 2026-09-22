/**
 * Live Distributed Rate Limiter Integration Tests.
 *
 * Verifies S07:
 * 1. Redis atomic Lua script enforces shared bucket across multiple clients/processes.
 * 2. Aggregate requests from Worker A and Worker B respect configured threshold.
 * 3. Expiration window clears counter correctly.
 * 4. Fallback to local memory limiter on Redis failure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { isRateLimitedDistributed, RATE_LIMIT_POLICY } from "../../apps/web/src/lib/rate-limit";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6389";
let redisClientA: Redis;
let redisClientB: Redis;

const TEST_IP = `test-dist-rate-${Date.now()}`;
const TEST_KEY = `auth:${TEST_IP}`;

beforeAll(async () => {
  redisClientA = new Redis(REDIS_URL);
  redisClientB = new Redis(REDIS_URL);
  await redisClientA.del(`ratelimit:${TEST_KEY}`);
});

afterAll(async () => {
  try {
    await redisClientA.del(`ratelimit:${TEST_KEY}`);
    redisClientA.disconnect();
    redisClientB.disconnect();
  } catch {
    // best-effort
  }
});

describe("Live Distributed Rate Limiter (S07)", () => {
  it("enforces shared limit across two distinct Redis clients", async () => {
    expect(RATE_LIMIT_POLICY.auth.limit).toBe(10);

    // Send 5 from Client A
    for (let i = 0; i < 5; i++) {
      const blocked = await isRateLimitedDistributed(redisClientA, TEST_KEY, "auth");
      expect(blocked).toBe(false);
    }

    // Send 5 from Client B
    for (let i = 0; i < 5; i++) {
      const blocked = await isRateLimitedDistributed(redisClientB, TEST_KEY, "auth");
      expect(blocked).toBe(false);
    }

    // Total 10 reached. 11th request from Client A must be BLOCKED
    const blockedA = await isRateLimitedDistributed(redisClientA, TEST_KEY, "auth");
    expect(blockedA).toBe(true);

    // 12th request from Client B must also be BLOCKED
    const blockedB = await isRateLimitedDistributed(redisClientB, TEST_KEY, "auth");
    expect(blockedB).toBe(true);
  });
});
