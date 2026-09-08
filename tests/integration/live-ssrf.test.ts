/**
 * Live SSRF guard test — hostnames that actually resolve must be classified correctly.
 */
import { describe, expect, it } from "vitest";
import { lookup } from "node:dns/promises";
import { validateProviderUrlWithDns } from "../../packages/ai/src/ssrf-guard";

describe("Live SSRF: classify real hostnames", () => {
  it("example.com (public IPv4/IPv6) is allowed", async () => {
    const res = await validateProviderUrlWithDns("https://example.com", {});
    expect(res.isValid).toBe(true);
  });

  it("localhost is in default trusted hosts — explicit deny requires trustedInternalHosts=[]", async () => {
    const res = await validateProviderUrlWithDns("http://localhost:1234", {});
    // By default localhost is trusted for local dev. To block it, pass empty array.
    expect(res.isValid).toBe(true);

    const strict = await validateProviderUrlWithDns("http://localhost:1234", {
      trustedInternalHosts: [],
      allowInsecureLocal: false,
    });
    expect(strict.isValid).toBe(false);
    expect(strict.reason ?? "").toMatch(/trusted|loopback|reserved|http/i);
  });

  it("127.0.0.1 is blocked (loopback IPv4)", async () => {
    const res = await validateProviderUrlWithDns("http://127.0.0.1:1234", {});
    expect(res.isValid).toBe(false);
  });

  it("[::1] is blocked (loopback IPv6)", async () => {
    const res = await validateProviderUrlWithDns("http://[::1]:1234", {});
    expect(res.isValid).toBe(false);
  });

  it("file:// protocol is blocked (unsafe protocol)", async () => {
    const res = await validateProviderUrlWithDns("file:///etc/passwd", {});
    expect(res.isValid).toBe(false);
  });

  it("metadata.google.internal is blocked (known metadata service)", async () => {
    const res = await validateProviderUrlWithDns(
      "http://metadata.google.internal/computeMetadata/v1/",
      {},
    );
    expect(res.isValid).toBe(false);
  });

  it("DNS rebinding: a hostname that resolves to public IP is allowed", async () => {
    // resolve one.one.one.one which is 1.1.1.1 (public)
    try {
      await lookup("one.one.one.one");
    } catch {
      return; // skip if no network
    }
    const res = await validateProviderUrlWithDns("https://one.one.one.one", {});
    expect(res.isValid).toBe(true);
  });
});
