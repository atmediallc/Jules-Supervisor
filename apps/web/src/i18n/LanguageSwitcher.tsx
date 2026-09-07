"use client";

import { useI18n } from "./provider";
import { Globe } from "lucide-react";

const LABELS: Record<string, string> = {
  en: "EN",
  es: "ES",
};

export default function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  return (
    <div className="flex items-center gap-1 p-0.5 rounded-lg border border-slate-700/60 bg-slate-900/60 font-mono text-[10px]" role="group" aria-label="Language selection">
      <Globe className="w-3.5 h-3.5 text-slate-400 ml-1" aria-hidden="true" />
      {(["en", "es"] as const).map((loc) => (
        <button
          key={loc}
          type="button"
          onClick={() => setLocale(loc)}
          aria-label={`Switch language to ${LABELS[loc]}`}
          aria-pressed={locale === loc}
          className={`px-1.5 py-0.5 rounded transition-all cursor-pointer ${
            locale === loc
              ? "bg-jules-600 text-white font-semibold shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
          }`}
        >
          {LABELS[loc]}
        </button>
      ))}
    </div>
  );
}
