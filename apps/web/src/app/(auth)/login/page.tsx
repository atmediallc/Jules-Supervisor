"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ShieldCheck,
  User,
  LockKeyhole,
  Eye,
  EyeOff,
  Activity,
  ScrollText,
  BrainCircuit,
  CheckCircle2,
  Play,
  ArrowRight,
  Loader2,
  Terminal,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher } from "@/i18n";

/** Brand mark — layered shield, the Jules Supervisor visual primitive. */
function BrandMark() {
  return (
    <div
      className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500/20 via-violet-500/15 to-cyan-500/15 ring-1 ring-inset ring-indigo-500/30 flex items-center justify-center shadow-[0_0_24px_-6px_rgba(99,102,241,0.5)]"
    >
      <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-indigo-400/20 to-transparent opacity-60" />
      <ShieldCheck className="w-5 h-5 text-indigo-500 dark:text-indigo-300 relative" strokeWidth={1.7} />
    </div>
  );
}

/** Capability nodes in the supervision pipeline (descriptive, not live state). */
function getPipelineNodes(t: ReturnType<typeof useTranslations>) {
  return [
    { icon: Terminal, label: t("pipeline.jules_session"), sub: t("pipeline.jules_session_sub") },
    { icon: ScrollText, label: t("pipeline.policy_engine"), sub: t("pipeline.policy_engine_sub") },
    { icon: BrainCircuit, label: t("pipeline.ai_decision"), sub: t("pipeline.ai_decision_sub") },
    { icon: CheckCircle2, label: t("pipeline.human_approval"), sub: t("pipeline.human_approval_sub") },
    { icon: Play, label: t("pipeline.execution"), sub: t("pipeline.execution_sub") },
  ];
}

