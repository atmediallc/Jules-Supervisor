"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";

export type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "jules-theme";

function getStoredSetting(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function resolveEffectiveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(mode: ThemeMode) {
  const effective = resolveEffectiveTheme(mode);
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themeSetting = mode;
  document.documentElement.classList.toggle("dark", effective === "dark");
}

const BUTTONS = [
  { mode: "light" as const, label: "Light", title: "Light theme", aria: "Switch to light theme", icon: Sun },
  { mode: "dark" as const, label: "Dark", title: "Dark theme", aria: "Switch to dark theme", icon: Moon },
  { mode: "system" as const, label: "Auto", title: "System theme", aria: "Use system color theme", icon: Monitor },
];

/**
 * Header toggle: Light / Dark / System theme switcher.
 * Persists to localStorage, honours OS preference dynamically when set to System,
 * and maintains full WCAG focus indicators and accessibility.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = getStoredSetting();
    setMode(initial);
    applyTheme(initial);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || mode !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => {
      const effective = e.matches ? "light" : "dark";
      document.documentElement.dataset.theme = effective;
      document.documentElement.classList.toggle("dark", effective === "dark");
    };

    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [mode, mounted]);

  const selectMode = (newMode: ThemeMode) => {
    setMode(newMode);
    applyTheme(newMode);
    localStorage.setItem(THEME_KEY, newMode);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Color theme selection"
      className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-slate-700/60 bg-slate-900/60 text-slate-400 font-mono text-[10px]"
    >
      {BUTTONS.map(({ mode: btnMode, label, title, aria, icon: Icon }) => (
        <button
          key={btnMode}
          type="button"
          role="radio"
          aria-checked={mode === btnMode}
          onClick={() => selectMode(btnMode)}
          title={title}
          aria-label={aria}
          className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all cursor-pointer ${
            mode === btnMode
              ? "bg-jules-600 text-white shadow-sm font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
