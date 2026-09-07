import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { z } from "zod";
import { EnvSchema, getConfig } from "@jules/config";
import { AuditRepository, getDatabase, runInTransaction, SystemSettingsRepository } from "@jules/db";
import { generateId } from "@jules/shared";
import { logRouteError } from "../route-logger";

/**
 * Admin Settings API — CRUD for system-wide configuration.
 * GET    /api/settings         → all settings (secrets masked)
 * PUT    /api/settings         → bulk update settings
 * DELETE /api/settings?key=X   → remove a DB override (reverts to env/default)
 *
 * Settings in the DB override environment variables at runtime.
 * Secrets (API keys, passwords) are encrypted at rest and masked in GET responses.
 *
 * AUTHZ: privileged route — requires a valid session token (defence-in-depth
 * beyond middleware). Mutations are recorded in the audit trail.
 */

// ── Settings seed catalog: defines what keys exist, their defaults, categories, and secret flag ──
const SETTINGS_CATALOG: Record<
  string,
  {
    defaultValue: string;
    category: string;
    isSecret: boolean;
    description: string;
  }
> = {
  // ── Execution & Safety ──
  SUPERVISOR_MODE: {
    defaultValue: "DRY_RUN",
    category: "execution",
    isSecret: false,
    description: "Supervisor execution mode: DISABLED, DRY_RUN, ASSISTED, AUTO_RESPOND, FULL_AUTO",
  },
  AUTO_RESPOND_ENABLED: {
    defaultValue: "false",
    category: "execution",
    isSecret: false,
    description: "Allow autonomous responses to low-risk questions",
  },
  AUTO_PLAN_APPROVAL_ENABLED: {
    defaultValue: "false",
    category: "execution",
    isSecret: false,
    description: "Autonomous approval of non-destructive plans",
  },
  MAX_SESSION_CYCLES: {
    defaultValue: "5",
    category: "execution",
    isSecret: false,
    description: "Maximum supervision cycles per session (loop prevention)",
  },
  MAX_AI_RETRIES: {
    defaultValue: "3",
    category: "execution",
    isSecret: false,
    description: "Maximum AI provider retry attempts",
  },
  POLL_INTERVAL_MS: {
    defaultValue: "5000",
    category: "execution",
    isSecret: false,
    description: "Session Watcher poll interval in milliseconds",
  },
  CONFIDENCE_THRESHOLD: {
    defaultValue: "0.85",
    category: "execution",
    isSecret: false,
    description: "Minimum confidence for automated evaluation (0-1)",
  },

  // ── Budget Engine ──
  BUDGET_MAX_AI_CALLS_PER_SESSION: {
    defaultValue: "50",
    category: "budget",
    isSecret: false,
    description: "Maximum AI calls per session",
  },
  BUDGET_MAX_TOKENS_PER_SESSION: {
    defaultValue: "100000",
    category: "budget",
    isSecret: false,
    description: "Maximum tokens per session",
  },
  BUDGET_MAX_COST_USD_PER_SESSION: {
    defaultValue: "5",
    category: "budget",
    isSecret: false,
    description: "Maximum cost (USD) per session",
  },
  BUDGET_MAX_CORRECTIONS_PER_SESSION: {
    defaultValue: "3",
    category: "budget",
    isSecret: false,
    description: "Maximum corrections per session",
  },
  AI_COST_PER_1K_PROMPT_TOKENS_USD: {
    defaultValue: "2.5",
    category: "budget",
    isSecret: false,
    description: "Cost per 1K prompt tokens (USD)",
  },
  AI_COST_PER_1K_COMPLETION_TOKENS_USD: {
    defaultValue: "10",
    category: "budget",
    isSecret: false,
    description: "Cost per 1K completion tokens (USD)",
  },

  // ── AI Provider ──
  AI_PROVIDER_TYPE: {
    defaultValue: "endpoint",
    category: "ai",
    isSecret: false,
    description: "AI provider type: endpoint, omniroute, mock",
  },
  AI_BASE_URL: {
    defaultValue: "https://api.openai.com/v1",
    category: "ai",
    isSecret: false,
    description: "AI API base URL (OpenAI-compatible endpoint)",
  },
  AI_API_KEY: {
    defaultValue: "",
    category: "ai",
    isSecret: true,
    description: "AI provider API key",
  },
  AI_MODEL: {
    defaultValue: "gpt-4o",
    category: "ai",
    isSecret: false,
    description: "AI model identifier",
  },
  AI_TIMEOUT_MS: {
    defaultValue: "30000",
    category: "ai",
    isSecret: false,
    description: "AI request timeout (ms)",
  },
  AI_MAX_TOKENS: {
    defaultValue: "2048",
    category: "ai",
    isSecret: false,
    description: "Maximum tokens in AI response",
  },
  ALLOW_INSECURE_LOCAL_ENDPOINTS: {
    defaultValue: "false",
    category: "ai",
    isSecret: false,
    description: "Allow insecure (HTTP) local AI endpoints",
  },

  // ── Google Jules API ──
  JULES_API_BASE_URL: {
    defaultValue: "https://jules.googleapis.com/v1alpha",
    category: "jules",
    isSecret: false,
    description: "Google Jules API base URL",
  },
  JULES_API_KEY: {
    defaultValue: "",
    category: "jules",
    isSecret: true,
    description: "Google Jules API key",
  },
  JULES_API_TIMEOUT_MS: {
    defaultValue: "15000",
    category: "jules",
    isSecret: false,
    description: "Jules API request timeout (ms)",
  },
  JULES_RATE_LIMIT_RPS: {
    defaultValue: "5",
    category: "jules",
    isSecret: false,
    description: "Jules API rate limit (requests per second)",
  },

  // ── Memory Bounds ──
  MEMORY_PRECEDENT_MAX_SUCCESS: {
    defaultValue: "10",
    category: "memory",
    isSecret: false,
    description: "Max cross-session success precedents retrieved",
  },
  MEMORY_PRECEDENT_MAX_HUMAN_REVIEWED: {
    defaultValue: "5",
    category: "memory",
    isSecret: false,
    description: "Max human-reviewed precedents retrieved",
  },
  MEMORY_PRECEDENT_MAX_FAILURES: {
    defaultValue: "3",
    category: "memory",
    isSecret: false,
    description: "Max failure precedents retrieved",
  },
  MEMORY_KNOWLEDGE_MAX_ITEMS: {
    defaultValue: "20",
    category: "memory",
    isSecret: false,
    description: "Max repository knowledge items retrieved",
  },

  // ── Infrastructure ──
  DATABASE_URL: {
    defaultValue: "",
    category: "infrastructure",
    isSecret: true,
    description: "PostgreSQL connection URL",
  },
  REDIS_URL: {
    defaultValue: "redis://127.0.0.1:6389",
    category: "infrastructure",
    isSecret: false,
    description: "Redis connection URL",
  },
  REDIS_ENABLED: {
    defaultValue: "true",
    category: "infrastructure",
    isSecret: false,
    description: "Enable Redis for queueing and locks",
  },
  SESSION_SECRET: {
    defaultValue: "",
    category: "infrastructure",
    isSecret: true,
    description: "Web session encryption secret",
  },
  ADMIN_MASTER_KEY: {
    defaultValue: "",
    category: "infrastructure",
    isSecret: true,
    description: "Admin master key for credential vault",
  },
};

