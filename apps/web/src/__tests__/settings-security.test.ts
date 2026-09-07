import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  getAsMap: vi.fn(),
  getDatabase: vi.fn(),
  runInTransaction: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }));
vi.mock("@jules/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jules/config")>()),
  getConfig: () => ({}),
}));
vi.mock("@jules/db", () => ({
  getDatabase: mocks.getDatabase,
  runInTransaction: mocks.runInTransaction,
  SystemSettingsRepository: class {
    getAsMap = mocks.getAsMap;
  },
}));

import { GET, PUT, DELETE } from "../app/api/settings/route";

describe("Settings response secrecy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getToken.mockResolvedValue({ name: "test-operator" });
    mocks.getAsMap.mockResolvedValue({});
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { key: "SUPERVISOR_MODE", value: "not-a-mode" },
    { key: "MAX_SESSION_CYCLES", value: "-1" },
    { key: "POLL_INTERVAL_MS", value: "NaN" },
    { key: "AI_BASE_URL", value: "invalid-url" },
    { key: "constructor", value: "inherited" },
    { key: "__proto__", value: "inherited" },
  ])("rejects invalid overrides before any writes: $key", async (setting) => {
    const response = await PUT(
      new NextRequest("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({ settings: [setting] }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.runInTransaction).not.toHaveBeenCalled();
  });

  it("rejects inherited setting names on deletion", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/settings?key=constructor", { method: "DELETE" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.runInTransaction).not.toHaveBeenCalled();
  });

  it("requires authentication before reading settings", async () => {
    mocks.getToken.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/settings"));
    expect(response.status).toBe(401);
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it.each(["database", "environment", "database-unavailable"])(
    "never serializes secret raw values from %s",
    async (source) => {
      const sentinel = "audit-fixture-private-value-never-return";
      vi.stubEnv("AI_API_KEY", sentinel);
      if (source === "database") {
        mocks.getAsMap.mockResolvedValue({ AI_API_KEY: sentinel, AI_MODEL: "fixture-model" });
      } else {
        vi.stubEnv("AI_MODEL", "fixture-model");
        if (source === "database-unavailable")
          mocks.getAsMap.mockRejectedValue(new Error("offline"));
      }
      const response = await GET(new NextRequest("http://localhost/api/settings"));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(sentinel);
      const { settings } = JSON.parse(body);
      for (const item of settings) {
        if (item.isSecret) expect(item.rawValue).toBeNull();
      }
      expect(settings.find((item: { key: string }) => item.key === "AI_MODEL").rawValue).toBe(
        "fixture-model",
      );
    },
  );
});
