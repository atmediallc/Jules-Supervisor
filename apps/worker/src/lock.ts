import { randomBytes } from "node:crypto";
import { sleep } from "@jules/shared";
import { Redis } from "ioredis";

export interface LockContext {
  token: string;
  signal: AbortSignal;
  isOwned: () => boolean;
}

export interface IDistributedLock {
  acquire(resource: string, ttlMs?: number): Promise<string | null>;
  release(resource: string, token: string): Promise<boolean>;
  withLock<T>(
    resource: string,
    fn: (context?: LockContext) => Promise<T>,
    ttlMs?: number,
  ): Promise<T>;
}

export class RedisDistributedLock implements IDistributedLock {
  constructor(private readonly redis: Redis) {}

  public async acquire(resource: string, ttlMs = 15000): Promise<string | null> {
    const token = randomBytes(16).toString("hex");
    const key = `lock:${resource}`;
    // PX: expire in milliseconds, NX: set only if not exists
    const result = await this.redis.set(key, token, "PX", ttlMs, "NX");
    return result === "OK" ? token : null;
  }

  public async release(resource: string, token: string): Promise<boolean> {
    const key = `lock:${resource}`;
    // Lua script to safely release lock only if value matches token
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, token);
    return result === 1;
  }

  /**
   * Atomically refresh the lock TTL, but only if the key still holds our token.
   * This lets a long-running critical section (e.g. an AI call + persistence)
   * keep ownership past the original TTL without ever extending a lock it no
   * longer owns (guards against the stale-owner-expiry race).
   */
  private async renew(resource: string, token: string, ttlMs: number): Promise<boolean> {
    const key = `lock:${resource}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, token, ttlMs);
    return result === 1;
  }

  public async withLock<T>(
    resource: string,
    fn: (context?: LockContext) => Promise<T>,
    ttlMs = 15000,
  ): Promise<T> {
    const token = await this.acquire(resource, ttlMs);
    if (!token) {
      throw new Error(`Failed to acquire lock for resource: ${resource}`);
    }

    const abortController = new AbortController();
    let consecutiveRenewalFailures = 0;
    const maxRenewalFailures = 2;

    // Renew the lock while the critical section runs so operations that outlive
    // the base TTL don't lose ownership. If ownership is lost or renewals fail,
    // the AbortController is signaled immediately to fence the stale worker.
    const renewIntervalMs = Math.max(Math.floor(ttlMs / 3), 100);
    let renewTimer: NodeJS.Timeout | null = null;
    if (ttlMs > 0) {
      renewTimer = setInterval(() => {
        void this.renew(resource, token, ttlMs)
          .then((renewed) => {
            if (!renewed) {
              abortController.abort(
                new Error(`Distributed lock ownership lost for resource: ${resource}`),
              );
            } else {
              consecutiveRenewalFailures = 0;
            }
          })
          .catch(() => {
            consecutiveRenewalFailures++;
            if (consecutiveRenewalFailures >= maxRenewalFailures) {
              abortController.abort(
                new Error(
                  `Distributed lock renewal failed repeatedly for resource: ${resource}`,
                ),
              );
            }
          });
      }, renewIntervalMs);
    }

    const context: LockContext = {
      token,
      signal: abortController.signal,
      isOwned: () => !abortController.signal.aborted,
    };

    try {
      return await fn(context);
    } finally {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      await this.release(resource, token);
    }
  }
}

export class InMemoryDistributedLock implements IDistributedLock {
  private locks = new Map<string, { token: string; expiresAt: number }>();

  public async acquire(resource: string, ttlMs = 15000): Promise<string | null> {
    const now = Date.now();
    const existing = this.locks.get(resource);
    if (existing && existing.expiresAt > now) {
      return null;
    }
    const token = randomBytes(16).toString("hex");
    this.locks.set(resource, { token, expiresAt: now + ttlMs });
    return token;
  }

  public async release(resource: string, token: string): Promise<boolean> {
    const existing = this.locks.get(resource);
    if (existing && existing.token === token) {
      this.locks.delete(resource);
      return true;
    }
    return false;
  }

  public async withLock<T>(
    resource: string,
    fn: (context?: LockContext) => Promise<T>,
    ttlMs = 15000,
  ): Promise<T> {
    let token = await this.acquire(resource, ttlMs);
    let attempts = 0;
    while (!token && attempts < 10) {
      attempts++;
      await sleep(100);
      token = await this.acquire(resource, ttlMs);
    }
    if (!token) {
      throw new Error(`Failed to acquire in-memory lock for resource: ${resource}`);
    }

    const abortController = new AbortController();
    const context: LockContext = {
      token,
      signal: abortController.signal,
      isOwned: () => true,
    };

    try {
      return await fn(context);
    } finally {
      await this.release(resource, token);
    }
  }
}
