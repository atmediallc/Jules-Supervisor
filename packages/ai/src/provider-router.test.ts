import { describe, expect, it } from "vitest";
import { Decision, DecisionAction } from "@jules/core";
import { startMockCompletionServer } from "@jules/test-utils";
import { CircuitBreaker } from "./circuit-breaker.js";
import { EndpointProvider } from "./endpoint-provider.js";
import { standardCapabilities } from "./provider-capabilities.js";
import { DefaultProviderRouter, ProviderEntry } from "./provider-router.js";
import { AiDecisionResponse, BuiltContext, IAiDecisionProvider } from "./types.js";

const okDecision: Decision = {
  action: "RESPOND" as DecisionAction,
  response: "ok",
  risk: "low",
  confidence: 0.9,
  reason: "reason",
  evidence: ["e"],
  concerns: [],
};

const context: BuiltContext = {
  systemPrompt: "sys",
  userPrompt: "user",
  contextDigest: "abc",
  estimatedTokens: 500,
};

class FakeProvider implements IAiDecisionProvider {
  public name: string;
  public calls: number;
  private behavior: "ok" | "always-fail" | "fail-once" | "auth" | "malformed" | "hang";
  private failureCount: number;
  private modeledProviderName?: string;

  constructor(name: string, behavior: "ok" | "always-fail" | "fail-once" | "auth" | "malformed" | "hang" = "ok") {
    this.name = name;
    this.calls = 0;
    this.behavior = behavior;
    this.failureCount = 0;
  }

  public async decide(_context?: BuiltContext, signal?: AbortSignal): Promise<AiDecisionResponse> {
    this.calls++;
    if (this.behavior === "hang") {
      // Never resolves on its own; only rejects if the router's total-timeout
      // signal aborts (M3). Mirrors a provider that ignores its own timeout.
      return new Promise<AiDecisionResponse>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { _aborted: true })), {
          once: true,
        });
      });
    }
    if (this.behavior === "always-fail") {
      throw new Error(`${this.name} down`);
    }
    if (this.behavior === "auth") {
      const e = new Error(`${this.name} invalid key`);
      (e as { status?: number }).status = 401;
      throw e;
    }
    if (this.behavior === "malformed") {
      // Emit something that won't pass DecisionSchema.
      return {
        decision: { bogus: true } as unknown as Decision,
        provider: this.name,
        model: "m",
      } as AiDecisionResponse;
    }
    if (this.behavior === "fail-once") {
      this.failureCount++;
      if (this.failureCount === 1) {
        throw new Error("transient");
      }
    }
    return {
      decision: okDecision,
      provider: this.name,
      model: "m",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1,
    };
  }
}

function entry(provider: FakeProvider): ProviderEntry {
  return {
    provider,
    capabilities: standardCapabilities({ model: "m", timeoutMs: 1000, maxContextTokens: 32_768 }),
    health: "HEALTHY",
  };
}

async function expectFail(router: DefaultProviderRouter) {
  await expect(router.decide(context)).rejects.toThrow();
}

