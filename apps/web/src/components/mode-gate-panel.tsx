"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Radio, ShieldAlert, ShieldCheck, Zap } from "lucide-react";

interface RuntimeStatus {
  supervisorMode: string;
  safetyState: string;
  reloadPending: boolean;
  workerOnline: boolean;
}

/** Sidebar panel: supervisor execution mode + safety gate readout with live runtime synchronization (R04) */
export function ModeGatePanel() {
  const t = useTranslations("common");
  const [status, setStatus] = useState<RuntimeStatus>({
    supervisorMode: "DRY_RUN",
    safetyState: "RUNNING",
    reloadPending: false,
    workerOnline: true,
  });

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/runtime/status");
        if (res.ok && mounted) {
          const data = await res.json();
          setStatus({
            supervisorMode: data.supervisorMode ?? "DRY_RUN",
            safetyState: data.safetyState ?? "RUNNING",
            reloadPending: !!data.reloadPending,
            workerOnline: !!data.workerOnline,
          });
        }
      } catch {
        // preserve current
      }
    };

    fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const isPaused = status.safetyState !== "RUNNING";
  const modeColor =
    status.supervisorMode === "FULL_AUTO"
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : status.supervisorMode === "DISABLED"
        ? "text-red-400 border-red-500/30 bg-red-500/10"
        : "text-amber-400 border-amber-500/30 bg-amber-500/10";

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-panel to-abyss-soft p-3.5 text-xs font-mono">
      <div className="absolute -top-6 -right-6 w-16 h-16 bg-jules-600/10 blur-2xl rounded-full" />

      {/* Mode readout */}
      <div className="relative flex items-center justify-between text-slate-400 mb-2">
        <span className="flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-jules-400" />
          {t("mode")}
        </span>
        <span className={`font-semibold tracking-wider border px-1.5 py-0.5 rounded ${modeColor}`}>
          {status.reloadPending ? "SYNCING..." : status.supervisorMode}
        </span>
      </div>

      {/* Safety Gate readout */}
      <div className="relative flex items-center justify-between text-slate-400 mb-2">
        <span className="flex items-center gap-1.5">
          {isPaused ? (
            <ShieldAlert className="w-3 h-3 text-red-400" />
          ) : (
            <ShieldCheck className="w-3 h-3 text-emerald-400" />
          )}
          {t("gate")}
        </span>
        <span
          className={`font-semibold tracking-wider border px-1.5 py-0.5 rounded ${
            isPaused
              ? "text-red-400 border-red-500/30 bg-red-500/10"
              : "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
          }`}
        >
          {status.safetyState === "RUNNING" ? t("enforced") : status.safetyState}
        </span>
      </div>

      {/* Worker connectivity readout */}
      <div className="relative flex items-center justify-between text-slate-400 text-[11px]">
        <span className="flex items-center gap-1.5">
          <Radio className={`w-3 h-3 ${status.workerOnline ? "text-emerald-400 animate-pulse" : "text-amber-400"}`} />
          Daemon
        </span>
        <span className={status.workerOnline ? "text-emerald-400" : "text-amber-400"}>
          {status.workerOnline ? "ONLINE" : "OFFLINE"}
        </span>
      </div>
    </div>
  );
}