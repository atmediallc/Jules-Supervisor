/**
 * Live runtime-config cross-process test:
 *   1. Worker A starts and applies revision 0.
 *   2. Admin updates CONFIG_REVISION in PostgreSQL.
 *   3. Worker B syncs and observes the new revision.
 *   4. After revision change, B's config differs from A's.
 *   5. Per-worker effective revision is recorded in WORKER_STATUS_<id>.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import { SystemSettingsRepository } from "../../packages/db/src/repositories/system-settings.repository";
import { getDatabase } from "../../packages/db/src/client";
import { RuntimeConfigSynchronizer } from "../../apps/worker/src/runtime-config";
import { getConfig, setDbOverrides } from "../../packages/config/src";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://jules_user:jules_password@127.0.0.1:5439/jules_supervisor?sslmode=disable";

const client = new pg.Client({ connectionString: DATABASE_URL });
const db = drizzle(client);
const settingsRepo = new SystemSettingsRepository(db);

const WORKER_A = "worker_live_A";
const WORKER_B = "worker_live_B";

beforeAll(async () => {
  await client.connect();
  // Wipe any leftover test rows so previous failures don't poison this run
  await client.query(`DELETE FROM system_settings WHERE key LIKE 'WORKER_STATUS_worker_live_%'`);
  await client.query(`DELETE FROM system_settings WHERE key = 'CONFIG_REVISION'`);
  await client.query(`DELETE FROM system_settings WHERE key = 'SUPERVISOR_MODE'`);
  await client.query(`DELETE FROM system_settings WHERE key = 'LOG_LEVEL'`);
});

afterAll(async () => {
  // Best-effort cleanup
  try {
    await client.query(`DELETE FROM system_settings WHERE key LIKE 'WORKER_STATUS_worker_live_%'`);
    await client.query(`DELETE FROM system_settings WHERE key = 'CONFIG_REVISION'`);
    await client.query(`DELETE FROM system_settings WHERE key = 'SUPERVISOR_MODE'`);
    await client.query(`DELETE FROM system_settings WHERE key = 'LOG_LEVEL'`);
  } catch {
    // best-effort
  }
  await client.end();
});

describe("Live runtime config: cross-process synchronization", () => {
  it("Worker A heartbeats at rev=0, then admin bumps to rev-1; both workers reload", async () => {
    // 1) Admin sets CONFIG_REVISION=0 so the system has a baseline
    await settingsRepo.upsert({
      key: "CONFIG_REVISION",
      value: "0",
      category: "runtime",
      isSecret: false,
      description: "CONFIG_REVISION",
    });

    // 1a) Worker A syncs at rev=0 (heartbeat only, no reload)
    const aReloads: number[] = [];
    const aSyncer = new RuntimeConfigSynchronizer(settingsRepo, WORKER_A, async () => {
      aReloads.push(1);
    });
    const a1 = await aSyncer.syncOnce();
    expect(a1.reloaded).toBe(false);
    expect(a1.revision).toBe("0");
    expect(aReloads.length).toBe(0);

    // 2) Admin bumps revision + non-validated setting (so config doesn't fail)
    await settingsRepo.upsert({
      key: "CONFIG_REVISION",
      value: "rev-1",
      category: "runtime",
      isSecret: false,
      description: "CONFIG_REVISION",
    });
    await settingsRepo.upsert({
      key: "LOG_LEVEL",
      value: "debug",
      category: "runtime",
      isSecret: false,
      description: "Log level",
    });

    // 3) Worker A's next sync must observe the bump
    const a2 = await aSyncer.syncOnce();
    expect(a2.reloaded).toBe(true);
    expect(a2.revision).toBe("rev-1");
    expect(aReloads.length).toBe(1);

    // 4) Worker B (fresh) syncs and applies the same revision
    const bReloads: { logLevel: string | undefined; revision: string }[] = [];
    const bSyncer = new RuntimeConfigSynchronizer(settingsRepo, WORKER_B, async (newConfig) => {
      bReloads.push({ logLevel: newConfig.LOG_LEVEL, revision: "rev-1" });
    });
    const b1 = await bSyncer.syncOnce();
    expect(b1.reloaded).toBe(true);
    expect(b1.revision).toBe("rev-1");
    expect(bReloads.length).toBe(1);
    expect(bReloads[0]?.logLevel).toBe("debug");

    // 5) Subsequent B syncs at the same revision are heartbeats
    const b2 = await bSyncer.syncOnce();
    expect(b2.reloaded).toBe(false);
    expect(b2.revision).toBe("rev-1");
  });

  it("Stale worker (A, no further sync) still heartbeats at old rev-1; admin bump to rev-2 reloads", async () => {
    // Worker A's in-process revision is still rev-1 from previous test
    await settingsRepo.upsert({
      key: "CONFIG_REVISION",
      value: "rev-2",
      category: "runtime",
      isSecret: false,
      description: "CONFIG_REVISION",
    });
    const aReloads: number[] = [];
    const aSyncer = new RuntimeConfigSynchronizer(settingsRepo, WORKER_A, async () => {
      aReloads.push(1);
    });
    const a1 = await aSyncer.syncOnce();
    expect(a1.reloaded).toBe(true);
    expect(a1.revision).toBe("rev-2");
    expect(aReloads.length).toBe(1);
  });

  it("Per-worker status row is recorded after each sync", async () => {
    const aStatus = await settingsRepo.getByKey(`WORKER_STATUS_${WORKER_A}`);
    const bStatus = await settingsRepo.getByKey(`WORKER_STATUS_${WORKER_B}`);
    expect(aStatus).toBeDefined();
    expect(bStatus).toBeDefined();
    const aParsed = JSON.parse(aStatus!.value) as { effectiveRevision: string; workerId: string };
    const bParsed = JSON.parse(bStatus!.value) as { effectiveRevision: string; workerId: string };
    expect(aParsed.workerId).toBe(WORKER_A);
    expect(bParsed.workerId).toBe(WORKER_B);
    expect(aParsed.effectiveRevision).toBe("rev-2");
    expect(bParsed.effectiveRevision).toBe("rev-1");
  });
});