function SupervisionPipeline({ t }: { t: ReturnType<typeof useTranslations> }) {
  const nodes = getPipelineNodes(t);
  return (
    <div className="relative">
      <ol className="relative space-y-0">
        {nodes.map(({ icon: Icon, label, sub }, i) => (
          <li key={label} className="relative flex items-start gap-4">
            {i < nodes.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[13px] top-10 bottom-[-8px] w-px bg-gradient-to-b from-indigo-500/40 via-slate-600/30 to-transparent"
              />
            )}
            <span className="relative mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/80 ring-1 ring-inset ring-white/5">
              <Icon className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-300" strokeWidth={1.8} />
            </span>
            <div className="pb-6">
              <p className="text-sm font-medium text-slate-100">{label}</p>
              <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PasswordField({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  t,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  describedBy?: string;
  t: (key: string) => string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <LockKeyhole
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        strokeWidth={1.8}
        aria-hidden
      />
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder=" "
        required
        className={`peer w-full rounded-lg border bg-slate-900/60 py-2.5 pl-10 pr-11 text-sm text-slate-100 placeholder-transparent shadow-inner outline-none transition focus:ring-2 focus:ring-indigo-500/60 ${
          invalid
            ? "border-rose-500/70 focus:border-rose-500"
            : "border-slate-700/80 focus:border-indigo-500/60"
        }`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("hide_password") : t("show_password")}
        aria-pressed={visible}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition-colors hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 cursor-pointer"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" strokeWidth={1.8} />
        ) : (
          <Eye className="h-4 w-4" strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const submitLock = useRef(false);
  const t = useTranslations("login");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [touched, setTouched] = useState(false);

  const submitting = status === "loading";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || submitLock.current) return;
    setError("");
    setStatus("loading");
    submitLock.current = true;
    try {
      const result = await signIn("credentials", {
        username,
        password,
        redirect: false,
      });
      if (result?.error) {
        setError(t("error_invalid_credentials"));
        setStatus("idle");
        setTouched(true);
      } else {
        router.replace("/");
      }
    } catch {
      setError(t("error_unreachable"));
      setStatus("idle");
    } finally {
      submitLock.current = false;
    }
  };

  return (
    <div className="relative flex min-h-screen bg-abyss text-slate-100">
      {/* Top right theme and language controls */}
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-30 flex items-center gap-2 font-mono text-xs">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>

      {/* Ambient background */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="absolute bottom-[-16rem] right-[-10rem] h-[30rem] w-[30rem] rounded-full bg-cyan-500/10 blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(9,13,22,0.6)_100%)] dark:block hidden" />
        {/* Faint grid */}
        <div className="absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,#94a3b8_1px,transparent_1px),linear-gradient(to_bottom,#94a3b8_1px,transparent_1px)] [background-size:44px_44px]" />
      </div>

      {/* LEFT — brand experience */}
      <aside className="relative z-10 hidden w-[55%] flex-col justify-between overflow-hidden border-r border-white/10 bg-abyss-soft/60 lg:flex xl:w-[58%]">
        <div className="p-10 xl:p-14">
          <div className="flex items-center gap-3.5">
            <BrandMark />
            <div>
              <p className="text-[15px] font-semibold tracking-[0.14em] text-slate-100">
                {t("brand")}
              </p>
              <p className="mt-0.5 text-[11px] font-mono tracking-wide text-slate-400">
                {t("subtitle")}
              </p>
            </div>
          </div>

          <div className="mt-16 max-w-md xl:mt-24">
            <h1 className="text-3xl font-semibold leading-tight text-slate-100 xl:text-[2.1rem] xl:leading-[1.2]">
              {t("hero_title")}
              <br />
              <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 dark:from-indigo-300 dark:via-violet-200 dark:to-cyan-200 bg-clip-text text-transparent">
                {t("hero_highlight")}
              </span>
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-slate-400">
              {t("hero_description")}
            </p>
          </div>
        </div>

        {/* Supervision pipeline — descriptive capability flow */}
        <div className="relative mx-10 mb-12 rounded-2xl border border-white/10 bg-gradient-to-br from-panel to-abyss-soft p-6 backdrop-blur-sm xl:mx-14 xl:p-7">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {t("pipeline_title")}
            </p>
            <span className="flex items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-900/80 px-2 py-0.5 font-mono text-[10px] text-slate-400">
              <Activity className="h-3 w-3 text-indigo-500 dark:text-indigo-400 motion-safe:animate-pulse" strokeWidth={1.8} />
              {t("pipeline_badge")}
            </span>
          </div>
          <SupervisionPipeline t={t} />
        </div>
      </aside>

      {/* RIGHT — login panel */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[26rem]">
          {/* Mobile brand */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <div>
              <p className="text-sm font-semibold tracking-[0.14em] text-slate-100">{t("brand")}</p>
              <p className="text-[11px] font-mono text-slate-400">{t("subtitle")}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-panel via-abyss-soft to-abyss p-8 shadow-xl backdrop-blur-sm sm:p-9">
            <h2 className="text-xl font-semibold text-slate-100">{t("welcome_back")}</h2>
            <p className="mt-1.5 text-sm text-slate-400">
              {t("welcome_description")}
            </p>

            <form onSubmit={handleSubmit} noValidate aria-busy={submitting} className="mt-7 space-y-5">
              <div>
                <label
                  htmlFor={usernameId}
                  className="mb-1.5 block text-xs font-medium text-slate-200"
                >
                  {t("username_label")}
                </label>
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    strokeWidth={1.8}
                    aria-hidden
                  />
                  <input
                    id={usernameId}
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder=" "
                    required
                    aria-invalid={touched && error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={`peer w-full rounded-lg border bg-slate-900/60 py-2.5 pl-10 pr-3 text-sm text-slate-100 placeholder-transparent shadow-inner outline-none transition focus:ring-2 focus:ring-indigo-500/60 ${
                      touched && error
                        ? "border-rose-500/70 focus:border-rose-500"
                        : "border-slate-700/80 focus:border-indigo-500/60"
                    }`}
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor={passwordId}
                  className="mb-1.5 block text-xs font-medium text-slate-200"
                >
                  {t("password_label")}
                </label>
                <PasswordField
                  id={passwordId}
                  value={password}
                  onChange={setPassword}
                  invalid={touched && !!error}
                  describedBy={error ? errorId : undefined}
                  t={t}
                />
              </div>

              {error ? (
                <div
                  id={errorId}
                  role="alert"
                  className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-400 dark:text-rose-300"
                >
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
                  <p>{error}</p>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={submitting}
                className="group relative flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-indigo-500 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_rgba(79,70,229,0.8)] transition hover:from-indigo-400 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 cursor-pointer"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
                    <span>{t("signing_in")}</span>
                  </>
                ) : (
                  <>
                    <span>{t("sign_in")}</span>
                    <ArrowRight
                      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                      strokeWidth={2}
                      aria-hidden
                    />
                  </>
                )}
              </button>
            </form>

            <p className="mt-7 flex items-center justify-center gap-2 border-t border-white/10 pt-5 text-center text-xs text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.8} aria-hidden />
              {t("footer_text")}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