describe("ProviderRouter failover matrix", () => {
  it("does not call providers when the caller already cancelled", async () => {
    const primary = new FakeProvider("primary");
    const router = new DefaultProviderRouter({ providers: [entry(primary)] });
    const controller = new AbortController();
    controller.abort();
    await expect(router.decide(context, controller.signal)).rejects.toThrow();
    expect(primary.calls).toBe(0);
  });

  it("does not retry or fall back after the overall deadline", async () => {
    const primary = new FakeProvider("primary", "hang");
    const fallback = new FakeProvider("fallback");
    const router = new DefaultProviderRouter({
      providers: [entry(primary), entry(fallback)],
      maxRetries: 3,
      totalTimeoutMs: 10,
    });
    await expect(router.decide(context)).rejects.toThrow();
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("primary success returns the decision with attempt attribution", async () => {
    const primary = new FakeProvider("primary");
    const router = new DefaultProviderRouter({ providers: [entry(primary)], maxRetries: 0 });
    const res = await router.decide(context);
    expect(res.provider).toBe("primary");
    expect(primary.calls).toBe(1);
    const detailed = await router.decideWithAttempts(context);
    expect(detailed.attempts).toHaveLength(1);
    expect(detailed.attempts[0]!.status).toBe("SUCCESS");
    expect(detailed.attempts[0]!.totalTokens).toBe(15);
  });

  it("primary retryable failure -> fallback success", async () => {
    const primary = new FakeProvider("primary", "always-fail");
    const secondary = new FakeProvider("secondary");
    const router = new DefaultProviderRouter({
      providers: [entry(primary), entry(secondary)],
      maxRetries: 0,
    });
    const res = await router.decide(context);
    expect(res.provider).toBe("secondary");
    expect(primary.calls).toBe(1);
    const detailed = await router.decideWithAttempts(context);
    expect(detailed.attempts).toHaveLength(2);
    expect(detailed.attempts[0]!.status).toBe("FAILED");
    expect(detailed.attempts[1]!.status).toBe("SUCCESS");
  });

  it("primary auth failure is NOT retried in place (no pointless retries)", async () => {
    const primary = new FakeProvider("primary", "auth");
    const router = new DefaultProviderRouter({ providers: [entry(primary)], maxRetries: 3 });
    await expectFail(router);
    expect(primary.calls).toBe(1); // auth is non-retryable: exactly one attempt
  });

  it("malformed primary output falls back safely", async () => {
    const primary = new FakeProvider("primary", "malformed");
    const secondary = new FakeProvider("secondary");
    const router = new DefaultProviderRouter({
      providers: [entry(primary), entry(secondary)],
      maxRetries: 0,
    });
    const res = await router.decide(context);
    expect(res.provider).toBe("secondary");
    const detailed = await router.decideWithAttempts(context);
    expect(detailed.attempts[0]!.failureClass).toBe("DECISION_OUTPUT_FAILURE");
    expect(detailed.attempts[1]!.status).toBe("SUCCESS");
  });

  it("all providers fail -> rejects (REQUEST_HUMAN/retryable per outer policy)", async () => {
    const primary = new FakeProvider("primary", "always-fail");
    const secondary = new FakeProvider("secondary", "always-fail");
    const router = new DefaultProviderRouter({
      providers: [entry(primary), entry(secondary)],
      maxRetries: 0,
    });
    await expectFail(router);
  });

  it("bounded MAX_AI_RETRIES amplifies retryable attempts exactly", async () => {
    const primary = new FakeProvider("primary", "always-fail");
    const router = new DefaultProviderRouter({ providers: [entry(primary)], maxRetries: 2 });
    await expectFail(router);
    // 1 + maxRetries(2) = 3 attempts, all retryable failures.
    expect(primary.calls).toBe(3);
  });

  it("circuit OPEN skips the primary without calling it", async () => {
    let clock = 0;
    const primary = new FakeProvider("primary", "always-fail");
    const secondary = new FakeProvider("secondary");
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, now: () => clock });
    // Trip the primary's circuit directly (threshold 1).
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    const router = new DefaultProviderRouter({
      providers: [{ ...entry(primary), breaker }, entry(secondary)],
      maxRetries: 0,
    });
    clock = 1000; // still in cooldown
    const res = await router.decide(context);
    expect(res.provider).toBe("secondary");
    const callsBefore = primary.calls;
    const detailed = await router.decideWithAttempts(context);
    expect(primary.calls).toBe(callsBefore);
    expect(detailed.attempts[0]!.status).toBe("SKIPPED_CIRCUIT");
    expect(detailed.attempts[0]!.provider).toBe("primary");
  });

  it("HALF_OPEN probe is attempted after cooldown and re-opens on failure", async () => {
    let clock = 0;
    const primary = new FakeProvider("primary", "always-fail");
    const secondary = new FakeProvider("secondary");
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 30_000,
      now: () => clock,
    });
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    const router = new DefaultProviderRouter({
      providers: [{ ...entry(primary), breaker }, entry(secondary)],
      maxRetries: 0,
    });
    clock = 31_000; // cooldown elapsed -> HALF_OPEN probe will run primary again
    const res = await router.decide(context);
    // Primary still fails -> reopens and falls to secondary.
    expect(res.provider).toBe("secondary");
    expect(primary.calls).toBe(1); // probe attempted
    expect(breaker.getState()).toBe("OPEN");
  });

  it("health snapshot reports circuit state without secrets", async () => {
    const clock = 0;
    const primary = new FakeProvider("primary", "always-fail");
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, now: () => clock });
    breaker.onFailure();
    const router = new DefaultProviderRouter({
      providers: [{ ...entry(primary), breaker }],
      maxRetries: 0,
    });
    const snap = router.healthSnapshot();
    expect(snap[0]!.name).toBe("primary");
    expect(snap[0]!.state).toBe("OPEN");
  });
});

