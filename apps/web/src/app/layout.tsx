import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Providers from "../i18n/Providers";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Jules Supervisor — AI Orchestration & Governance Control Plane",
  description: "Autonomous policy-controlled supervisor for Google Jules",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("jules-theme");var d=t==="light"||t==="dark"?t:(window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=d;document.documentElement.dataset.themeSetting=t||"system";document.documentElement.classList.toggle("dark",d==="dark");}catch(e){document.documentElement.dataset.theme="dark";document.documentElement.dataset.themeSetting="system";document.documentElement.classList.add("dark");}})();`,
          }}
        />
      </head>
      <body
        className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} bg-abyss text-slate-100 min-h-screen antialiased`}
      >
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
