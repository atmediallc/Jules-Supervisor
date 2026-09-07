import { Activity, Cpu, CheckCircle2, Clock, AlertTriangle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { getConfig } from "@jules/config";
import {
  getDatabase,
  approvalRequests,
  decisions,
  sql,
  SessionRepository,
} from "@jules/db";
import { getTranslations, getLocale } from "next-intl/server";
import { formatNumber } from "@/lib/intl";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = await getTranslations("overview");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const config = getConfig();
  const db = getDatabase(config.DATABASE_URL);
  const sessionsRepo = new SessionRepository(db);

  let allSessions: Awaited<ReturnType<typeof sessionsRepo.list>> = [];
  let stats = {
    activeSessions: 0,
    awaitingFeedback: 0,
    awaitingPlanApproval: 0,
    pendingHumanReviews: 0,
    decisionsToday: 0,
    autoExecuted: 0,
    blockedDecisions: 0,
    avgLatencyMs: 0,
  };

  try {
    allSessions = await sessionsRepo.list(500);
    const activeCount = allSessions.filter(
      (s) => !["COMPLETED", "CANCELLED", "FAILED"].includes(s.state),
    ).length;
    const [pendingCount, todayCount, autoCount, blockedCount, avgRow] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvalRequests)
        .where(sql`status = 'PENDING'`),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(decisions)
        .where(sql`created_at >= now() - interval '24 hours'`),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(decisions)
        .where(sql`execution_state = 'EXECUTED'`),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(decisions)
        .where(sql`execution_state = 'BLOCKED'`),
      db
        .select({ avg: sql<number>`coalesce(avg(ai_latency_ms), 0)::int` })
        .from(decisions)
        .where(sql`created_at >= now() - interval '24 hours'`),
    ]);

    stats = {
      activeSessions: activeCount,
      awaitingFeedback: allSessions.filter((s) => s.state === "AWAITING_USER_INPUT").length,
      awaitingPlanApproval: allSessions.filter((s) => s.state === "AWAITING_PLAN_APPROVAL").length,
      pendingHumanReviews: pendingCount[0]?.count ?? 0,
      decisionsToday: todayCount[0]?.count ?? 0,
      autoExecuted: autoCount[0]?.count ?? 0,
      blockedDecisions: blockedCount[0]?.count ?? 0,
      avgLatencyMs: avgRow[0]?.avg ?? 0,
    };
  } catch (err) {
    console.warn("Database unavailable, rendering overview with fallback empty state:", err);
  }

  return (
    <div className="space-y-8">
      {/* Top Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-jules-600/10 blur-3xl rounded-full" />
        <div className="absolute -bottom-20 left-1/3 w-48 h-48 bg-cyber-500/5 blur-3xl rounded-full" />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">
              {t("title")}{" "}
              <span className="bg-gradient-to-r from-jules-400 to-cyber-300 bg-clip-text text-transparent">
                ▸
              </span>
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("description")}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/approvals"
              className="flex items-center gap-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 dark:text-amber-300 border border-amber-500/30 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-colors"
            >
              <AlertTriangle className="w-4 h-4" />
              {t("pending_approvals", { count: String(stats.pendingHumanReviews) })}
            </Link>
            <Link
              href="/sessions"
              className="flex items-center gap-2 bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 text-white px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all shadow-[0_8px_24px_-8px_rgba(59,130,246,0.8)]"
            >
              <Activity className="w-4 h-4" />
              {t("view_sessions")}
            </Link>
          </div>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="relative overflow-hidden p-5 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-2 group hover:border-jules-500/30 transition-colors">
          <div className="absolute -top-8 -right-8 w-24 h-24 bg-jules-500/10 blur-2xl rounded-full" />
          <div className="relative flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>{t("active_jules_sessions")}</span>
            <Activity className="w-4 h-4 text-jules-400" />
          </div>
          <div className="relative text-3xl font-bold text-slate-100 font-mono">{formatNumber(locale, stats.activeSessions)}</div>
          <div className="relative text-xs text-slate-400">
            <span className="text-amber-400 font-medium">{formatNumber(locale, stats.awaitingFeedback)}</span> {t("awaiting_feedback", { count: String(stats.awaitingFeedback) })}
          </div>
        </div>

        <div className="relative overflow-hidden p-5 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-2 group hover:border-amber-500/30 transition-colors">
          <div className="absolute -top-8 -right-8 w-24 h-24 bg-amber-500/10 blur-2xl rounded-full" />
          <div className="relative flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>{t("pending_approvals_card")}</span>
            <CheckCircle2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="relative text-3xl font-bold text-amber-400 font-mono">
            {formatNumber(locale, stats.pendingHumanReviews)}
          </div>
          <div className="relative text-xs text-slate-400">{t("requires_human_signoff")}</div>
        </div>

        <div className="relative overflow-hidden p-5 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-2 group hover:border-emerald-500/30 transition-colors">
          <div className="absolute -top-8 -right-8 w-24 h-24 bg-emerald-500/10 blur-2xl rounded-full" />
          <div className="relative flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>{t("decisions_today")}</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="relative text-3xl font-bold text-slate-100 font-mono">{formatNumber(locale, stats.decisionsToday)}</div>
          <div className="relative text-xs text-slate-400">
            <span className="text-emerald-400 font-medium">{formatNumber(locale, stats.autoExecuted)}</span> {t("auto_executed", { count: String(stats.autoExecuted) })}
          </div>
        </div>

        <div className="relative overflow-hidden p-5 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-2 group hover:border-cyber-500/30 transition-colors">
          <div className="absolute -top-8 -right-8 w-24 h-24 bg-cyber-500/10 blur-2xl rounded-full" />
          <div className="relative flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>{t("avg_decision_latency")}</span>
            <Clock className="w-4 h-4 text-cyber-400" />
          </div>
          <div className="relative text-3xl font-bold text-slate-100 font-mono">{stats.avgLatencyMs}ms</div>
          <div className="relative text-xs text-slate-400">{t("including_context_inference")}</div>
        </div>
      </div>

      {/* Grid: Active Sessions & Risk Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Sessions List */}
        <div className="relative lg:col-span-2 overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-4">
          <div className="absolute inset-0 grid-overlay opacity-40 pointer-events-none" />
          <div className="relative flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-100">{t("active_sessions_list")}</h3>
            <span className="text-xs text-cyber-300 font-mono flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyber-400 animate-pulse" />
              {tCommon("live")}
            </span>
          </div>

          <div className="relative space-y-3">
            {allSessions
              .filter((s) => !["COMPLETED", "CANCELLED", "FAILED"].includes(s.state))
              .slice(0, 10)
              .map((s) => {
                const stateColor =
                  s.state === "AWAITING_USER_INPUT"
                    ? "bg-amber-950 text-amber-300 border-amber-800"
                    : s.state === "AWAITING_PLAN_APPROVAL"
                      ? "bg-purple-950 text-purple-300 border-purple-800"
                      : "bg-emerald-950 text-emerald-300 border-emerald-800";
                return (
                  <div
                    key={s.id}
                    className="p-4 bg-abyss/70 rounded-xl border border-white/5 flex items-center justify-between hover:border-jules-500/30 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-jules-300">{s.id}</span>
                        <span className="text-xs font-semibold text-slate-100">
                          {s.repository} ({s.branch})
                        </span>
                        <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${stateColor}`}>
                          {s.state}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 line-clamp-1">{s.prompt}</p>
                    </div>
                    <Link
                      href="/sessions"
                      className="text-xs text-jules-600 dark:text-jules-300 hover:text-jules-500 font-medium px-3 py-1.5 rounded bg-abyss border border-white/10"
                    >
                      {tCommon("inspect")}
                    </Link>
                  </div>
                );
              })}
            {allSessions.filter((s) => !["COMPLETED", "CANCELLED", "FAILED"].includes(s.state))
              .length === 0 && (
              <p className="text-xs text-slate-500">{tCommon("no_sessions_active")}</p>
            )}
          </div>
        </div>

        {/* Security & Risk Distribution */}
        <div className="relative overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-4">
          <div className="absolute -top-10 -right-10 w-32 h-32 bg-rose-500/5 blur-3xl rounded-full" />
          <div className="relative flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-100">{t("policy_risk_status")}</h3>
            <ShieldCheck className="w-4 h-4 text-jules-400" />
          </div>

          <div className="relative space-y-3 font-mono text-xs" id="risk-dist">
            <RiskStat label={t("low_risk_safe")} risk="low" db={db} />
            <RiskStat label={t("medium_risk_review")} risk="medium" db={db} />
            <RiskStat label={t("high_risk_escalated")} risk="high" db={db} />
            <RiskStat label={t("critical_vetoed")} risk="critical" db={db} />
          </div>

          <div className="relative pt-2 border-t border-white/5 text-xs text-slate-400">
            <p>
              {t("safety_gate_mode")}: <span className="text-amber-400 font-mono font-bold">{tCommon("dry_run")}</span>
            </p>
            <p className="mt-1">{t("mutations_suppressed")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

async function RiskStat({ label, risk, db }: { label: string; risk: string; db: ReturnType<typeof getDatabase> }) {
  let count = 0;
  try {
    const row = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(decisions)
      .where(sql`risk = ${risk}`);
    count = row[0]?.count ?? 0;
  } catch {
    count = 0;
  }
  const color = risk === "low" ? "text-emerald-400" : risk === "medium" ? "text-amber-400" : risk === "high" ? "text-rose-400" : "text-red-500";
  return (
    <div className="p-3 bg-abyss/70 rounded-lg border border-white/5 flex items-center justify-between">
      <span className={color}>{label}</span>
      <span className="text-slate-100 font-bold">{count}</span>
    </div>
  );
}