// ── Masking for secrets ──
function maskValue(value: string): string {
  if (!value || value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

// ── Validation helpers (extracted to keep CC under threshold) ──
type ValidatedUpdate = {
  key: string;
  value: string;
  category: string;
  isSecret: boolean;
  description: string;
};

function validateUpdatePayload(
  items: { key: string; value: string }[],
): { ok: true; updates: ValidatedUpdate[] } | { ok: false; response: NextResponse } {
  const updates: ValidatedUpdate[] = [];
  for (const item of items) {
    const catalog = SETTINGS_CATALOG[item.key];
    if (!Object.hasOwn(SETTINGS_CATALOG, item.key) || !catalog) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Unknown setting key: ${item.key}` },
          { status: 400 },
        ),
      };
    }
    if (catalog.isSecret && item.value === "") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Cannot set secret ${item.key} to empty string` },
          { status: 400 },
        ),
      };
    }
    // Reuse the worker's runtime contract before persisting an override that
    // could otherwise prevent startup. Never echo the submitted value.
    const schema = Object.entries(EnvSchema.shape).find(([key]) => key === item.key)?.[1];
    if (schema && !schema.safeParse(item.value).success) {
      return {
        ok: false,
        response: NextResponse.json({ error: `Invalid value for setting ${item.key}` }, { status: 400 }),
      };
    }
    updates.push({
      key: item.key,
      value: item.value,
      category: catalog.category,
      isSecret: catalog.isSecret,
      description: catalog.description,
    });
  }
  return { ok: true, updates };
}

const UpdateSettingSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string(),
});

const BulkUpdateSchema = z.object({
  settings: z.array(UpdateSettingSchema).min(1).max(100),
});

type SettingItem = {
  key: string;
  value: string; // masked for secrets
  rawValue: string | null; // actual value, only for non-secrets
  category: string;
  isSecret: boolean;
  description: string;
  source: "database" | "environment" | "default";
};

function resolveSettingSource(
  dbVal: string | undefined,
  envVal: string | undefined,
): SettingItem["source"] {
  if (dbVal) return "database";
  if (envVal) return "environment";
  return "default";
}

function resolveSettingRawValue(
  dbVal: string | undefined,
  envVal: string | undefined,
  defaultValue: string,
): string {
  return dbVal || envVal || defaultValue;
}

function buildSettingItem(
  key: string,
  catalog: (typeof SETTINGS_CATALOG)[string],
  dbSettings: Record<string, string>,
): SettingItem {
  const dbVal = dbSettings[key];
  const envVal = process.env[key];
  const source = resolveSettingSource(dbVal, envVal);
  const rawValue = resolveSettingRawValue(dbVal, envVal, catalog.defaultValue);

  return {
    key,
    value: catalog.isSecret ? maskValue(rawValue) : rawValue,
    rawValue: catalog.isSecret ? null : rawValue,
    category: catalog.category,
    isSecret: catalog.isSecret,
    description: catalog.description,
    source,
  };
}

