import { describe, expect, it, vi } from "vitest";
import { createSsrfGuardedFetch } from "./ssrf-guard.js";

describe("createSsrfGuardedFetch", () => {
  it("blocks requests to private and loopback IPs immediately", async () => {
    const guardedFetch = createSsrfGuardedFetch();
    await expect(guardedFetch("http://127.0.0.1:8080/secret")).rejects.toThrow(/SSRF guard blocked request/);
    await expect(guardedFetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/SSRF guard blocked request/);
  });

  it("blocks redirects to private IP addresses (anti-rebinding/bypass)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "http://192.168.1.1/admin" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const guardedFetch = createSsrfGuardedFetch();
    await expect(guardedFetch("https://example.com/redirect")).rejects.toThrow(/SSRF guard blocked redirect/);
  });
});
