"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import AdminCredentialManager from "@/components/admin-credential-manager";
import {
  Sliders,
  Save,
  RefreshCw,
  Eye,
  EyeOff,
  Shield,
  Cpu,
  Wallet,
  Database,
  Brain,
  Server,
  ChevronDown,
  ChevronRight,
  Check,
  AlertTriangle,
} from "lucide-react";

interface SettingItem {
  key: string;
  value: string;
  rawValue: string | null;
  category: string;
  isSecret: boolean;
  description: string;
  source: "database" | "environment" | "default";
}

const CATEGORY_META: Record<
  string,
  { label: string; icon: typeof Sliders; color: string }
> = {
  execution: { label: "Execution & Safety", icon: Shield, color: "text-amber-400" },
  budget: { label: "Budget Engine", icon: Wallet, color: "text-emerald-400" },
  ai: { label: "AI Provider", icon: Brain, color: "text-indigo-400" },
  jules: { label: "Google Jules API", icon: Cpu, color: "text-sky-400" },
  memory: { label: "Memory & Knowledge", icon: Database, color: "text-purple-400" },
  infrastructure: { label: "Infrastructure", icon: Server, color: "text-rose-400" },
};

const SOURCE_BADGE: Record<string, { className: string }> = {
  database: {
    className: "bg-emerald-950 text-emerald-300 border-emerald-800",
  },
  environment: {
    className: "bg-sky-950 text-sky-300 border-sky-800",
  },
  default: {
    className: "bg-slate-800 text-slate-400 border-slate-700",
  },
};

async function loadSettingsFromApi(): Promise<SettingItem[]> {
  const res = await fetch("/api/settings");
  const data = await res.json();
  return (data.settings as SettingItem[]) ?? [];
}

async function loadModelsFromApi(): Promise<string[]> {
  try {
    const res = await fetch("/api/settings/models", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models as string[]) ?? [];
  } catch {
    return [];
  }
}

const MODEL_LISTABLE_TYPES = new Set(["endpoint", "omniroute", "openai", "openai-compatible", "generic"]);

