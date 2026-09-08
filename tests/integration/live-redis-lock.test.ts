/**
 * Live Redis distributed lock + ownership-loss abort signal test.
 * Requires: REDIS_URL=redis://127.0.0.1:6389
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisDistributedLock } from "../../apps/worker/src/lock";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6389";

let client: Redis;

beforeAll(async () => {
  client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  await client.connect();
});

afterAll(async () => {
  // Clean up any test lock keys
  const keys = await client.keys("lock:test:*");
  if (keys.length) await client.del(keys);
  await client.quit();
});

describe("Live Redis: distributed lock", () => {
  it("mutual exclusion: only one of two concurrent acquirers wins", async () => {
    const lock = new RedisDistributedLock(client);
    const a = lock.acquire("ses-mut", 5000);
    const b = lock.acquire("ses-mut", 5000);
    const [aRes, bRes] = await Promise.all([a, b]);
    const winners = [aRes, bRes].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    const winner = winners[0]!;
    await lock.release("ses-mut", winner);
  });

  it("renewal extends the lease for long operations", async () => {
    const lock = new RedisDistributedLock(client);
    const ctx = await lock.withLock(
      "ses-renew",
      async (context) => {
        const signal = context!.signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!signal.aborted) resolve();
            else reject(new Error("aborted"));
          }, 1500);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return "ok";
      },
      500,
    );
    expect(ctx).toBe("ok");
  });

  it("ownership loss: external Redis DELETE fires AbortSignal", async () => {
    const lock = new RedisDistributedLock(client);
    let abortObserved = false;
    await lock.withLock(
      "ses-loss",
      async (context) => {
        const signal = context!.signal;
        signal.addEventListener("abort", () => {
          abortObserved = true;
        });
        // Wait for the renew loop to start, then sabotage
        await new Promise((r) => setTimeout(r, 200));
        await client.del("lock:ses-loss");
        // Wait long enough for renew loop to fire (renew interval = max(ttl/3, 100))
        await new Promise((r) => setTimeout(r, 3500));
      },
      3_000,
    ).catch(() => undefined);
    expect(abortObserved).toBe(true);
  });

  it("stale release: old owner must not delete a new owner's lock", async () => {
    const lock = new RedisDistributedLock(client);
    const a = await lock.acquire("ses-stale", 200);
    expect(a).not.toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    const b = await lock.acquire("ses-stale", 1000);
    expect(b).not.toBeNull();
    const oldReleased = await lock.release("ses-stale", a!);
    expect(oldReleased).toBe(false);
    const c = await lock.acquire("ses-stale", 1000);
    expect(c).toBeNull();
    await lock.release("ses-stale", b!);
  });
});
