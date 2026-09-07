import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), validate: vi.fn() }));
vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }));
vi.mock("@jules/ai", () => ({ validateProviderUrlWithDns: mocks.validate }));
vi.mock("@jules/config", () => ({
  getConfig: () => ({
    AI_PROVIDER_TYPE: "endpoint",
    AI_API_KEY: "fixture",
    AI_BASE_URL: "https://provider.example/v1",
  }),
}));
import { GET } from "../app/api/settings/models/route";

describe("Model discovery trust boundary", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    mocks.getToken.mockResolvedValue({ name: "operator" });
    mocks.validate.mockResolvedValue({ isValid: true });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requires authentication before contacting a provider", async () => {
    mocks.getToken.mockResolvedValue(null);
    expect(
      (await GET(new NextRequest("https://supervisor.example/api/settings/models"))).status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a DNS-resolved private target before fetch", async () => {
    mocks.validate.mockResolvedValue({ isValid: false, reason: "private target" });
    expect(
      (await GET(new NextRequest("https://supervisor.example/api/settings/models"))).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects and returns validated provider model IDs", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "custom-model" }] }));
    const response = await GET(new NextRequest("https://supervisor.example/api/settings/models"));
    expect(await response.json()).toEqual({ models: ["custom-model"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/v1/models",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each([{ data: [{ id: { untrusted: true } }] }, { data: "invalid" }, { data: [null] }])(
    "handles malformed provider payloads without leaking data: %j",
    async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      const response = await GET(new NextRequest("https://supervisor.example/api/settings/models"));
      expect(await response.json()).toEqual({ models: [] });
    },
  );
});