// Real-HTTP failover: the router must fail over between genuine endpoints via
// the actual OpenAI HTTP client, not just fake provider objects.
describe("ProviderRouter real HTTP failover", () => {
  it("fails over from a 500-ing primary to a healthy fallback", async () => {
    const primary = await startMockCompletionServer(["http-500"]);
    const fallback = await startMockCompletionServer(["ok"]);
    try {
      const router = new DefaultProviderRouter({
        providers: [
          {
            provider: new EndpointProvider(
              {
                baseUrl: primary.baseUrl,
                apiKey: "test-key",
                model: "primary-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "primary",
            ),
            capabilities: standardCapabilities({
              model: "primary-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
          {
            provider: new EndpointProvider(
              {
                baseUrl: fallback.baseUrl,
                apiKey: "test-key",
                model: "fallback-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "fallback",
            ),
            capabilities: standardCapabilities({
              model: "fallback-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
        ],
        maxRetries: 1,
      });

      const res = await router.decide(context);
      expect(res.provider).toBe("fallback");
      expect(primary.requestCount).toBe(2); // retryable 500 retried once
      expect(fallback.requestCount).toBe(1);

      const detailed = await router.decideWithAttempts(context);
      expect(detailed.attempts.some((a) => a.status === "FAILED")).toBe(true);
      expect(detailed.attempts.some((a) => a.status === "SUCCESS")).toBe(true);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it("falls back immediately on permanent auth failure (no pointless retries)", async () => {
    const primary = await startMockCompletionServer(["http-401"]);
    const fallback = await startMockCompletionServer(["ok"]);
    try {
      const router = new DefaultProviderRouter({
        providers: [
          {
            provider: new EndpointProvider(
              {
                baseUrl: primary.baseUrl,
                apiKey: "bad-key",
                model: "primary-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "primary",
            ),
            capabilities: standardCapabilities({
              model: "primary-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
          {
            provider: new EndpointProvider(
              {
                baseUrl: fallback.baseUrl,
                apiKey: "test-key",
                model: "fallback-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "fallback",
            ),
            capabilities: standardCapabilities({
              model: "fallback-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
        ],
        maxRetries: 3,
      });

      const res = await router.decide(context);
      expect(res.provider).toBe("fallback");
      expect(primary.requestCount).toBe(1); // 401 never retried
      expect(fallback.requestCount).toBe(1);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it("treats a malformed (non-JSON) response as output failure and falls back", async () => {
    const primary = await startMockCompletionServer(["malformed"]);
    const fallback = await startMockCompletionServer(["ok"]);
    try {
      const router = new DefaultProviderRouter({
        providers: [
          {
            provider: new EndpointProvider(
              {
                baseUrl: primary.baseUrl,
                apiKey: "test-key",
                model: "primary-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "primary",
            ),
            capabilities: standardCapabilities({
              model: "primary-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
          {
            provider: new EndpointProvider(
              {
                baseUrl: fallback.baseUrl,
                apiKey: "test-key",
                model: "fallback-model",
                timeoutMs: 2000,
                allowInsecureLocal: true,
                trustedInternalHosts: ["127.0.0.1", "localhost"],
              },
              "fallback",
            ),
            capabilities: standardCapabilities({
              model: "fallback-model",
              timeoutMs: 2000,
              maxContextTokens: 128_000,
            }),
            health: "HEALTHY",
          },
        ],
        maxRetries: 0,
      });

      const res = await router.decide(context);
      expect(res.provider).toBe("fallback");
      expect(primary.requestCount).toBe(1);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });
});

describe("ProviderRouter total-timeout (M3)", () => {
  it("bounds a hanging provider by the overall orchestration deadline", async () => {
    const hanging = new FakeProvider("hang", "hang");
    const router = new DefaultProviderRouter({
      providers: [entry(hanging)],
      maxRetries: 0,
      totalTimeoutMs: 80,
    });

    const started = Date.now();
    await expect(router.decide(context)).rejects.toThrow();
    const elapsed = Date.now() - started;
    // Must give up well before ever succeeding; hanging provider never resolves.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(2_000);
    expect(hanging.calls).toBe(1);
  });

  it("clears the deadline timer after a normal success", async () => {
    const primary = new FakeProvider("primary");
    const router = new DefaultProviderRouter({
      providers: [entry(primary)],
      maxRetries: 0,
      totalTimeoutMs: 80,
    });

    const res = await router.decide(context);
    expect(res.provider).toBe("primary");
    expect(primary.calls).toBe(1);
  });
});
