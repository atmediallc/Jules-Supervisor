import { describe, expect, it } from "vitest";
import { normalizeJulesActivity } from "./normalizer.js";

describe("normalizeJulesActivity", () => {
  it("normalizes official Jules planGenerated activity into PLAN_CREATED canonical event", () => {
    const rawOfficial = {
      name: "sessions/ses_abc/activities/act_plan_1",
      originator: "agent",
      createTime: "2026-09-07T10:00:00Z",
      planGenerated: {
        plan: {
          id: "plan_1",
          steps: [
            { id: 10, title: "Step 1", description: "Review files", status: "COMPLETED" },
            { id: 11, title: "Step 2", description: "Apply changes", status: "PENDING" },
          ],
        },
      },
    };

    const event = normalizeJulesActivity(rawOfficial);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("PLAN_CREATED");
    expect(event?.sessionId).toBe("ses_abc");
    expect(event?.activityId).toBe("act_plan_1");
    if (event?.type === "PLAN_CREATED") {
      expect(event.steps).toHaveLength(2);
      expect(event.steps[0]?.description).toBe("Review files");
      expect(event.steps[0]?.status).toBe("COMPLETED");
    }
  });

  it("normalizes official Jules agentMessaged activity into AGENT_MESSAGE event", () => {
    const rawOfficial = {
      name: "sessions/ses_abc/activities/act_msg_1",
      originator: "agent",
      createTime: "2026-09-07T10:05:00Z",
      agentMessaged: {
        agentMessage: "Hello, I am ready to work.",
      },
    };

    const event = normalizeJulesActivity(rawOfficial);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("AGENT_MESSAGE");
    expect(event?.sessionId).toBe("ses_abc");
    if (event?.type === "AGENT_MESSAGE") {
      expect(event.content).toBe("Hello, I am ready to work.");
    }
  });

  it("normalizes official Jules userMessaged activity into USER_MESSAGE event", () => {
    const rawOfficial = {
      name: "sessions/ses_abc/activities/act_usr_1",
      originator: "user",
      createTime: "2026-09-07T10:06:00Z",
      userMessaged: {
        userMessage: "Please proceed with fix.",
      },
    };

    const event = normalizeJulesActivity(rawOfficial);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("USER_MESSAGE");
    if (event?.type === "USER_MESSAGE") {
      expect(event.content).toBe("Please proceed with fix.");
    }
  });

  it("normalizes official artifacts into PATCH_CREATED event", () => {
    const rawOfficial = {
      name: "sessions/ses_abc/activities/act_patch_1",
      originator: "agent",
      artifacts: [
        {
          changeSet: {
            source: "sources/repo",
            gitPatch: {
              unidiffPatch: "diff --git a/test.ts b/test.ts\n+console.log('hi');",
            },
          },
        },
      ],
    };

    const event = normalizeJulesActivity(rawOfficial);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("PATCH_CREATED");
    if (event?.type === "PATCH_CREATED") {
      expect(event.diff).toContain("diff --git");
    }
  });

  it("preserves backward compatibility with legacy flat activity objects", () => {
    const legacy = {
      id: "act_leg_1",
      sessionId: "ses_leg_1",
      type: "TOOL_RESULT",
      toolResult: { output: "build succeeded", exitCode: 0 },
      createTime: "2026-09-07T10:07:00Z",
    };

    const event = normalizeJulesActivity(legacy);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("TOOL_RESULT");
    if (event?.type === "TOOL_RESULT") {
      expect(event.output).toBe("build succeeded");
      expect(event.exitCode).toBe(0);
    }
  });
});
