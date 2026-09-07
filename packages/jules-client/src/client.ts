import { logger, metrics } from "@jules/observability";
import { calculateBackoff, sleep } from "@jules/shared";
import { JulesApiError } from "./errors.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import {
  ApprovePlanRequest,
  ApprovePlanRequestSchema,
  JulesActivity,
  JulesActivityDtoSchema,
  JulesMutationAck,
  JulesMutationAckSchema,
  JulesSession,
  JulesSessionDtoSchema,
  JulesWireApprovePlanRequest,
  JulesWireSendMessageRequest,
  ListActivitiesResponse,
  ListActivitiesResponseDtoSchema,
  ListSessionsResponse,
  ListSessionsResponseDtoSchema,
  SendMessageRequest,
  SendMessageRequestSchema,
  normalizeActivityDto,
  normalizeSessionDto,
} from "./schemas.js";

export interface JulesClientOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  rateLimitRps?: number;
  maxRetries?: number;
}

export interface IJulesClient {
  listSessions(
    params?: { pageSize?: number; pageToken?: string; filter?: string },
    signal?: AbortSignal,
  ): Promise<ListSessionsResponse>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<JulesSession>;
  listActivities(
    sessionId: string,
    params?: { pageSize?: number; pageToken?: string },
    signal?: AbortSignal,
  ): Promise<ListActivitiesResponse>;
  getActivity(sessionId: string, activityId: string, signal?: AbortSignal): Promise<JulesActivity>;
  sendMessage(
    sessionId: string,
    request: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<JulesMutationAck>;
  approvePlan(
    sessionId: string,
    request?: ApprovePlanRequest,
    signal?: AbortSignal,
  ): Promise<JulesMutationAck>;
}

export class JulesApiClient implements IJulesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimiter: TokenBucketRateLimiter;

  constructor(options: JulesClientOptions) {
    this.baseUrl = (options.baseUrl || "https://jules.googleapis.com/v1alpha").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;
    const rps = options.rateLimitRps ?? 5;
    this.rateLimiter = new TokenBucketRateLimiter(rps, rps);
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    customSignal?: AbortSignal,
  ): Promise<T> {
    await this.rateLimiter.acquire(1, customSignal);

    const url = `${this.baseUrl}${endpoint}`;
    // Jules does not document mutation idempotency. A timeout or gateway error
    // may follow a committed effect, so only reads can be retried automatically.
    const canRetry = (options.method ?? "GET").toUpperCase() === "GET";
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

      const onAbort = () => controller.abort();
      customSignal?.addEventListener("abort", onAbort, { once: true });

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          ...(options.headers as Record<string, string>),
        };

        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        const duration = Date.now() - startTime;
        metrics.recordJulesLatency(duration);

        if (!response.ok) {
          const bodyText = await response.text();
          const error = JulesApiError.fromResponse(response.status, bodyText);
          metrics.incrementJulesError(response.status);

          if (canRetry && error.isRetryable && attempt <= this.maxRetries) {
            const backoff = calculateBackoff(attempt);
            logger.warn(
              `Jules API transient error [${response.status}], retrying in ${backoff}ms...`,
            );
            await sleep(backoff, customSignal);
            continue;
          }
          throw error;
        }

        if (response.status === 204) {
          return { acknowledged: true } as T;
        }

        const bodyText = await response.text();
        if (!bodyText || bodyText.trim() === "" || bodyText.trim() === "{}") {
          return { acknowledged: true } as T;
        }

        return JSON.parse(bodyText) as T;
      } catch (err: unknown) {
        if (customSignal?.aborted) {
          throw new Error("Jules API request aborted by caller");
        }
        if (err instanceof JulesApiError) throw err;

        const isTimeout = (err as Error)?.name === "AbortError";
        if (canRetry && isTimeout && attempt <= this.maxRetries) {
          metrics.incrementJulesError("TIMEOUT");
          const backoff = calculateBackoff(attempt);
          logger.warn(`Jules API timeout on attempt ${attempt}, retrying in ${backoff}ms...`);
          await sleep(backoff, customSignal);
          continue;
        }

        metrics.incrementJulesError("FETCH_ERROR");
        throw new JulesApiError(
          `Failed to execute Jules API request: ${(err as Error).message}`,
          0,
          false,
          err,
        );
      } finally {
        clearTimeout(timeoutTimer);
        customSignal?.removeEventListener("abort", onAbort);
      }
    }

    throw new JulesApiError("Max retries exceeded for Jules API request", 500, false);
  }

  public async listSessions(
    params: { pageSize?: number; pageToken?: string; filter?: string } = {},
    signal?: AbortSignal,
  ): Promise<ListSessionsResponse> {
    const query = new URLSearchParams();
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    if (params.pageToken) query.set("pageToken", params.pageToken);
    if (params.filter) query.set("filter", params.filter);

    const queryString = query.toString() ? `?${query.toString()}` : "";
    const raw = await this.request<unknown>(`/sessions${queryString}`, { method: "GET" }, signal);
    const parsed = ListSessionsResponseDtoSchema.parse(raw);
    return {
      sessions: parsed.sessions.map(normalizeSessionDto),
      nextPageToken: parsed.nextPageToken,
    };
  }

  public async getSession(sessionId: string, signal?: AbortSignal): Promise<JulesSession> {
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      signal,
    );
    const parsed = JulesSessionDtoSchema.parse(raw);
    return normalizeSessionDto(parsed);
  }

  public async listActivities(
    sessionId: string,
    params: { pageSize?: number; pageToken?: string } = {},
    signal?: AbortSignal,
  ): Promise<ListActivitiesResponse> {
    const query = new URLSearchParams();
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    if (params.pageToken) query.set("pageToken", params.pageToken);

    const queryString = query.toString() ? `?${query.toString()}` : "";
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}/activities${queryString}`,
      { method: "GET" },
      signal,
    );
    const parsed = ListActivitiesResponseDtoSchema.parse(raw);
    return {
      activities: parsed.activities.map((a) => normalizeActivityDto(a, sessionId)),
      nextPageToken: parsed.nextPageToken,
    };
  }

  public async getActivity(
    sessionId: string,
    activityId: string,
    signal?: AbortSignal,
  ): Promise<JulesActivity> {
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}/activities/${encodeURIComponent(activityId)}`,
      { method: "GET" },
      signal,
    );
    const parsed = JulesActivityDtoSchema.parse(raw);
    return normalizeActivityDto(parsed, sessionId);
  }

  public async sendMessage(
    sessionId: string,
    request: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<JulesMutationAck> {
    const validRequest = SendMessageRequestSchema.parse(request);
    const prompt = validRequest.prompt ?? validRequest.message!;
    const wirePayload: JulesWireSendMessageRequest = { prompt };
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}:sendMessage`,
      {
        method: "POST",
        body: JSON.stringify(wirePayload),
      },
      signal,
    );
    return JulesMutationAckSchema.parse(raw ?? { acknowledged: true });
  }

  public async approvePlan(
    sessionId: string,
    request?: ApprovePlanRequest,
    signal?: AbortSignal,
  ): Promise<JulesMutationAck> {
    if (request) {
      ApprovePlanRequestSchema.parse(request);
    }
    const wirePayload: JulesWireApprovePlanRequest = {};
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}:approvePlan`,
      {
        method: "POST",
        body: JSON.stringify(wirePayload),
      },
      signal,
    );
    return JulesMutationAckSchema.parse(raw ?? { acknowledged: true });
  }
}
