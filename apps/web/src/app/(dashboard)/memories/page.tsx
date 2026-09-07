import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getConfig } from "@jules/config";
import { getDatabase, AiMemoryRepository } from "@jules/db";
import type { MemoryType } from "@jules/core";
import {
  Archive,
  CheckCircle2,
  RefreshCw,
  Ban,
} from "lucide-react";
import { getTranslations, getLocale } from "next-intl/server";
import { formatNumber } from "@/lib/intl";

export const dynamic = "force-dynamic";

const MEMORY_TYPES: MemoryType[] = [
  "failure",
  "decision",
  "procedural",
  "semantic",
  "repository",
  "preference",
  "episodic",
  "task_outcome",
];

const TYPE_COLORS: Record<string, string> = {
  failure: "text-rose-400 bg-rose-950/60 border-rose-800",
  decision: "text-amber-400 bg-amber-950/60 border-amber-800",
  procedural: "text-emerald-400 bg-emerald-950/60 border-emerald-800",
  semantic: "text-sky-400 bg-sky-950/60 border-sky-800",
  repository: "text-violet-400 bg-violet-950/60 border-violet-800",
  preference: "text-pink-400 bg-pink-950/60 border-pink-800",
  episodic: "text-cyan-400 bg-cyan-950/60 border-cyan-800",
  task_outcome: "text-lime-400 bg-lime-950/60 border-lime-800",
};

const STATUS_COLORS: Record<string, string> = {
  active: "text-emerald-400 bg-emerald-950/60 border-emerald-800",
  stale: "text-amber-400 bg-amber-950/60 border-amber-800",
  superseded: "text-slate-400 bg-slate-800 border-slate-700",
  archived: "text-slate-500 bg-slate-900 border-slate-800",
};

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ repositoryId?: string; memoryType?: string; status?: string }>;
}) {
  const t = await getTranslations("memory");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const params = await searchParams;
  const config = getConfig();
  const db = getDatabase(config.DATABASE_URL);
  const repo = new AiMemoryRepository(db);

  const repositoryId = params.repositoryId ?? "jules-supervisor";
  const memoryType = MEMORY_TYPES.includes(params.memoryType as MemoryType)
    ? (params.memoryType as MemoryType)
    : undefined;
  const validStatuses = [
    "active",
    "stale",
    "superseded",
    "archived",
    "invalidated",
    "expired",
  ];
  const status = validStatuses.includes(params.status ?? "")
    ? (params.status as "active" | "stale" | "superseded" | "archived" | "invalidated" | "expired")
    : undefined;

  let memories: Awaited<ReturnType<typeof repo.list>> = [];
  try {
    memories = await repo.list({
      tenantId: "default",
      repositoryId,
      memoryType,
      status,
      limit: 100,
    });
  } catch (err) {
    console.warn("Database unavailable, rendering memories with fallback empty list:", err);
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-violet-600/10 blur-3xl rounded-full" />
        <div className="relative flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">
              {t("control_title")}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("control_description")}
            </p>
          </div>
          <form action={async () => {
            "use server";
            revalidatePath("/memories");
          }}>
            <button
              type="submit"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-abyss text-slate-100 hover:bg-panel text-sm font-medium border border-white/10 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" /> {tCommon("refresh")}
            </button>
          </form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label={t("total_shown")} value={String(memories.length)} />
        <StatCard
          label={t("active")}
          value={String(memories.filter((m) => m.status === "active").length)}
        />
        <StatCard
          label={t("stale")}
          value={String(memories.filter((m) => m.status === "stale").length)}
        />
        <StatCard
          label={t("total_accesses")}
          value={String(memories.reduce((a, m) => a + m.accessCount, 0))}
        />
      </div>

      <div className="relative overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-3">
        <div className="absolute inset-0 grid-overlay opacity-30 pointer-events-none" />
        <div className="relative text-xs text-slate-400 font-mono">
          {memories.length === 0 ? (
            tCommon("no_memories_found")
          ) : (
            tCommon("memories_count", { count: String(memories.length) })
          )}
        </div>
        <div className="relative space-y-2">
          {memories.map((m) => (
            <div
              key={m.id}
              className="p-4 bg-abyss/70 rounded-xl border border-white/5 flex items-start justify-between gap-4 hover:border-violet-500/30 transition-colors"
            >
              <Link href={`/memories/${m.id}`} className="flex-1 min-w-0">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <TypeBadge type={m.memoryType} />
                    <StatusBadge status={m.status} />
                    <span className="text-slate-100 font-medium text-sm truncate">
                      {m.title}
                    </span>
                  </div>
                  <p className="text-slate-400 text-xs line-clamp-2">{m.summary}</p>
                  <div className="text-[10px] text-slate-400 font-mono">
                    conf={m.confidence.toFixed(2)} importance={m.importance.toFixed(2)}
                    {" · "}access={formatNumber(locale, m.accessCount)} ✓={formatNumber(locale, m.successfulUseCount)} ✗={formatNumber(locale, m.negativeOutcomeCount)}
                  </div>
                </div>
              </Link>
              {m.status === "active" && (
                <div className="flex items-center gap-2">
                  <MemoryAction id={m.id} action="validate" label={t("validate")} icon={<CheckCircle2 className="w-4 h-4" />} />
                  <MemoryAction id={m.id} action="archive" label={t("archive")} icon={<Archive className="w-4 h-4" />} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="relative overflow-hidden p-4 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10">
      <div className="absolute -top-6 -right-6 w-16 h-16 bg-violet-500/10 blur-2xl rounded-full" />
      <div className="relative text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className="relative text-2xl font-bold text-slate-100 mt-1 font-mono">{value}</div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${
        TYPE_COLORS[type] ?? "text-slate-300 bg-slate-800 border-slate-700"
      }`}
    >
      {type}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${
        STATUS_COLORS[status] ?? "text-slate-300 bg-slate-800 border-slate-700"
      }`}
    >
      {status}
    </span>
  );
}

function MemoryAction({
  id,
  action,
  label,
  icon,
}: {
  id: string;
  action: "validate" | "archive";
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <form
      action={async () => {
        "use server";
        const config = getConfig();
        const db = getDatabase(config.DATABASE_URL);
        const repo = new AiMemoryRepository(db);
        if (action === "archive") await repo.archive(id);
        else await repo.markValidated(id);
        revalidatePath("/memories");
        revalidatePath(`/memories/${id}`);
      }}
    >
      <button
        type="submit"
        title={action === "archive" ? "Archive (remove from recall)" : "Mark validated"}
        className={`flex items-center justify-center w-9 h-9 rounded-lg border text-slate-300 hover:text-slate-100 hover:bg-panel transition-colors ${
          action === "archive" ? "border-slate-700" : "border-emerald-800/60 text-emerald-400"
        }`}
      >
        {icon ?? <Ban className="w-4 h-4" />}
        <span className="sr-only">{label}</span>
      </button>
    </form>
  );
}
