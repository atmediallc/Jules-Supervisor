"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, ArrowLeft } from "lucide-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6 text-slate-100">
      <div className="relative max-w-lg w-full overflow-hidden rounded-2xl border border-rose-500/20 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-8 text-center shadow-xl">
        <div className="absolute -top-16 -right-16 w-48 h-48 bg-rose-500/10 blur-3xl rounded-full" />
        <div className="flex justify-center mb-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 ring-1 ring-rose-500/30 text-rose-500">
            <AlertTriangle className="w-8 h-8" />
          </div>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-100 mb-2">
          Control Plane Error
        </h2>
        <p className="text-sm text-slate-400 mb-4 leading-relaxed">
          An unexpected error occurred while processing this supervisory view.
        </p>
        {error.message && (
          <div className="p-3 mb-6 rounded-lg bg-abyss border border-white/10 text-left font-mono text-xs text-rose-400 break-words max-h-32 overflow-y-auto">
            {error.message}
          </div>
        )}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 shadow-md transition-all cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" /> Try Again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-2.5 rounded-lg text-xs font-medium text-slate-200 bg-abyss hover:bg-panel border border-white/10 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Return to Overview
          </Link>
        </div>
      </div>
    </div>
  );
}
