"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Plus,
  Clock,
  Fingerprint,
} from "lucide-react";

const PASSWORD_LENGTH = 20;
const PASSWORD_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";

function generatePassword(len = PASSWORD_LENGTH): string {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]).join("");
}

type SettingItem = {
  key: string;
  value: string;
  rawValue: string | null;
  category: string;
  isSecret: boolean;
  description: string;
  source: "database" | "environment" | "default";
};

const BANNED_KEYWORDS = [
  "jules",
  "supervisor",
  "password",
  "admin",
  "master",
  "clave",
  "secret",
  "123",
];

function scorePassword(pw: string): { score: number; label: string; color: string; bar: string } {
  if (pw.length < 8) {
    return { score: 0, label: "weak", color: "text-rose-400", bar: "bg-rose-500" };
  }
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (BANNED_KEYWORDS.some((k) => pw.toLowerCase().includes(k))) score = Math.min(score, 2);
  if (score >= 5) return { score, label: "strong", color: "text-emerald-400", bar: "bg-emerald-500" };
  if (score >= 3) return { score, label: "medium", color: "text-amber-400", bar: "bg-amber-500" };
  return { score, label: "weak", color: "text-rose-400", bar: "bg-rose-500" };
}

function maskValue(value: string): string {
  if (!value || value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

export default function AdminCredentialManager() {
  const t = useTranslations("settings.admin_credentials");
  const tSettings = useTranslations("settings");
  const [current, setCurrent] = useState<SettingItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const strength = scorePassword(draft);

  const fetchAdminKey = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = (await res.json()) as { settings: SettingItem[] };
      const item = data.settings.find((s) => s.key === "ADMIN_MASTER_KEY") ?? null;
      setCurrent(item);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAdminKey();
  }, [fetchAdminKey]);

  const configured = !!current && current.source !== "default" && !!current.value;

  const generate = () => {
    setDraft(generatePassword());
    setCopied(false);
  };

  const copy = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    inputRef.current?.select();
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: [{ key: "ADMIN_MASTER_KEY", value: draft }] }),
      });
      if (!res.ok) throw new Error(t("failed_to_save"));
      setMessage({ type: "success", text: t("saved_message") });
      setDraft("");
      setMode("view");
      await fetchAdminKey();
    } catch (err: unknown) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("failed_to_save") });
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setDeleting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/settings?key=ADMIN_MASTER_KEY`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(t("failed_to_save"));
      setMessage({ type: "success", text: t("removed_message") });
      setMode("view");
      setDraft("");
      await fetchAdminKey();
    } catch (err: unknown) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : t("failed_to_save") });
    } finally {
      setDeleting(false);
    }
  };

  const handleClear = async () => {
    const ok = window.confirm(t("confirm_remove"));
    if (!ok) return;
    await clear();
  };

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-panel via-abyss-soft to-abyss border border-white/10 shadow-xl shadow-black/20">
      {/* Glow accent */}
      <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-jules-600/10 blur-3xl" />

      {/* Header */}
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-white/5 bg-abyss/40">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-jules-500/10 ring-1 ring-jules-500/30">
            <KeyRound className="h-5 w-5 text-jules-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-100">{t("title")}</span>
              {configured ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-800/70 font-mono text-[10px] font-semibold tracking-wide">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  {t("configured_badge")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-800/80 text-slate-400 border border-slate-700/80 font-mono text-[10px] font-semibold tracking-wide">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                  {t("absent_badge")}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {configured ? t("subtitle_configured") : t("subtitle_absent")}
            </p>
          </div>
        </div>
        {configured && mode === "view" && (
          <button
            onClick={() => setMode("edit")}
            className="group inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white rounded-lg bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 shadow-lg shadow-jules-900/40 transition-all hover:shadow-jules-800/40 active:scale-[0.98]"
          >
            <RefreshCw className="w-3.5 h-3.5 transition-transform group-hover:rotate-180 duration-300" />
            {t("change_key")}
          </button>
        )}
      </div>

      <div className="relative p-6">
        {/* Status message */}
        {message && (
          <div
            className={`mb-4 p-3 rounded-xl border text-xs font-mono flex items-center gap-2 ${
              message.type === "success"
                ? "bg-emerald-950/60 border-emerald-800/70 text-emerald-300"
                : "bg-rose-950/60 border-rose-800/70 text-rose-300"
            }`}
          >
            {message.type === "success" ? (
              <Check className="w-4 h-4 shrink-0" />
            ) : (
              <span className="shrink-0">⚠</span>
            )}
            {message.text}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-jules-400" />
          </div>
        ) : (
          <>
            {/* ── View mode: credential vault card ── */}
            {mode === "view" && configured && (
              <div className="rounded-xl border border-white/10 bg-abyss/60 p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30">
                      <ShieldCheck className="h-4.5 w-4.5 text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono text-sm tracking-widest text-slate-300"
                        >
                          {maskValue(current?.value ?? "")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-800/80 text-[10px] text-slate-400 font-mono">
                          <Clock className="w-3 h-3 text-slate-500" />
                          {t("source_label")}:{" "}
                          <span
                            className={
                              current?.source === "database"
                                ? "text-emerald-400"
                                : current?.source === "environment"
                                  ? "text-sky-400"
                                  : "text-slate-400"
                            }
                          >
                            {tSettings(`sources.${current!.source}`)}
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-jules-950/60 text-[10px] text-jules-300 font-mono border border-jules-800/50">
                          <KeyRound className="w-3 h-3" />
                          {current?.key}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={handleClear}
                      disabled={deleting}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-rose-300 bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/60 transition-colors disabled:opacity-40"
                    >
                      {deleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      {deleting ? t("removing") : t("remove_key")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Empty state when absent ── */}
            {mode === "view" && !configured && (
              <div className="flex flex-col items-center justify-center text-center py-8 sm:py-10">
                <div className="mb-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800/60 ring-1 ring-slate-700/60">
                    <KeyRound className="h-6 w-6 text-slate-500" />
                  </div>
                </div>
                <h3 className="text-sm font-semibold text-slate-200">{t("absent_description")}</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">{t("absent_hint")}</p>
                <button
                  onClick={() => setMode("edit")}
                  className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white rounded-lg bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 shadow-lg shadow-jules-900/40 transition-all hover:shadow-jules-800/40 active:scale-[0.98]"
                >
                  <Plus className="w-4 h-4" />
                  {t("create_key")}
                </button>
              </div>
            )}

            {/* ── Edit / create form ── */}
            {mode === "edit" && (
              <div className="rounded-xl border border-jules-900/50 bg-jules-950/10 p-4 sm:p-5">
                <div className="flex items-center gap-2 mb-4">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-jules-500/10 ring-1 ring-jules-500/30">
                    <Fingerprint className="h-4 w-4 text-jules-400" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">
                    {configured ? t("new_key_label") : t("create_key_label")}
                  </span>
                </div>

                <div className="flex gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setCopied(false);
                    }}
                    placeholder={t("generate_hint")}
                    className="flex-1 min-w-0 font-mono text-xs text-emerald-300 bg-abyss px-3 py-2.5 rounded-lg border border-white/10 focus:outline-none focus:border-jules-500 focus:ring-2 focus:ring-jules-500/20 placeholder:text-slate-600 transition-all"
                  />
                  <button
                    onClick={generate}
                    title={t("generate")}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg bg-abyss hover:bg-panel text-slate-300 border border-white/10 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t("generate")}
                  </button>
                  <button
                    onClick={copy}
                    disabled={!draft}
                    title={t("copy")}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg bg-abyss hover:bg-panel text-slate-300 border border-white/10 transition-colors disabled:opacity-40"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {t("copy")}
                  </button>
                </div>

                {/* Strength meter */}
                {draft && (
                  <div className="mt-4">
                    <div className="flex items-center gap-2 h-2">
                      <div className="flex gap-1 flex-1 h-full">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <div
                            key={i}
                            className={`h-full flex-1 rounded-full transition-all duration-300 ${
                              i < strength.score ? strength.bar : "bg-slate-800"
                            }`}
                          />
                        ))}
                      </div>
                      <span className={`text-[10px] font-mono uppercase tracking-wider ${strength.color}`}>
                        {t(`strength.${strength.label}`)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-4">
                  <button
                    onClick={save}
                    disabled={!draft || saving}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white rounded-lg bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 shadow-lg shadow-jules-900/40 transition-all disabled:saturate-[0.55] disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {saving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    )}
                    {saving ? t("saving") : configured ? t("save_new") : t("save_key")}
                  </button>
                  <button
                    onClick={() => {
                      setMode("view");
                      setDraft("");
                    }}
                    className="px-4 py-2.5 text-xs font-medium rounded-lg text-slate-300 bg-abyss hover:bg-panel border border-white/10 transition-colors"
                  >
                    {t("cancel")}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}