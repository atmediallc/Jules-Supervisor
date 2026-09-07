import { getConfig } from "@jules/config";
import { getDatabase, SessionRepository, ActivityRepository } from "@jules/db";
import { getTranslations, getLocale } from "next-intl/server";
import { formatDateTime, formatNumber } from "@/lib/intl";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const t = await getTranslations("sessions");
  const locale = await getLocale();
  const config = getConfig();
  const db = getDatabase(config.DATABASE_URL);
  const sessionsRepo = new SessionRepository(db);
  const activityRepo = new ActivityRepository(db);

  let rows: Array<{
    id: string;
    repository: string;
    branch: string;
    prompt: string;
    state: string;
    supervisorStatus: string;
    cycleCount: number;
    createdAt: string;
    activities: Array<{ id: string; type: string; content: string; time: string }>;
  }> = [];

  try {
    const sessions = await sessionsRepo.list(50);
    rows = await Promise.all(
      sessions.map(async (session) => ({
        id: session.id,
        repository: session.repository,
        branch: session.branch,
        prompt: session.prompt,
        state: session.state,
        supervisorStatus: session.supervisorStatus,
        cycleCount: session.cycleCount,
        createdAt: session.createdAt.toISOString(),
        activities: (await activityRepo.listBySession(session.id, "desc")).slice(0, 10).map((a) => ({
          id: a.id,
          type: a.type,
          content: a.content ?? "",
          time: a.createdAt.toISOString(),
        })),
      })),
    );
  } catch (err) {
    console.warn("Database unavailable, rendering sessions with fallback empty list:", err);
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-jules-600/10 blur-3xl rounded-full" />
        <div className="relative flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">{t("title")}</h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("description")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {rows.map((session) => (
          <div
            key={session.id}
            className="relative overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-4 hover:border-jules-500/30 transition-colors"
          >
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-jules-600/5 blur-3xl rounded-full" />
            <div className="relative flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                  <span className="font-mono text-sm font-bold text-jules-300">{session.id}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-abyss text-slate-100 font-mono border border-white/10">
                    {session.repository} ({session.branch})
                  </span>
                  <span
                    className={`text-xs font-mono px-2.5 py-0.5 rounded border ${
                      session.state === "AWAITING_USER_INPUT"
                        ? "bg-amber-950 text-amber-300 border-amber-800"
                        : session.state === "AWAITING_PLAN_APPROVAL"
                          ? "bg-purple-950 text-purple-300 border-purple-800"
                          : "bg-emerald-950 text-emerald-300 border-emerald-800"
                    }`}
                  >
                    {session.state}
                  </span>
                </div>
                <p className="text-sm text-slate-100 font-medium mt-2">{session.prompt}</p>
              </div>
              <div className="text-left sm:text-right text-xs font-mono text-slate-400 shrink-0">
                <div>{t("cycles")}: {formatNumber(locale, session.cycleCount)}</div>
                <div>{formatDateTime(locale, session.createdAt)}</div>
              </div>
            </div>

            {/* Activities */}
            <div className="relative mt-4 pt-4 border-t border-white/5">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t("recent_activities")}
              </h4>
              <div className="space-y-2">
                {session.activities.map((act) => (
                  <div
                    key={act.id}
                    className="p-3 bg-abyss/70 rounded-lg border border-white/5 flex flex-col sm:flex-row sm:items-start justify-between gap-2"
                  >
                    <div>
                      <span className="text-xs font-mono text-jules-300">[{act.type}]</span>
                      <p className="text-xs text-slate-300 mt-1 whitespace-pre-wrap font-mono">
                        {act.content}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                      {formatDateTime(locale, act.time)}
                    </span>
                  </div>
                ))}
                {session.activities.length === 0 && (
                  <p className="text-xs text-slate-400">{t("no_activities")}</p>
                )}
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 text-sm text-slate-400">
            {t("no_sessions")}
          </div>
        )}
      </div>
    </div>
  );
}
