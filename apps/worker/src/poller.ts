import { AppConfig } from "@jules/config";
import { SyncCheckpointRepository } from "@jules/db";
import { IJulesClient, JulesActivity, JulesSession } from "@jules/jules-client";
import { logger } from "@jules/observability";
import { calculateBackoff, sleep } from "@jules/shared";
import { SupervisionPipeline } from "./pipeline.js";

export class SessionWatcher {
  private isRunning = false;
  private abortController: AbortController | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private readonly checkpointRepo: SyncCheckpointRepository | null;

  constructor(
    private readonly config: AppConfig,
    private readonly julesClient: IJulesClient,
    private readonly pipeline: SupervisionPipeline,
    checkpointRepo?: SyncCheckpointRepository,
  ) {
    this.checkpointRepo = checkpointRepo ?? null;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    logger.info("Starting Jules Session Watcher / Poller...", {
      pollIntervalMs: this.config.POLL_INTERVAL_MS,
      mode: this.config.SUPERVISOR_MODE,
    });

    this.pollLoop();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    if (this.abortController) this.abortController.abort();
    logger.info("Jules Session Watcher stopped.");
  }

  private async pollLoop(): Promise<void> {
    let consecutiveErrors = 0;

    while (this.isRunning) {
      const signal = this.abortController?.signal;
      if (signal?.aborted) break;

      try {
        await this.syncActiveSessions(signal);
        consecutiveErrors = 0;
      } catch (err: unknown) {
        if (signal?.aborted) break;
        consecutiveErrors++;
        const backoff = calculateBackoff(consecutiveErrors, this.config.POLL_INTERVAL_MS, 60000);
        logger.error(
          `Error during Jules sync cycle (attempt ${consecutiveErrors}), backing off for ${backoff}ms`,
          err,
        );
        await sleep(backoff, signal).catch(() => {});
        continue;
      }

      await sleep(this.config.POLL_INTERVAL_MS, signal).catch(() => {});
    }
  }

  /**
   * Reconciliation pass over every active session.
   *
   * Unlike the original poller (which only processed the LAST activity of a
   * session), this replays *every* activity the worker has not yet seen, so
   * activities A, B, C and D that arrived while the worker was offline (or
   * between polls) are all caught up — not just the latest.
   *
   * Correctness does NOT rely on the checkpoint cursor at all:
   * `pipeline.processActivity` is idempotent (it dedupes by a deterministic
   * session+activity idempotency key), so replaying an already-processed
   * activity is a no-op that cannot cause a duplicate external mutation. The
   * checkpoint is an observability/performance cursor only.
   */
  public async syncActiveSessions(signal?: AbortSignal): Promise<void> {
    if (this.config.SUPERVISOR_MODE === "DISABLED") return;
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    do {
      if (signal?.aborted) break;
      const listResponse = await this.julesClient.listSessions({ pageToken }, signal);
      const sessions = listResponse.sessions;

      for (const session of sessions) {
        if (signal?.aborted) break;

        // Only inspect sessions in active or awaiting states
        const needsInspection =
          session.state === "AWAITING_USER_INPUT" ||
          session.state === "AWAITING_PLAN_APPROVAL" ||
          session.state === "IN_PROGRESS" ||
          session.state === "PLANNING";

        if (!needsInspection) continue;

        try {
          await this.reconcileSession(session, signal);
        } catch (err: unknown) {
          logger.error(`Failed to process session ${session.id}`, err);
        }
      }
      pageToken = listResponse.nextPageToken;
      if (pageToken && seenPageTokens.has(pageToken)) {
        throw new Error("Jules session pagination returned a repeated page token");
      }
      if (pageToken) seenPageTokens.add(pageToken);
    } while (pageToken);
  }

  /**
   * Page through a session's full activity stream and hand every unseen
   * activity to the pipeline. `processActivity` is idempotent, so processing
   * an activity that was already handled in a prior cycle is a safe no-op.
   */
  private async reconcileSession(session: JulesSession, signal?: AbortSignal): Promise<void> {
    // IDs and page tokens are opaque, not ordered event offsets. Start a fresh
    // listing each pass and let the durable decision key deduplicate work.
    // Reusing a page token across polls can also hide new entries on page one.
    let pageToken: string | undefined;
    let highWaterMark: string | null = null;
    const seenPageTokens = new Set<string>();

    // Iterate until the API returns no next page token.
    for (;;) {
      if (signal?.aborted) break;

      const activitiesRes = await this.julesClient.listActivities(
        session.id,
        { pageSize: this.config.RECONCILIATION_PAGE_SIZE, pageToken },
        signal,
      );
      const activities: JulesActivity[] = activitiesRes.activities ?? [];

      if (activities.length > 0) {
        for (const activity of activities) {
          if (signal?.aborted) break;
          if (!activity?.id) continue;

          await this.pipeline.processActivity({ session, activity });
          highWaterMark = activity.id;
        }
      }

      // Checkpoints are diagnostic only; durable decisions determine replay.
      if (this.checkpointRepo && !signal?.aborted) {
        await this.checkpointRepo.upsert(session.id, {
          lastActivityId: highWaterMark,
          nextPageToken: null,
        });
      }

      // No more pages: we are caught up.
      if (!activitiesRes.nextPageToken) break;
      pageToken = activitiesRes.nextPageToken;
      if (seenPageTokens.has(pageToken)) {
        throw new Error("Jules activity pagination returned a repeated page token");
      }
      seenPageTokens.add(pageToken);
    }
  }
}
