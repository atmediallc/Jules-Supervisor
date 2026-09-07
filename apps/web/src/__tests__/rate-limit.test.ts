import { afterEach, describe, expect, it, vi } from "vitest";

describe("Rate limiter saturation", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds active identities without resetting existing allowances and recovers after expiry", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { isRateLimited } = await import("../lib/rate-limit");
    for (let i = 0; i < 10_000; i++) expect(isRateLimited(`auth:${i}`, "auth")).toBe(false);
    expect(isRateLimited("auth:overflow", "auth")).toBe(true);
    for (let i = 0; i < 9; i++) expect(isRateLimited("auth:0", "auth")).toBe(false);
    expect(isRateLimited("auth:0", "auth")).toBe(true);
    expect(isRateLimited("auth:overflow-again", "auth")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isRateLimited("auth:overflow", "auth")).toBe(false);
  });
});
