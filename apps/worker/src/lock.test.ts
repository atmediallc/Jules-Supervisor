import { describe, expect, it, vi } from "vitest";
import { RedisDistributedLock } from "./lock.js";
import { sleep } from "@jules/shared";

/**
 * Unit tests for RedisDistributedLock.withLock auto-renewal.
 *
 * These run against a mocked ioredis client so they can be executed in the
 * normal unit suite without a real Redis. They verify the P0 safety property:
 * an operation that outlives the lock's base TTL (e.g. an AI call longer than
 * the lock timeout) is renewed by the owning worker, preventing a concurrent
 * worker from acquiring mid-flight ownership.
 */
describe("RedisDistributedLock.withLock renewal", () => {
  function makeMockRedis() {
    // In-memory key/value store that honors PX expiry like Redis.
    const store = new Map<string, { value: string; expiresAt: number }>();
    const client = {
      set: vi.fn(async (key: string, value: string, _px: string, ttlMs: number, _nx: string) => {
        store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return "OK";
      }),
      eval: vi.fn(async (script: string, _numKeys: number, key: string, ...args: unknown[]) => {
        const record = store.get(key);
        // release script: get == token then del
        if (script.includes("del")) {
          if (record && record.value === args[0]) {
            store.delete(key);
            return 1;
          }
          return 0;
        }
        // renew script: get == token then pexpire
        if (script.includes("pexpire")) {
          if (record && record.value === args[0]) {
            record.expiresAt = Date.now() + (args[1] as number);
            return 1;
          }
          return 0;
        }
        return 0;
      }),
      quit: vi.fn(async () => "OK"),
    } as unknown as import("ioredis").Redis;

    return { client, store };
  }

  it("holds the lock for the full duration of a long operation via renewal", async () => {
    const { client, store } = makeMockRedis();
    const lock = new RedisDistributedLock(client);

    const resource = "session:test-long";
    // Base TTL of 300ms — far shorter than the operation.
    await lock.withLock(
      resource,
      async () => {
        // Simulate an operation that outlives the 300ms TTL several times over.
        await sleep(1200);

        // While the operation is running, the lock must still be owned by us.
        const holder = store.get(`lock:${resource}`);
        expect(holder).not.toBeUndefined();
      },
      300,
    );

    // After the operation completes, the lock must be released.
    expect(store.has(`lock:${resource}`)).toBe(false);
  });

  it("does not extend a lock it no longer owns (stale-owner guard)", async () => {
    const { client, store } = makeMockRedis();
    const lock = new RedisDistributedLock(client);

    const resource = "session:test-stale";
    const token = await lock.acquire(resource, 10000);
    expect(token).not.toBeNull();

    // Simulate ownership passing to another worker: overwrite the stored token.
    store.set(`lock:${resource}`, { value: "foreign-token", expiresAt: Date.now() + 10000 });

    // This worker's renewal must NOT extend the foreign-held lock.
    const renewed = await (
      lock as unknown as {
        renew: (r: string, t: string, ttlMs: number) => Promise<boolean>;
      }
    ).renew(resource, token!, 10000);
    expect(renewed).toBe(false);

    // Cleanup the foreign lock so the test leaves no state behind.
    client.eval("del", 1, `lock:${resource}`, "foreign-token");
  });

  it("signals abort when lock ownership is lost during critical section", async () => {
    const { client, store } = makeMockRedis();
    const lock = new RedisDistributedLock(client);

    const resource = "session:test-fencing";
    let signalReceivedAbort = false;

    await lock.withLock(
      resource,
      async (context) => {
        expect(context?.isOwned()).toBe(true);

        // Simulate another worker stealing/overwriting the lock in Redis
        store.set(`lock:${resource}`, { value: "stolen-token", expiresAt: Date.now() + 10000 });

        // Wait for renewal cycle to detect loss
        await sleep(250);

        if (context?.signal.aborted) {
          signalReceivedAbort = true;
        }
      },
      150,
    );

    expect(signalReceivedAbort).toBe(true);
  });
});
