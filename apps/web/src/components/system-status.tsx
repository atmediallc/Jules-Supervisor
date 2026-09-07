"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

const POLL_MS = 15_000;
const PASSWORD_LENGTH = 20;
const PASSWORD_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";

type ReadyStatus = {
  status: string;
  mode: string;
  provider: string;
} | null;

type SettingItem = {
  key: string;
  value: string;
  rawValue: string | null;
  category: string;
  isSecret: boolean;
  description: string;
  source: "database" | "environment" | "default";
};

function generatePassword(len = PASSWORD_LENGTH): string {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]).join("");
}

const CREDENTIAL_KEYS = ["AI_API_KEY", "JULES_API_KEY", "SESSION_SECRET", "ADMIN_MASTER_KEY"];

/** Header badges: live AI / Data connectivity status */
export function SystemStatusBadges() {
  const t = useTranslations("common");
  const [status, setStatus] = useState<ReadyStatus>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/ready", { cache: "no-store" });
      const data = (await res.json()) as ReadyStatus;
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  const online = status?.status === "ready";
  const provider = status?.provider ?? "";

  const badgeClass = online
    ? "bg-emerald-950/60 text-emerald-300 border-emerald-800/80 shadow-[0_0_12px_-4px_rgba(16,185,129,0.5)]"
    : "bg-red-950/60 text-red-300 border-red-800/80 shadow-[0_0_12px_-4px_rgba(239,68,68,0.5)]";
  const dotClass = online ? "bg-emerald-400 animate-pulse" : "bg-red-400";

  return (
    <>
      <span
        title={provider || "AI"}
        className={`px-2.5 py-1 rounded-md border flex items-center gap-1.5 backdrop-blur ${badgeClass}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        {t("ai_label")} {online ? t("online") : t("offline")}
      </span>
      <span className={`px-2.5 py-1 rounded-md border flex items-center gap-1.5 backdrop-blur ${badgeClass}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        {t("data_label")} {online ? t("online") : t("offline")}
      </span>
    </>
  );
}

/** Sidebar panel: credential health + secure password generator */
export function CredentialsPanel() {
  const t = useTranslations("common");
  const [settings, setSettings] = useState<Record<string, SettingItem>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { settings: SettingItem[] };
      setSettings(Object.fromEntries(data.settings.map((s) => [s.key, s])));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const generate = () => {
    setDraft(generatePassword());
    setCopied(false);
    setSaved(false);
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
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: [{ key: "ADMIN_MASTER_KEY", value: draft }] }),
      });
      if (!res.ok) throw new Error("save failed");
      setSaved(true);
      setDraft("");
      await fetchSettings();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono mb-2">
        <KeyRound className="w-3 h-3 text-indigo-400" />
        {t("credentials")}
      </div>

      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-500 mx-auto" />
      ) : (
        <div className="space-y-1.5 mb-3">
          {CREDENTIAL_KEYS.map((key) => {
            const item = settings[key];
            const configured = !!item && item.source !== "default" && !!item.value;
            return (
              <div key={key} className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300 truncate mr-2">{item?.description ?? key}</span>
                <span
                  className={`flex items-center gap-1 font-mono shrink-0 ${
                    configured ? "text-emerald-400" : "text-slate-500"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      configured ? "bg-emerald-400" : "bg-slate-600"
                    }`}
                  />
                  {configured ? t("configured") : t("absent")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-slate-800/80 pt-2 space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
          <ShieldCheck className="w-3 h-3 text-emerald-400" />
          {t("password_generator")}
        </div>
        <div className="flex gap-1">
          <input
            ref={inputRef}
            readOnly
            value={draft}
            placeholder={t("generate_hint")}
            className="flex-1 min-w-0 bg-slate-900/80 border border-slate-700 rounded px-2 py-1 font-mono text-[11px] text-emerald-300 placeholder:text-slate-600"
          />
          <button
            onClick={generate}
            title={t("generate")}
            aria-label={t("generate")}
            className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={copy}
            disabled={!draft}
            title={t("copy")}
            aria-label={t("copy")}
            className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors disabled:opacity-40 cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        <button
          onClick={save}
          disabled={!draft || saving}
          className="w-full py-1.5 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-40 shadow-sm cursor-pointer"
        >
          {saving ? t("saving") : saved ? t("saved") : t("save_as_admin")}
        </button>
      </div>
    </div>
  );
}