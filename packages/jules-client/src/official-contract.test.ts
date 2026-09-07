import { afterEach, describe, expect, it, vi } from "vitest";
import { JulesApiClient } from "./client.js";
import {
  JulesActivityDtoSchema,
  JulesSessionDtoSchema,
  ListActivitiesResponseDtoSchema,
  ListSessionsResponseDtoSchema,
  normalizeActivityDto,
  normalizeSessionDto,
} from "./schemas.js";

describe("Official Google Jules Wire Contract & Fixtures", () => {
  afterEach(() => vi.unstubAllGlobals());

  const validSessionFixture = {
    name: "sessions/ses_prod_999",
    id: "ses_prod_999",
    prompt: "Refactor database migrations to be idempotent",
    title: "Idempotent Migrations",
    state: "IN_PROGRESS",
    url: "https://jules.google.com/session/ses_prod_999",
    sourceContext: {
      githubRepoContext: {
        repository: "atmediallc/jules-supervisor",
        startingBranch: "main",
      },
    },
    requirePlanApproval: true,
    automationMode: "AUTO_CREATE_PR",
    outputs: [
      {
        pullRequest: {
          url: "https://github.com/atmediallc/jules-supervisor/pull/42",
          prNumber: 42,
        },
      },
    ],
    createTime: "2026-09-07T12:00:00Z",
    updateTime: "2026-09-07T12:05:00Z",
    // Unknown additive fields from future API versions
    experimentalFeatures: { fastMode: true },
    copilotVersion: 2,
  };

  const validActivityFixturePlan = {
    name: "sessions/ses_prod_999/activities/act_plan_100",
    id: "act_plan_100",
    originator: "agent",
    description: "Jules created a multi-step execution plan",
    createTime: "2026-09-07T12:01:00Z",
    planGenerated: {
      plan: {
        id: "plan_alpha",
        steps: [
          { id: 1, index: 0, title: "Audit migrations", description: "Audit current SQL migrations" },
          { id: 2, index: 1, title: "Add idempotency", description: "Wrap in IF NOT EXISTS blocks" },
        ],
        summary: "Plan to make migrations idempotent",
      },
    },
    unknownMetadata: { serverRegion: "us-central1" },
  };

  const validActivityFixtureAgentMessage = {
    name: "sessions/ses_prod_999/activities/act_agent_101",
    id: "act_agent_101",
    originator: "agent",
    description: "Jules replied to user",
    createTime: "2026-09-07T12:02:00Z",
    agentMessaged: {
      agentMessage: "I have identified 6 migrations that need IF NOT EXISTS guards.",
    },
  };

  const validActivityFixtureArtifacts = {
    name: "sessions/ses_prod_999/activities/act_patch_102",
    id: "act_patch_102",
    originator: "agent",
    description: "Patch created for migrations",
    createTime: "2026-09-07T12:03:00Z",
    artifacts: [
      {
        changeSet: {
          source: "sources/gh_1",
          gitPatch: {
            baseCommitId: "abc1234",
            unidiffPatch: "diff --git a/migrations/0001.sql b/migrations/0001.sql\n...",
            suggestedCommitMessage: "feat: add IF NOT EXISTS to migrations",
          },
        },
      },
      {
        bashOutput: {
          command: "pnpm test",
          output: "All 50 tests passed",
          exitCode: 0,
        },
      },
    ],
  };

  it("validates and normalizes official session wire DTO with unknown additive fields", () => {
    const parsed = JulesSessionDtoSchema.parse(validSessionFixture);
    expect(parsed.name).toBe("sessions/ses_prod_999");
    expect(parsed.id).toBe("ses_prod_999");

    const domainSession = normalizeSessionDto(parsed);
    expect(domainSession.id).toBe("ses_prod_999");
    expect(domainSession.repository).toBe("atmediallc/jules-supervisor");
    expect(domainSession.branch).toBe("main");
    expect(domainSession.state).toBe("IN_PROGRESS");
    expect(domainSession.prompt).toContain("idempotent");
  });

  it("validates and normalizes official activity wire DTO (planGenerated)", () => {
    const parsed = JulesActivityDtoSchema.parse(validActivityFixturePlan);
    const domainActivity = normalizeActivityDto(parsed);
    expect(domainActivity.id).toBe("act_plan_100");
    expect(domainActivity.sessionId).toBe("ses_prod_999");
    expect(domainActivity.type).toBe("PLAN_GENERATED");
    expect(domainActivity.plan?.steps).toHaveLength(2);
    expect(domainActivity.plan?.steps[0]?.description).toBe("Audit current SQL migrations");
  });

  it("validates and normalizes official activity wire DTO (agentMessaged)", () => {
    const parsed = JulesActivityDtoSchema.parse(validActivityFixtureAgentMessage);
    const domainActivity = normalizeActivityDto(parsed);
    expect(domainActivity.id).toBe("act_agent_101");
    expect(domainActivity.sessionId).toBe("ses_prod_999");
    expect(domainActivity.type).toBe("AGENT_MESSAGE");
    expect(domainActivity.content).toContain("identified 6 migrations");
  });

  it("validates and normalizes official activity wire DTO (artifacts: gitPatch & bashOutput)", () => {
    const parsed = JulesActivityDtoSchema.parse(validActivityFixtureArtifacts);
    const domainActivity = normalizeActivityDto(parsed);
    expect(domainActivity.id).toBe("act_patch_102");
    expect(domainActivity.sessionId).toBe("ses_prod_999");
    expect(domainActivity.type).toBe("PATCH_CREATED");
    expect(domainActivity.patch?.diff).toContain("diff --git");
    expect(domainActivity.toolResult?.output).toBe("All 50 tests passed");
    expect(domainActivity.toolResult?.exitCode).toBe(0);
  });

  it("parses paginated list responses from official wire shape", () => {
    const listSessionsWire = {
      sessions: [validSessionFixture],
      nextPageToken: "token_page_2",
      randomFutureKey: 12345,
    };
    const parsedSessions = ListSessionsResponseDtoSchema.parse(listSessionsWire);
    expect(parsedSessions.sessions).toHaveLength(1);
    expect(parsedSessions.nextPageToken).toBe("token_page_2");

    const listActivitiesWire = {
      activities: [validActivityFixturePlan, validActivityFixtureAgentMessage],
      nextPageToken: "token_act_2",
    };
    const parsedActivities = ListActivitiesResponseDtoSchema.parse(listActivitiesWire);
    expect(parsedActivities.activities).toHaveLength(2);
    expect(parsedActivities.nextPageToken).toBe("token_act_2");
  });

  it("handles live HTTP 200/204 empty response bodies for mutations (sendMessage & approvePlan)", async () => {
    const fetchMock = vi.fn()
      // First call: sendMessage returns 200 with empty body "{}"
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
      // Second call: approvePlan returns 204 No Content
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    vi.stubGlobal("fetch", fetchMock);

    const client = new JulesApiClient({ apiKey: "test-api-key" });

    const sendRes = await client.sendMessage("ses_prod_999", { prompt: "Deploy the patch" });
    expect(sendRes.acknowledged).toBe(true);

    const approveRes = await client.approvePlan("ses_prod_999");
    expect(approveRes.acknowledged).toBe(true);

    // Verify wire payloads sent to official endpoint:
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Call 1: sendMessage must send { prompt: string }
    const call1Body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(call1Body).toEqual({ prompt: "Deploy the patch" });
    expect(call1Body.message).toBeUndefined();
    expect(call1Body.clientToken).toBeUndefined();

    // Call 2: approvePlan must send empty body {}
    const call2Body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(call2Body).toEqual({});
  });

  it("rejects malformed wire payloads deterministically", () => {
    // Missing required fields / wrong types
    expect(() => ListSessionsResponseDtoSchema.parse({ sessions: "not-an-array" })).toThrow();
    expect(() => ListActivitiesResponseDtoSchema.parse({ activities: "not-an-array" })).toThrow();
  });

  it("handles API error responses with typed JulesApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Session not found", code: 404 } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new JulesApiClient({ apiKey: "test-api-key", maxRetries: 0 });
    await expect(client.getSession("ses_nonexistent")).rejects.toThrow(/Jules API [Ee]rror \[404\]/);
  });
});
