import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getConfig } from "@jules/config";
import { getDatabase, KillSwitch, SystemSettingsRepository } from "@jules/db";

export interface WorkerRuntimeStatusResponse {
  ok: boolean;
  desiredRevision: string;
  effectiveRevision: string;
  reloadPending: boolean;
  supervisorMode: string;
  workerOnline: boolean;
  workerHeartbeat: string | null;
  safetyState: string;
  safetyReason: string | null;
  timestamp: string;
}

export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = getConfig();
    const db = getDatabase(config.DATABASE_URL);
    const settingsRepo = new SystemSettingsRepository(db);
    const killSwitch = new KillSwitch(settingsRepo);

    const safety = await killSwitch.getState();
    const revisionRow = await settingsRepo.getByKey("CONFIG_REVISION");
    const desiredRevision = revisionRow?.value ?? "0";

    const allSettings = await settingsRepo.getAll();
    const workerRows = allSettings.filter((s) => s.key.startsWith("WORKER_STATUS_"));

    let effectiveRevision = "0";
    let supervisorMode = config.SUPERVISOR_MODE;
    let workerOnline = false;
    let workerHeartbeat: string | null = null;

    if (workerRows.length > 0) {
      const latestWorker = workerRows[0];
      try {
        const parsed = JSON.parse(latestWorker?.value ?? "{}");
        effectiveRevision = parsed.effectiveRevision ?? "0";
        supervisorMode = parsed.supervisorMode ?? supervisorMode;
        workerHeartbeat = parsed.heartbeat ?? null;

        if (workerHeartbeat) {
          const ageMs = Date.now() - new Date(workerHeartbeat).getTime();
          workerOnline = ageMs < 45000;
        }
      } catch {
        // parsing fallback
      }
    }

    const reloadPending = desiredRevision !== "0" && desiredRevision !== effectiveRevision;

    const payload: WorkerRuntimeStatusResponse = {
      ok: true,
      desiredRevision,
      effectiveRevision,
      reloadPending,
      supervisorMode,
      workerOnline,
      workerHeartbeat,
      safetyState: safety.state,
      safetyReason: safety.reason,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