/** GET /api/settings — List all settings with secrets masked */
export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = getConfig();
    const db = getDatabase(config.DATABASE_URL);
    const repo = new SystemSettingsRepository(db);

    let dbSettings: Record<string, string> = {};
    try {
      dbSettings = await repo.getAsMap();
    } catch {
      // Table may not exist yet — fall back to env only
    }

    const items: SettingItem[] = Object.entries(SETTINGS_CATALOG).map(
      ([key, catalog]) => buildSettingItem(key, catalog, dbSettings),
    );

    return NextResponse.json({ settings: items });
  } catch (err: unknown) {
    logRouteError("GET /api/settings", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** PUT /api/settings — Bulk update settings */
export async function PUT(req: NextRequest) {
  try {
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actor = (token?.name as string | undefined) ?? "authenticated-operator";

    const body = await req.json();
    const parsed = BulkUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const config = getConfig();
    const db = getDatabase(config.DATABASE_URL);

    const validation = validateUpdatePayload(parsed.data.settings);
    if (!validation.ok) {
      return validation.response;
    }

    // C3 transactional atomicity: the settings write and its audit trail commit
    // together (or not at all) — a settings mutation never persists un-audited.
    let results: Awaited<ReturnType<SystemSettingsRepository["upsertMany"]>>;
    try {
      results = await runInTransaction(db, async (tx) => {
        const txRepo = new SystemSettingsRepository(tx);
        const upserted = await txRepo.upsertMany(
          validation.updates.map((u) => ({
            key: u.key,
            value: u.value,
            category: u.category,
            isSecret: u.isSecret,
            description: u.description,
          })),
        );

        // Monotonically advance configuration revision for distributed workers
        const revision = String(Date.now());
        await txRepo.upsert({
          key: "CONFIG_REVISION",
          value: revision,
          category: "runtime",
          isSecret: false,
          description: "Monotonically increasing configuration revision counter",
        });

        // Audit the privileged mutation: which settings changed and by whom.
        // Secret values are never written into the audit record.
        const txAudit = new AuditRepository(tx);
        await txAudit.record({
          id: generateId("audit"),
          actor,
          actorType: "HUMAN",
          action: "SETTINGS_UPDATE",
          targetType: "system_settings",
          targetId: "bulk",
          afterState: {
            keys: validation.updates.map((u) => u.key),
          },
          metadata: { count: validation.updates.length },
        });
        return upserted;
      });
    } catch (err: unknown) {
      logRouteError("PUT /api/settings", err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // Clear the cached config so new values take effect on next getConfig() call
    try {
      const { clearConfigCache } = await import("@jules/config");
      clearConfigCache();
    } catch {
      // Fallback: config will be refreshed on next worker restart
    }

    return NextResponse.json({
      updated: results.map((r: { key: string; category: string }) => ({
        key: r.key,
        category: r.category,
      })),
    });
  } catch (err: unknown) {
    logRouteError("PUT /api/settings", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** DELETE /api/settings?key=X — Remove a DB override (reverts to env/default) */
export async function DELETE(req: NextRequest) {
  try {
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actor = (token?.name as string | undefined) ?? "authenticated-operator";

    const key = req.nextUrl.searchParams.get("key");
    if (!key || !Object.hasOwn(SETTINGS_CATALOG, key)) {
      return NextResponse.json({ error: "Unknown setting key" }, { status: 400 });
    }

    const config = getConfig();
    const db = getDatabase(config.DATABASE_URL);

    // C3 transactional atomicity: the settings delete and its audit trail commit
    // together — a settings mutation never persists un-audited.
    try {
      await runInTransaction(db, async (tx) => {
        const txRepo = new SystemSettingsRepository(tx);
        await txRepo.deleteByKey(key);

        const revision = String(Date.now());
        await txRepo.upsert({
          key: "CONFIG_REVISION",
          value: revision,
          category: "runtime",
          isSecret: false,
          description: "Monotonically increasing configuration revision counter",
        });

        const txAudit = new AuditRepository(tx);
        await txAudit.record({
          id: generateId("audit"),
          actor,
          actorType: "HUMAN",
          action: "SETTINGS_DELETE",
          targetType: "system_settings",
          targetId: key,
          beforeState: { key },
          metadata: { revertedTo: "env/default" },
        });
      });
    } catch (err: unknown) {
      logRouteError("DELETE /api/settings", err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // Clear the cached config so the revert takes effect on next getConfig() call
    try {
      const { clearConfigCache } = await import("@jules/config");
      clearConfigCache();
    } catch {
      // Fallback: config will be refreshed on next worker restart
    }

    return NextResponse.json({ deleted: true, key });
  } catch (err: unknown) {
    logRouteError("DELETE /api/settings", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
