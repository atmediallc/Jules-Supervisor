import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Theme System & Token Architecture", () => {
  const cssPath = resolve(__dirname, "../app/globals.css");
  const css = readFileSync(cssPath, "utf-8");

  it("defines dark theme base tokens in @theme and :root", () => {
    expect(css).toContain("--color-abyss:");
    expect(css).toContain("--color-panel:");
    expect(css).toContain("--color-panel-2:");
    expect(css).toContain("--color-on-accent:");
    expect(css).toContain("color-scheme: dark;");
  });

  it("defines complete light theme surface tokens under html[data-theme=\"light\"]", () => {
    expect(css).toContain('html[data-theme="light"]');
    expect(css).toContain("--color-abyss: #f8fafc;");
    expect(css).toContain("--color-panel: #ffffff;");
    expect(css).toContain("--color-panel-2: #f1f5f9;");
  });

  it("maps the inverted slate palette for WCAG AA/AAA compliant contrast in light mode", () => {
    const lightSection = css.split('html[data-theme="light"]')[1] ?? "";
    expect(lightSection).toContain("--color-slate-50: #020617;");
    expect(lightSection).toContain("--color-slate-100: #0f172a;");
    expect(lightSection).toContain("--color-slate-200: #1e293b;");
    expect(lightSection).toContain("--color-slate-300: #334155;");
    expect(lightSection).toContain("--color-slate-400: #475569;");
    expect(lightSection).toContain("--color-slate-500: #64748b;");
    expect(lightSection).toContain("--color-slate-700: #cbd5e1;");
    expect(lightSection).toContain("--color-slate-800: #e2e8f0;");
    expect(lightSection).toContain("--color-slate-900: #f1f5f9;");
    expect(lightSection).toContain("--color-slate-950: #f8fafc;");
  });

  it("maps light status chip colors for all semantic states", () => {
    const lightSection = css.split('html[data-theme="light"]')[1] ?? "";
    // Amber (pending / warning)
    expect(lightSection).toContain("--color-amber-950:");
    expect(lightSection).toContain("--color-amber-800:");
    // Emerald (active / success)
    expect(lightSection).toContain("--color-emerald-950:");
    expect(lightSection).toContain("--color-emerald-800:");
    // Rose & Red (critical / danger)
    expect(lightSection).toContain("--color-rose-950:");
    expect(lightSection).toContain("--color-rose-800:");
    expect(lightSection).toContain("--color-red-950:");
    // Purple & Violet (memory / review)
    expect(lightSection).toContain("--color-purple-950:");
    expect(lightSection).toContain("--color-purple-800:");
    expect(lightSection).toContain("--color-violet-950:");
    // Jules & Cyber
    expect(lightSection).toContain("--color-jules-950:");
    expect(lightSection).toContain("--color-cyber-800:");
  });

  it("adapts translucent border-white and hover overlays in light mode", () => {
    expect(css).toContain('html[data-theme="light"] .border-white\\/10');
    expect(css).toContain('html[data-theme="light"] .border-white\\/5');
    expect(css).toContain('html[data-theme="light"] .hover\\:bg-white\\/5:hover');
  });

  it("preserves white text on solid and gradient action buttons across themes", () => {
    expect(css).toContain(".bg-gradient-to-r.text-white");
    expect(css).toContain(".text-on-accent");
    expect(css).toContain("color: #ffffff;");
  });

  it("configures @custom-variant dark for Tailwind v4 data-theme & .dark support", () => {
    expect(css).toContain("@custom-variant dark");
  });

  it("configures accessible input and focus styles in light mode", () => {
    expect(css).toContain('html[data-theme="light"] input:not([type="checkbox"]):not([type="radio"])');
    expect(css).toContain('border-color: #cbd5e1;');
    expect(css).toContain('border-color: #2563eb;');
  });
});
