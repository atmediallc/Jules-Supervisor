import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JulesApiClient } from "../../packages/jules-client/src/client";
import { JulesApiError } from "../../packages/jules-client/src/errors";

function getLiveApiKey(): string | undefined {
  if (process.env.JULES_API_KEY && process.env.JULES_API_KEY !== "mock-jules-key-placeholder") {
    return process.env.JULES_API_KEY;
  }
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (k === "JULES_API_KEY" && v && !v.includes("placeholder") && !v.includes("your-google")) {
          return v;
        }
      }
    }
  }
  return undefined;
}

const liveApiKey = getLiveApiKey();
const runLive = Boolean(liveApiKey);

describe("Live Official Google Jules API Contract (R01 Validation)", () => {
  it.runIf(runLive)("authenticates and lists sessions from real Google Jules v1alpha endpoint", async () => {
    const client = new JulesApiClient({
      apiKey: liveApiKey!,
      baseUrl: "https://jules.googleapis.com/v1alpha",
      rateLimitRps: 2,
    });

    const response = await client.listSessions({ pageSize: 5 });
    expect(response).toBeDefined();
    expect(Array.isArray(response.sessions)).toBe(true);
    expect(response.sessions.length).toBeGreaterThan(0);

    const session = response.sessions[0];
    expect(session.id).toBeTruthy();
    expect(typeof session.title).toBe("string");
    expect(typeof session.state).toBe("string");
  });

  it.runIf(runLive)("fetches session detail and activities matching official DTO schemas", async () => {
    const client = new JulesApiClient({
      apiKey: liveApiKey!,
      baseUrl: "https://jules.googleapis.com/v1alpha",
      rateLimitRps: 2,
    });

    const listResponse = await client.listSessions({ pageSize: 3 });
    const sessionId = listResponse.sessions[0].id;

    const session = await client.getSession(sessionId);
    expect(session.id).toBe(sessionId);
    expect(session.title).toBeDefined();

    const activitiesResponse = await client.listActivities(sessionId, { pageSize: 10 });
    expect(activitiesResponse).toBeDefined();
    expect(Array.isArray(activitiesResponse.activities)).toBe(true);
    expect(activitiesResponse.activities.length).toBeGreaterThan(0);

    const act = activitiesResponse.activities[0];
    expect(act.id).toBeTruthy();
    expect(act.type).toBeDefined();
    expect(act.createTime).toBeDefined();
  });

  it.runIf(runLive)("executes sendMessage mutation against real session and validates wire ack", async () => {
    const client = new JulesApiClient({
      apiKey: liveApiKey!,
      baseUrl: "https://jules.googleapis.com/v1alpha",
      rateLimitRps: 2,
    });

    const listResponse = await client.listSessions({ pageSize: 1 });
    const sessionId = listResponse.sessions[0].id;

    const probeText = `Automated contract verification probe ${Date.now()}`;
    const ack = await client.sendMessage(sessionId, { prompt: probeText });

    expect(ack).toBeDefined();
    expect(ack.acknowledged).toBe(true);

    const activitiesResponse = await client.listActivities(sessionId, { pageSize: 50 });
    const latestUserMsg = activitiesResponse.activities.find(
      (a) => a.type === "USER_MESSAGE" && (a as unknown as { content?: string }).content === probeText,
    );
    expect(latestUserMsg).toBeDefined();
    expect(latestUserMsg?.type).toBe("USER_MESSAGE");
  });

  it.runIf(runLive)("executes approvePlan mutation against real session and validates wire ack & activity record", async () => {
    const client = new JulesApiClient({
      apiKey: liveApiKey!,
      baseUrl: "https://jules.googleapis.com/v1alpha",
      rateLimitRps: 2,
    });

    const listResponse = await client.listSessions({ pageSize: 1 });
    const sessionId = listResponse.sessions[0].id;

    const ack = await client.approvePlan(sessionId);
    expect(ack).toBeDefined();
    expect(ack.acknowledged).toBe(true);

    const activitiesResponse = await client.listActivities(sessionId, { pageSize: 50 });
    const hasApprovedActivity = activitiesResponse.activities.some(
      (a) => a.type === "PLAN_APPROVED",
    );
    expect(hasApprovedActivity).toBe(true);
  });

  it.runIf(runLive)("handles invalid authentication gracefully with non-retryable 401/403 JulesApiError", async () => {
    const invalidClient = new JulesApiClient({
      apiKey: "invalid-test-key-0000000000",
      baseUrl: "https://jules.googleapis.com/v1alpha",
    });

    try {
      await invalidClient.listSessions({ pageSize: 1 });
      expect.unreachable("Should have thrown JulesApiError on invalid key");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(JulesApiError);
      const apiErr = err as JulesApiError;
      expect([400, 401, 403]).toContain(apiErr.statusCode);
      expect(apiErr.isRetryable).toBe(false);
    }
  });
});
