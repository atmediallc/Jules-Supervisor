import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => vi.fn());
vi.mock("next-auth/middleware", () => ({ withAuth: () => auth }));
vi.mock("../lib/rate-limit", () => ({
  clientIpFromHeaders: () => "fixture",
  rateLimitKey: () => "fixture",
  isRateLimited: () => false,
}));
import middleware from "../middleware";

describe("Application mutation CSRF boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://supervisor.example");
    auth.mockReset().mockReturnValue(NextResponse.next());
  });
  afterEach(() => vi.unstubAllEnvs());

  function invoke(method: string, headers: Record<string, string>, path = "/api/settings") {
    // The mocked auth middleware does not consume a NextFetchEvent.
    return middleware(
      new NextRequest(`https://supervisor.example${path}`, { method, headers }),
      {} as Parameters<typeof middleware>[1],
    );
  }

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects cross-origin %s before authentication/dispatch",
    async (method) => {
      const response = await invoke(method, {
        origin: "https://attacker.example",
        "content-type": "application/json",
      });
      expect(response?.status).toBe(403);
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])(
    "rejects simple form content type %s",
    async (contentType) => {
      const response = await invoke("POST", { "content-type": contentType }, "/api/control/safety");
      expect(response?.status).toBe(415);
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "https://supervisor.example.attacker.example"])(
    "rejects untrusted origin %s",
    async (origin) => {
      expect((await invoke("PUT", { origin, "content-type": "application/json" }))?.status).toBe(
        403,
      );
    },
  );

  it("allows same-origin JSON through the existing authentication gate", async () => {
    await invoke("PUT", {
      origin: "https://supervisor.example",
      "content-type": "application/json; charset=utf-8",
    });
    expect(auth).toHaveBeenCalledOnce();
  });

  it("keeps authenticated non-browser JSON clients compatible", async () => {
    await invoke("PUT", { "content-type": "application/json" });
    expect(auth).toHaveBeenCalledOnce();
  });

  it("refuses cross-site fetch metadata even without an origin header", async () => {
    expect((await invoke("DELETE", { "sec-fetch-site": "cross-site" }))?.status).toBe(403);
  });

  it("preserves NextAuth's own CSRF-protected form flow", async () => {
    await invoke(
      "POST",
      { "content-type": "application/x-www-form-urlencoded" },
      "/api/auth/callback/credentials",
    );
    expect(auth).toHaveBeenCalledOnce();
  });

  it("keeps read-only requests behind authentication", async () => {
    await invoke("GET", {});
    expect(auth).toHaveBeenCalledOnce();
  });
});
