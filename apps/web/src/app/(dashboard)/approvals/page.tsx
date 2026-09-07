"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, XCircle, Edit3 } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { formatDateTime } from "@/lib/intl";

interface ApprovalItem {
  id: string;
  sessionId: string;
  action: string;
  risk: "low" | "medium" | "high" | "critical";
  confidence: number;
  reason: string;
  proposedResponse: string;
  createdAt: string;
}

export default function ApprovalsPage() {
  const t = useTranslations("approvals");
  const tConnection = useTranslations("login");
  const { locale } = useI18n();
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);

  useEffect(() => {
    fetch("/api/approvals")
      .then((res) => (res.ok ? res.json() : { approvals: [] }))
      .then((data) => {
        const list = (data.approvals ?? []) as ApprovalItem[];
        setApprovals(list);
      })
      .catch(() => setApprovals([]));
  }, []);

  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState<Record<string, string>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);

  const handleAction = async (id: string, action: "APPROVED" | "REJECTED" | "EDITED") => {
    if (submittingId) return; // Prevent double submission
    setSubmittingId(id);
    setActionFailed(false);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: action,
          reviewer: "human-admin",
          modifiedResponse: editedText[id],
        }),
      });
      if (!response.ok) throw new Error("Approval request failed");

      setApprovals((prev) => prev.filter((item) => item.id !== id));
      setEditingId(null);
      setActionMessage(t("action_success", { id, action }));
      setTimeout(() => setActionMessage(null), 4000);
    } catch {
      // Preserve the pending item and any operator edits until the backend
      // confirms the transition. A failed request is never a successful vote.
      setActionFailed(true);
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-amber-500/10 blur-3xl rounded-full" />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-100">{t("title")}</h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("description")}
            </p>
          </div>
          <span className="px-3 py-1 bg-amber-950 text-amber-300 border border-amber-800 text-xs font-mono rounded-md shrink-0">
            {t("pending_actions", { count: String(approvals.length) })}
          </span>
        </div>
      </div>

      {actionFailed && (
        <div role="alert" className="p-3 bg-rose-950/80 border border-rose-800 text-rose-300 text-xs font-mono rounded-lg">
          {tConnection("error_unreachable")}
        </div>
      )}

      {actionMessage && (
        <div className="p-3 bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-xs font-mono rounded-lg">
          {actionMessage}
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="p-12 text-center bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-2">
          <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
          <h3 className="text-base font-semibold text-slate-100">{t("queue_empty")}</h3>
          <p className="text-xs text-slate-400">{t("queue_empty_description")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((item) => (
            <div
              key={item.id}
              className="relative overflow-hidden p-6 bg-gradient-to-br from-panel to-abyss-soft rounded-2xl border border-white/10 space-y-4 hover:border-amber-500/30 transition-colors"
            >
              <div className="absolute -top-10 -right-10 w-40 h-40 bg-amber-500/5 blur-3xl rounded-full" />
              <div className="relative flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-bold text-amber-400">{item.id}</span>
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-abyss text-slate-100 border border-white/10">
                      {t("session")}: {item.sessionId}
                    </span>
                    <span
                      className={`text-xs font-mono px-2 py-0.5 rounded border ${
                        item.risk === "critical"
                          ? "bg-red-950 text-red-300 border-red-800"
                          : item.risk === "high"
                            ? "bg-rose-950 text-rose-300 border-rose-800"
                            : "bg-amber-950 text-amber-300 border-amber-800"
                      }`}
                    >
                      {item.risk.toUpperCase()} {t("risk")}
                    </span>
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-jules-950 text-jules-300 border border-jules-800">
                      {t("action")}: {item.action}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 font-mono mt-1">
                    {t("confidence")}: {(item.confidence * 100).toFixed(0)}% — {item.reason}
                  </p>
                </div>
                <span className="text-[10px] font-mono text-slate-400 shrink-0">{formatDateTime(locale, item.createdAt)}</span>
              </div>

              {/* Proposed Response Box */}
              <div className="relative p-4 bg-abyss rounded-xl border border-white/10">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                  <span>{t("proposed_response")}</span>
                  {editingId !== item.id && (
                    <button
                      onClick={() => {
                        setEditingId(item.id);
                        setEditedText({ ...editedText, [item.id]: item.proposedResponse });
                      }}
                      className="flex items-center gap-1 text-[11px] text-jules-600 dark:text-jules-300 hover:underline cursor-pointer"
                    >
                      <Edit3 className="w-3 h-3" /> {t("edit_response")}
                    </button>
                  )}
                </div>

                {editingId === item.id ? (
                  <div className="space-y-2 mt-2">
                    <textarea
                      value={editedText[item.id] ?? item.proposedResponse}
                      onChange={(e) => setEditedText({ ...editedText, [item.id]: e.target.value })}
                      className="w-full h-24 p-3 bg-abyss-soft text-xs font-mono text-slate-100 rounded border border-jules-600 dark:border-jules-700 focus:outline-none focus:ring-1 focus:ring-jules-500"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1 text-xs text-slate-400 hover:text-slate-100 cursor-pointer"
                      >
                        {t("cancel")}
                      </button>
                      <button
                        onClick={() => handleAction(item.id, "EDITED")}
                        disabled={submittingId === item.id}
                        className="px-3 py-1 text-xs bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 text-white rounded font-medium cursor-pointer"
                      >
                        {t("save_send_edited")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs font-mono text-slate-200 whitespace-pre-wrap">
                    {item.proposedResponse}
                  </p>
                )}
              </div>

              {/* Action Buttons */}
              {editingId !== item.id && (
                <div className="relative flex items-center justify-end gap-3 pt-2">
                  <button
                    onClick={() => handleAction(item.id, "REJECTED")}
                    disabled={submittingId === item.id}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800 text-xs font-semibold tracking-wide disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <XCircle className="w-4 h-4" />
                    {t("reject_action")}
                  </button>

                  <button
                    onClick={() => handleAction(item.id, "APPROVED")}
                    disabled={submittingId === item.id}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold tracking-wide disabled:opacity-50 transition-all shadow-[0_8px_20px_-8px_rgba(16,185,129,0.7)] cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {t("approve_dispatch")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
