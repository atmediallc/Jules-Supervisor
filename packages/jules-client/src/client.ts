import { logger, metrics } from "@jules/observability";
import { calculateBackoff, sleep } from "@jules/shared";
import { JulesApiError } from "./errors.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import {
  ApprovePlanRequest,
  ApprovePlanRequestSchema,
  JulesActivity,
  JulesActivitySchema,
  JulesSession,
  JulesSessionSchema,
  ListActivitiesResponse,
  ListActivitiesResponseSchema,
  ListSessionsResponse,
  ListSessionsResponseSchema,
  SendMessageRequest,
  SendMessageRequestSchema,
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
  ): Promise<JulesActivity>;
  approvePlan(
    sessionId: string,
    request: ApprovePlanRequest,
    signal?: AbortSignal,
  ): Promise<JulesActivity>;
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

        const json = await response.json();
        return json as T;
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
    return ListSessionsResponseSchema.parse(raw);
  }

  public async getSession(sessionId: string, signal?: AbortSignal): Promise<JulesSession> {
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      signal,
    );
    return JulesSessionSchema.parse(raw);
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
    return ListActivitiesResponseSchema.parse(raw);
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
    return JulesActivitySchema.parse(raw);
  }

  public async sendMessage(
    sessionId: string,
    request: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<JulesActivity> {
    const validRequest = SendMessageRequestSchema.parse(request);
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}:sendMessage`,
      {
        method: "POST",
        body: JSON.stringify(validRequest),
      },
      signal,
    );
    return JulesActivitySchema.parse(raw);
  }

  public async approvePlan(
    sessionId: string,
    request: ApprovePlanRequest,
    signal?: AbortSignal,
  ): Promise<JulesActivity> {
    const validRequest = ApprovePlanRequestSchema.parse(request);
    const raw = await this.request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}:approvePlan`,
      {
        method: "POST",
        body: JSON.stringify(validRequest),
      },
      signal,
    );
    return JulesActivitySchema.parse(raw);
  }
}
