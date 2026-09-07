import Link from "next/link";
import { ShieldAlert, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-abyss flex items-center justify-center p-6 text-slate-100">
      <div className="relative max-w-md w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-8 text-center shadow-xl">
        <div className="absolute -top-16 -right-16 w-48 h-48 bg-jules-600/10 blur-3xl rounded-full" />
        <div className="flex justify-center mb-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-jules-500/10 ring-1 ring-jules-500/30 text-jules-600 dark:text-jules-400">
            <ShieldAlert className="w-8 h-8" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100 mb-2">
          404 — Route Not Found
        </h1>
        <p className="text-sm text-slate-400 mb-6 leading-relaxed">
          The requested control plane route or resource does not exist or has been decommissioned.
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-jules-600 to-cyber-600 hover:from-jules-500 hover:to-cyber-500 shadow-md transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Return to Control Plane
        </Link>
      </div>
    </div>
  );
}
