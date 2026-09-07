import { CanonicalDomainEvent } from "@jules/core";
import {
  JulesActivity,
  JulesActivityDto,
  normalizeActivityDto,
} from "@jules/jules-client";

export function normalizeJulesActivity(
  rawOrNormalized: JulesActivity | JulesActivityDto,
  fallbackSessionId?: string,
): CanonicalDomainEvent | null {
  const activity: JulesActivity =
    "rawPayload" in rawOrNormalized &&
    rawOrNormalized.type &&
    rawOrNormalized.sessionId
      ? (rawOrNormalized as JulesActivity)
      : normalizeActivityDto(rawOrNormalized as JulesActivityDto, fallbackSessionId);

  const timestamp = activity.createTime || new Date().toISOString();

  switch (activity.type) {
    case "AGENT_MESSAGE":
      return {
        type: "AGENT_MESSAGE",
        sessionId: activity.sessionId,
        activityId: activity.id,
        content: activity.content || "",
        timestamp,
      };

    case "USER_MESSAGE":
      return {
        type: "USER_MESSAGE",
        sessionId: activity.sessionId,
        activityId: activity.id,
        content: activity.content || "",
        timestamp,
      };

    case "PLAN_GENERATED":
      return {
        type: "PLAN_CREATED",
        sessionId: activity.sessionId,
        activityId: activity.id,
        steps: (activity.plan?.steps || []).map((s) => ({
          id: s.id,
          description: s.description,
          status: s.status,
        })),
        timestamp,
      };

    case "PATCH_CREATED":
      return {
        type: "PATCH_CREATED",
        sessionId: activity.sessionId,
        activityId: activity.id,
        diff: activity.patch?.diff || "",
        filesChanged: activity.patch?.filesChanged || [],
        timestamp,
      };

    case "TOOL_CALL":
    case "TOOL_EXECUTION":
      return {
        type: "TOOL_EXECUTION",
        sessionId: activity.sessionId,
        activityId: activity.id,
        toolName: String(activity.toolCall?.["name"] || "unknown"),
        args: (activity.toolCall?.["args"] || {}) as Record<string, unknown>,
        timestamp,
      };

    case "TOOL_RESULT":
      return {
        type: "TOOL_RESULT",
        sessionId: activity.sessionId,
        activityId: activity.id,
        output: String(activity.toolResult?.["output"] || ""),
        exitCode:
          typeof activity.toolResult?.["exitCode"] === "number"
            ? (activity.toolResult["exitCode"] as number)
            : undefined,
        timestamp,
      };

    default:
      return null;
  }
}
