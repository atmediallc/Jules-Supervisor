import { getConfig } from "@jules/config";
import { getDatabase, policies, sql } from "@jules/db";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const t = await getTranslations("policies");
  const config = getConfig();
  let policyRules: Array<{
    name: string;
    type: string;
    status: string;
    description: string;
    target: string;
  }> = [];

  try {
    const db = getDatabase(config.DATABASE_URL);
    const rows = await db
      .select({
        id: policies.id,
        name: policies.name,
        version: policies.version,
        description: policies.description,
        rules: policies.rules,
        enabled: policies.enabled,
      })
      .from(policies)
      .orderBy(sql`name asc`);

    policyRules = rows.map((p) => {
      const rules = (p.rules ?? {}) as Record<string, unknown>;
      return {
        name: p.name,
        type: (rules.ruleType as string) ?? "POLICY",
        status: p.enabled ? "ACTIVE" : "DISABLED",
        description: p.description ?? "",
        target: (rules.target as string) ?? `v${p.version}`,
      };
    });
  } catch (err) {
    console.warn("Database unavailable, rendering policies with fallback empty list:", err);
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-cyber-600/10 blur-3xl rounded-full" />
        <div className="relative">
          <h2 className="text-2xl font-bold tracking-tight text-slate-100">{t("title")}</h2>
          <p className="text-sm text-slate-400 mt-1">
            {t("description")}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {policyRules.map((rule) => (
          <div
            key={rule.name}
            className="relative overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-3 hover:border-cyber-500/30 transition-colors"
          >
            <div className="absolute -top-8 -right-8 w-24 h-24 bg-cyber-500/5 blur-2xl rounded-full" />
            <div className="relative flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-100">{rule.name}</span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                  rule.type === "HARD_VETO"
                    ? "bg-rose-950 text-rose-300 border-rose-800"
                    : "bg-amber-950 text-amber-300 border-amber-800"
                }`}
              >
                {rule.type}
              </span>
            </div>
            <p className="relative text-xs text-slate-300 leading-relaxed">{rule.description}</p>
            <div className="relative pt-2 border-t border-white/5 text-[11px] font-mono text-slate-400 flex items-center justify-between">
              <span>{t("target")}: {rule.target}</span>
              <span className="text-emerald-400 font-semibold">{rule.status}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
