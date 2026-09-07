import { z } from "zod";

// ==========================================
// 1. Official Google Jules Wire Transport DTOs
// ==========================================

export const JulesPlanStepDtoSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    index: z.number().int().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();
export type JulesPlanStepDto = z.infer<typeof JulesPlanStepDtoSchema>;

export const JulesPlanDtoSchema = z
  .object({
    id: z.string().optional(),
    steps: z.array(JulesPlanStepDtoSchema).optional().default([]),
    summary: z.string().optional(),
    createTime: z.string().optional(),
  })
  .passthrough();
export type JulesPlanDto = z.infer<typeof JulesPlanDtoSchema>;

export const JulesArtifactDtoSchema = z
  .object({
    changeSet: z
      .object({
        source: z.string().optional(),
        gitPatch: z
          .object({
            baseCommitId: z.string().optional(),
            unidiffPatch: z.string().optional(),
            suggestedCommitMessage: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    bashOutput: z
      .object({
        command: z.string().optional(),
        output: z.string().optional(),
        exitCode: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
    media: z
      .object({
        mimeType: z.string().optional(),
        data: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JulesArtifactDto = z.infer<typeof JulesArtifactDtoSchema>;

export const JulesActivityDtoSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    originator: z.string().optional(),
    description: z.string().optional(),
    createTime: z.string().optional(),
    artifacts: z.array(JulesArtifactDtoSchema).optional().default([]),
    planGenerated: z
      .object({
        plan: JulesPlanDtoSchema.optional(),
      })
      .passthrough()
      .optional(),
    planApproved: z
      .object({
        planId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    userMessaged: z
      .object({
        userMessage: z.string().optional(),
      })
      .passthrough()
      .optional(),
    agentMessaged: z
      .object({
        agentMessage: z.string().optional(),
      })
      .passthrough()
      .optional(),
    progressUpdated: z
      .object({
        progressMessage: z.string().optional(),
      })
      .passthrough()
      .optional(),
    sessionCompleted: z.record(z.string(), z.unknown()).optional(),
    sessionFailed: z
      .object({
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),

    // Legacy/Synthetic fields (backward compatibility)
    sessionId: z.string().optional(),
    type: z.string().optional(),
    content: z.string().optional(),
    plan: JulesPlanDtoSchema.optional(),
    patch: z
      .object({
        diff: z.string().optional(),
        filesChanged: z.array(z.string()).optional().default([]),
      })
      .passthrough()
      .optional(),
    toolCall: z.record(z.string(), z.unknown()).optional(),
    toolResult: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type JulesActivityDto = z.infer<typeof JulesActivityDtoSchema>;

export const ListActivitiesResponseDtoSchema = z
  .object({
    activities: z.array(JulesActivityDtoSchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();
export type ListActivitiesResponseDto = z.infer<typeof ListActivitiesResponseDtoSchema>;

export const JulesSessionDtoSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    state: z.string().optional().default("QUEUED"),
    url: z.string().optional(),
    sourceContext: z
      .object({
        githubRepoContext: z
          .object({
            startingBranch: z.string().optional(),
            repository: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    requirePlanApproval: z.boolean().optional(),
    automationMode: z.string().optional(),
    outputs: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    createTime: z.string().optional(),
    updateTime: z.string().optional(),
    // Legacy / convenience fields
    repository: z.string().optional(),
    branch: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();
export type JulesSessionDto = z.infer<typeof JulesSessionDtoSchema>;

export const ListSessionsResponseDtoSchema = z
  .object({
    sessions: z.array(JulesSessionDtoSchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();
export type ListSessionsResponseDto = z.infer<typeof ListSessionsResponseDtoSchema>;

// Official Google Jules wire requests
export const JulesWireSendMessageRequestSchema = z.object({
  prompt: z.string().min(1),
});
export type JulesWireSendMessageRequest = z.infer<typeof JulesWireSendMessageRequestSchema>;

export const JulesWireApprovePlanRequestSchema = z.object({}).default({});
export type JulesWireApprovePlanRequest = z.infer<typeof JulesWireApprovePlanRequestSchema>;

// Mutation acknowledgement (200/204 empty response from Google Jules)
export const JulesMutationAckSchema = z.object({
  acknowledged: z.boolean().default(true),
});
export type JulesMutationAck = z.infer<typeof JulesMutationAckSchema>;

// ==========================================
// 2. Client Ingestion Request Shapes
// ==========================================

export const SendMessageRequestSchema = z
  .object({
    prompt: z.string().optional(),
    message: z.string().optional(),
    clientToken: z.string().optional(),
  })
  .refine((data) => !!(data.prompt || data.message), {
    message: "Either prompt or message is required",
  });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const ApprovePlanRequestSchema = z
  .object({
    approved: z.boolean().optional(),
    feedback: z.string().optional(),
    clientToken: z.string().optional(),
  })
  .optional();
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequestSchema>;

// ==========================================
// 3. Domain Models and Normalizers
// ==========================================

export const JulesPlanStepSchema = z.object({
  id: z.union([z.number(), z.string()]),
  description: z.string(),
  status: z.string().optional().default("PENDING"),
});
export type JulesPlanStep = z.infer<typeof JulesPlanStepSchema>;

export const JulesPlanSchema = z.object({
  steps: z.array(JulesPlanStepSchema).default([]),
  summary: z.string().optional(),
});
export type JulesPlan = z.infer<typeof JulesPlanSchema>;

export const JulesPatchSchema = z.object({
  diff: z.string().optional(),
  filesChanged: z.array(z.string()).optional().default([]),
});
export type JulesPatch = z.infer<typeof JulesPatchSchema>;

export const JulesActivitySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  content: z.string().optional().default(""),
  plan: JulesPlanSchema.optional(),
  patch: JulesPatchSchema.optional(),
  toolCall: z.record(z.string(), z.unknown()).optional(),
  toolResult: z.record(z.string(), z.unknown()).optional(),
  createTime: z.string().optional(),
  rawPayload: z.record(z.string(), z.unknown()).optional(),
});
export type JulesActivity = z.infer<typeof JulesActivitySchema>;

export const ListActivitiesResponseSchema = z.object({
  activities: z.array(JulesActivitySchema).default([]),
  nextPageToken: z.string().optional(),
});
export type ListActivitiesResponse = z.infer<typeof ListActivitiesResponseSchema>;

export const JulesSessionSchema = z.object({
  id: z.string(),
  name: z.string().optional().default(""),
  title: z.string().optional().default(""),
  repository: z.string().default("unknown/repo"),
  branch: z.string().default("main"),
  prompt: z.string().default(""),
  state: z.string().default("QUEUED"),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type JulesSession = z.infer<typeof JulesSessionSchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(JulesSessionSchema).default([]),
  nextPageToken: z.string().optional(),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

/**
 * Normalizes an external JulesSessionDto into the domain JulesSession model.
 */
export function normalizeSessionDto(dto: JulesSessionDto): JulesSession {
  const id =
    dto.id ||
    (dto.name?.startsWith("sessions/") ? dto.name.split("/")[1] : "") ||
    "unknown-session";
  const repo =
    dto.repository ||
    dto.sourceContext?.githubRepoContext?.repository ||
    "unknown/repo";
  const branch =
    dto.branch ||
    dto.sourceContext?.githubRepoContext?.startingBranch ||
    "main";
  return {
    id,
    name: dto.name || `sessions/${id}`,
    title: dto.title || "",
    repository: repo,
    branch,
    prompt: dto.prompt || "",
    state: dto.state || "QUEUED",
    createTime: dto.createTime,
    updateTime: dto.updateTime,
    metadata: dto.metadata || {},
  };
}

/**
 * Normalizes an external JulesActivityDto into the domain JulesActivity model.
 */
export function normalizeActivityDto(
  dto: JulesActivityDto,
  fallbackSessionId?: string,
): JulesActivity {
  const parts = dto.name?.split("/") ?? [];
  const extractedSessionId =
    parts.length >= 4 && parts[0] === "sessions" ? parts[1] : undefined;
  const extractedActivityId =
    parts.length >= 4 && parts[2] === "activities" ? parts[3] : undefined;

  const id = dto.id || extractedActivityId || "unknown-activity";
  const sessionId =
    dto.sessionId || extractedSessionId || fallbackSessionId || "unknown-session";

  let type = dto.type || "UNKNOWN";
  let content = dto.content || dto.description || "";
  let plan: JulesPlan | undefined = dto.plan
    ? {
        steps: (dto.plan.steps ?? []).map((s, i) => ({
          id: s.id ?? i,
          description: s.description ?? s.title ?? "",
          status: s.status ?? "PENDING",
        })),
        summary: dto.plan.summary,
      }
    : undefined;
  let patch: JulesPatch | undefined = dto.patch
    ? { diff: dto.patch.diff, filesChanged: dto.patch.filesChanged }
    : undefined;
  let toolResult: Record<string, unknown> | undefined = dto.toolResult;
  const toolCall: Record<string, unknown> | undefined = dto.toolCall;

  // Derive from official Google Jules fields if present:
  if (dto.planGenerated) {
    type = "PLAN_GENERATED";
    if (dto.planGenerated.plan) {
      plan = {
        steps: (dto.planGenerated.plan.steps ?? []).map((s, idx) => ({
          id: s.id ?? s.index ?? idx,
          description: s.description ?? s.title ?? `Step ${idx}`,
          status: s.status ?? "PENDING",
        })),
        summary: dto.planGenerated.plan.summary,
      };
    }
  } else if (dto.planApproved) {
    type = "PLAN_APPROVED";
  } else if (dto.userMessaged) {
    type = "USER_MESSAGE";
    content = dto.userMessaged.userMessage || content;
  } else if (dto.agentMessaged) {
    type = "AGENT_MESSAGE";
    content = dto.agentMessaged.agentMessage || content;
  } else if (dto.progressUpdated) {
    type = "PROGRESS_UPDATE";
    content = dto.progressUpdated.progressMessage || content;
  } else if (dto.sessionCompleted) {
    type = "SESSION_COMPLETED";
  } else if (dto.sessionFailed) {
    type = "SESSION_FAILED";
    content = dto.sessionFailed.reason || content;
  }

  // Check artifacts for patches / tool execution
  if (dto.artifacts && dto.artifacts.length > 0) {
    for (const artifact of dto.artifacts) {
      if (artifact.changeSet?.gitPatch) {
        type = "PATCH_CREATED";
        patch = {
          diff: artifact.changeSet.gitPatch.unidiffPatch,
          filesChanged: [],
        };
      }
      if (artifact.bashOutput) {
        if (type === "UNKNOWN") {
          type = "TOOL_RESULT";
        }
        toolResult = {
          command: artifact.bashOutput.command,
          output: artifact.bashOutput.output,
          exitCode: artifact.bashOutput.exitCode,
        };
      }
    }
  }

  return {
    id,
    sessionId,
    type,
    content,
    plan,
    patch,
    toolCall,
    toolResult,
    createTime: dto.createTime,
    rawPayload: dto as Record<string, unknown>,
  };
}
