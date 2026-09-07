import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "@jules/config";
import { SystemSettingsRepository } from "@jules/db";
import { RuntimeConfigSynchronizer } from "./runtime-config.js";

interface SettingsRow {
  key: string;
  value: string;
}

describe("RuntimeConfigSynchronizer (R04)", () => {
  let settingsStore: Map<string, SettingsRow>;
  let settingsRepo: SystemSettingsRepository;

  beforeEach(() => {
    settingsStore = new Map();
    settingsRepo = {
      getByKey: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
      getAll: vi.fn(async () => Array.from(settingsStore.values())),
      getAsMap: vi.fn(async () => {
        const map: Record<string, string> = {};
        for (const [k, v] of settingsStore.entries()) {
          map[k] = v.value;
        }
        return map;
      }),
      upsert: vi.fn(async (s: { key: string; value: string }) => {
        settingsStore.set(s.key, s);
        return s;
      }),
    } as unknown as SystemSettingsRepository;
  });

  it("detects and applies new configuration revision across processes", async () => {
    let reloadedConfig: AppConfig | null = null;
    const synchronizer = new RuntimeConfigSynchronizer(
      settingsRepo,
      "worker-node-1",
      (cfg) => {
        reloadedConfig = cfg;
      },
    );

    // Initial state: revision 1 in DB
    settingsStore.set("CONFIG_REVISION", { key: "CONFIG_REVISION", value: "1" });
    settingsStore.set("SUPERVISOR_MODE", { key: "SUPERVISOR_MODE", value: "FULL_AUTO" });

    const result = await synchronizer.syncOnce();
    expect(result.reloaded).toBe(true);
    expect(result.revision).toBe("1");
    expect(reloadedConfig?.SUPERVISOR_MODE).toBe("FULL_AUTO");

    // Worker status heartbeat row persisted
    const statusRow = settingsStore.get("WORKER_STATUS_worker-node-1");
    expect(statusRow).toBeDefined();
    const status = JSON.parse(statusRow.value);
    expect(status.effectiveRevision).toBe("1");
    expect(status.supervisorMode).toBe("FULL_AUTO");

    // Second pass: same revision -> no reload, only heartbeat refresh
    const secondResult = await synchronizer.syncOnce();
    expect(secondResult.reloaded).toBe(false);
  });
});