export default function SettingsPage() {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadSettingsFromApi();
      setSettings(data);
    } catch {
      setMessage({ type: "error", text: t("failed_to_load") });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Load available models whenever the provider type is one that can list them.
  const providerTypeSetting = settings.find((s) => s.key === "AI_PROVIDER_TYPE");
  const providerType =
    (edits.AI_PROVIDER_TYPE ?? providerTypeSetting?.rawValue ?? providerTypeSetting?.value) ?? "";
  const canListModels = MODEL_LISTABLE_TYPES.has(providerType);

  useEffect(() => {
    if (!canListModels) {
      setAvailableModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    loadModelsFromApi().then((models) => {
      if (!cancelled) {
        setAvailableModels(models);
        setModelsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canListModels]);

  const grouped = settings.reduce<Record<string, SettingItem[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  const changedCount = Object.keys(edits).length;

  const handleSave = async () => {
    if (changedCount === 0) return;
    setSaving(true);
    setMessage(null);

    const payload = Object.entries(edits).map(([key, value]) => ({ key, value }));

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? t("failed_to_save"));
      }

      setMessage({ type: "success", text: t("settings_updated", { count: String(changedCount) }) });
      setEdits({});
      await fetchSettings();
    } catch (err: unknown) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : t("failed_to_save"),
      });
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 5000);
    }
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const toggleSecretReveal = (key: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-jules-600/10 blur-3xl rounded-full" />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">
              {t("title")}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("description")}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={fetchSettings}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 bg-abyss hover:bg-panel border border-white/10 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              {tCommon("refresh")}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || changedCount === 0}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 rounded-lg transition-all shadow-[0_8px_24px_-8px_rgba(59,130,246,0.8)] disabled:saturate-[0.55] disabled:cursor-not-allowed disabled:shadow-none cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? t("saving") : `${t("save_changes")}${changedCount > 0 ? ` (${changedCount})` : ""}`}
            </button>
          </div>
        </div>
      </div>

      {/* Status Messages */}
      {message && (
        <div
          className={`p-3 rounded-lg border text-xs font-mono flex items-center gap-2 ${
            message.type === "success"
              ? "bg-emerald-950/80 border-emerald-800 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.5)]"
              : "bg-rose-950/80 border-rose-800 text-rose-300 shadow-[0_0_16px_-6px_rgba(239,68,68,0.5)]"
          }`}
        >
          {message.type === "success" ? (
            <Check className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {/* Admin Credentials & Master Key */}
      <AdminCredentialManager />

      {/* Loading State */}
      {loading && settings.length === 0 ? (
        <div className="p-12 text-center bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10">
          <RefreshCw className="w-6 h-6 text-jules-400 mx-auto animate-spin" />
          <p className="text-sm text-slate-400 mt-3">{t("loading_settings")}</p>
        </div>
      ) : (
        /* Settings by Category */
        Object.entries(CATEGORY_META).map(([cat, meta]) => {
          const items = grouped[cat];
          if (!items?.length) return null;
          const Icon = meta.icon;
          const collapsed = collapsedCategories.has(cat);

          return (
            <div
              key={cat}
              className="relative overflow-hidden bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10"
            >
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-white/[0.03] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <span className={`p-1.5 rounded-lg bg-abyss border border-white/5 ${meta.color}`}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="text-sm font-bold text-slate-100">{t(`categories.${cat}`)}</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {tCommon("setting_count", { count: items.length })}
                  </span>
                </div>
                {collapsed ? (
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </button>

              {/* Settings List */}
              {!collapsed && (
                <div className="divide-y divide-white/5">
                  {items.map((item) => {
                    const isEditing = item.key in edits;
                    // Revealed secrets show the real value (rawValue) instead of the masked one.
                    const displayValue = isEditing
                      ? edits[item.key]
                      : item.isSecret && revealedSecrets.has(item.key)
                        ? (item.rawValue ?? item.value)
                        : item.value;
                    const badge = SOURCE_BADGE[item.source];

                    return (
                      <div
                        key={item.key}
                        className={`px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                          isEditing ? "bg-jules-500/[0.06]" : ""
                        }`}
                      >
                        {/* Label & Description */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-slate-100 font-mono">
                              {item.key}
                            </span>
                            {item.isSecret && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-rose-950 text-rose-300 border border-rose-800 rounded font-mono">
                                {t("secret_label")}
                              </span>
                            )}
                            <span
                              className={`text-[9px] px-1.5 py-0.5 border rounded font-mono ${badge?.className ?? "bg-slate-800 text-slate-400 border-slate-700"}`}
                            >
                              {badge ? t(`sources.${item.source}`) : t("unknown_source")}
                            </span>
                            {isEditing && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-indigo-950 text-indigo-300 border border-indigo-800 rounded font-mono">
                                {t("modified_label")}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                            {item.description}
                          </p>
                        </div>

                        {/* Value / Input */}
                        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-start sm:justify-end">
                          {item.isSecret && !revealedSecrets.has(item.key) ? (
                            // Secret: show masked + reveal toggle
                            <>
                              <span className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 min-w-40 text-center">
                                {displayValue}
                              </span>
                              <button
                                onClick={() => toggleSecretReveal(item.key)}
                                className="p-1.5 text-slate-400 hover:text-jules-500 transition-colors cursor-pointer"
                                title={t("reveal_secret")}
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : item.isSecret && revealedSecrets.has(item.key) ? (
                            // Secret revealed: show input
                            <>
                              <input
                                type="text"
                                value={displayValue}
                                onChange={(e) =>
                                  setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                                }
                                className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-jules-800 min-w-50 focus:outline-none focus:border-jules-500"
                                placeholder={t("enter_api_key")}
                              />
                              <button
                                onClick={() => toggleSecretReveal(item.key)}
                                className="p-1.5 text-slate-400 hover:text-jules-500 transition-colors cursor-pointer"
                                title={t("hide_secret")}
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : item.key === "SUPERVISOR_MODE" ? (
                            // Enum field: dropdown
                            <select
                              value={displayValue}
                              onChange={(e) =>
                                setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                              }
                              className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 focus:outline-none focus:border-jules-500 cursor-pointer w-full sm:w-auto"
                            >
                              {["DISABLED", "DRY_RUN", "ASSISTED", "AUTO_RESPOND", "FULL_AUTO"].map(
                                (opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : item.key === "AI_PROVIDER_TYPE" ? (
                            <select
                              value={displayValue}
                              onChange={(e) =>
                                setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                              }
                              className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 focus:outline-none focus:border-jules-500 cursor-pointer w-full sm:w-auto"
                            >
                              {["endpoint", "omniroute", "mock"].map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          ) : item.key === "AI_MODEL" && canListModels ? (
                            // Model picker: free-text input with autocomplete over every
                            // model the provider exposes. Falls back to plain input when
                            // none can be listed.
                            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                              <input
                                type="text"
                                list="available-models"
                                value={displayValue ?? ""}
                                onChange={(e) =>
                                  setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                                }
                                className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 w-full sm:w-45 focus:outline-none focus:border-jules-500"
                                placeholder={modelsLoading ? t("loading_models") : t("search_model")}
                              />
                              {!modelsLoading && availableModels.length > 0 && (
                                <datalist id="available-models">
                                  {availableModels.map((m) => (
                                    <option key={m} value={m} />
                                  ))}
                                </datalist>
                              )}
                            </div>
                          ) : item.key.endsWith("_ENABLED") || item.key.startsWith("ALLOW_") ? (
                            // Boolean toggle
                            <select
                              value={displayValue}
                              onChange={(e) =>
                                setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                              }
                              className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 focus:outline-none focus:border-jules-500 cursor-pointer w-full sm:w-auto"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : (
                            // Default: text input
                            <input
                              type="text"
                              value={displayValue}
                              onChange={(e) =>
                                setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))
                              }
                              className="font-mono text-xs text-jules-600 dark:text-jules-300 bg-abyss px-3 py-1.5 rounded-lg border border-white/10 w-full sm:w-45 focus:outline-none focus:border-jules-500"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
