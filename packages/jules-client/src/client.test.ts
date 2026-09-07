import { afterEach, describe, expect, it, vi } from "vitest";
import { MockJulesClient } from "./mock.js";
import { JulesApiClient } from "./client.js";

describe("Jules HTTP retry safety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([429, 502, 503, 504])("does not retry a mutation after HTTP %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("upstream failure", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JulesApiClient({ apiKey: "fixture", maxRetries: 3 });
    await expect(client.sendMessage("session", { message: "hello", clientToken: "same-token" }))
      .rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an approval after an ambiguous timeout", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("timeout", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JulesApiClient({ apiKey: "fixture", maxRetries: 3 });
    await expect(client.approvePlan("session", { approved: true })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains bounded retries for read-only requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JulesApiClient({ apiKey: "fixture", maxRetries: 1 });
    await expect(client.listSessions()).resolves.toEqual({ sessions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("MockJulesClient contract tests", () => {
  it("lists sessions and seeded activities", async () => {
    const client = new MockJulesClient();
    const sessionsRes = await client.listSessions();
    expect(sessionsRes.sessions.length).toBeGreaterThan(0);

    const first = sessionsRes.sessions[0]!;
    const activitiesRes = await client.listActivities(first.id);
    expect(activitiesRes.activities.length).toBeGreaterThan(0);
  });

  it("handles sendMessage and updates session state to IN_PROGRESS", async () => {
    const client = new MockJulesClient();
    const session = await client.getSession("ses_test_001");
    expect(session.state).toBe("AWAITING_USER_INPUT");

    const ack = await client.sendMessage("ses_test_001", {
      message: "Please proceed with token bucket rate limiter.",
    });

    expect(ack.acknowledged).toBe(true);

    const activities = await client.listActivities("ses_test_001");
    const lastActivity = activities.activities.at(-1);
    expect(lastActivity?.type).toBe("USER_MESSAGE");
    expect(lastActivity?.content).toContain("token bucket");

    const updatedSession = await client.getSession("ses_test_001");
    expect(updatedSession.state).toBe("IN_PROGRESS");
  });

  it("handles plan approval and records activity", async () => {
    const client = new MockJulesClient();
    const ack = await client.approvePlan("ses_test_002", {
      approved: true,
      feedback: "Plan looks solid.",
    });

    expect(ack.acknowledged).toBe(true);

    const activities = await client.listActivities("ses_test_002");
    const lastActivity = activities.activities.at(-1);
    expect(lastActivity?.type).toBe("PLAN_APPROVED");

    const updated = await client.getSession("ses_test_002");
    expect(updated.state).toBe("IN_PROGRESS");
  });
});
