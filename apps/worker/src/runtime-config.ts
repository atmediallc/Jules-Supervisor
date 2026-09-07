import { AppConfig, getConfig, setDbOverrides } from "@jules/config";
import { SystemSettingsRepository } from "@jules/db";
import { logger } from "@jules/observability";

export interface RuntimeConfigSyncResult {
  reloaded: boolean;
  revision: string;
  error?: string;
}

export class RuntimeConfigSynchronizer {
  private currentRevision = "0";

  constructor(
    private readonly settingsRepo: SystemSettingsRepository,
    private readonly workerId: string,
    private readonly onReload: (newConfig: AppConfig) => Promise<void> | void,
  ) {}

  public async syncOnce(): Promise<RuntimeConfigSyncResult> {
    try {
      const revisionRow = await this.settingsRepo.getByKey("CONFIG_REVISION");
      const desiredRevision = revisionRow?.value ?? "0";

      if (desiredRevision !== this.currentRevision) {
        const overrides = await this.settingsRepo.getAsMap();
        setDbOverrides(overrides);
        const newConfig = getConfig();

        await this.onReload(newConfig);
        this.currentRevision = desiredRevision;

        await this.settingsRepo.upsert({
          key: `WORKER_STATUS_${this.workerId}`,
          value: JSON.stringify({
            workerId: this.workerId,
            effectiveRevision: this.currentRevision,
            supervisorMode: newConfig.SUPERVISOR_MODE,
            provider: newConfig.AI_PROVIDER_TYPE,
            model: newConfig.AI_MODEL,
            heartbeat: new Date().toISOString(),
          }),
          category: "runtime",
          isSecret: false,
          description: "Worker runtime status and acknowledged config revision",
        });

        logger.info("Worker dynamically applied configuration revision", {
          revision: this.currentRevision,
          mode: newConfig.SUPERVISOR_MODE,
          provider: newConfig.AI_PROVIDER_TYPE,
          model: newConfig.AI_MODEL,
        });

        return { reloaded: true, revision: this.currentRevision };
      }

      // Heartbeat
      await this.settingsRepo.upsert({
        key: `WORKER_STATUS_${this.workerId}`,
        value: JSON.stringify({
          workerId: this.workerId,
          effectiveRevision: this.currentRevision,
          supervisorMode: getConfig().SUPERVISOR_MODE,
          provider: getConfig().AI_PROVIDER_TYPE,
          model: getConfig().AI_MODEL,
          heartbeat: new Date().toISOString(),
        }),
        category: "runtime",
        isSecret: false,
        description: "Worker runtime status and acknowledged config revision",
      });

      return { reloaded: false, revision: this.currentRevision };
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      logger.error("Runtime config synchronization failed", err);
      return { reloaded: false, revision: this.currentRevision, error: msg };
    }
  }
}
