import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getConfig } from "@jules/config";
import { validateProviderUrlWithDns } from "@jules/ai";
import { z } from "zod";

/**
 * GET /api/settings/models — List available models from the configured AI provider.
 *
 * Reads the effective AI config (DB override → env → default), validates the
 * base URL against the SSRF guard, then calls {baseUrl}/models (OpenAI-compatible
 * GET /models) with the configured API key. Returns the model ids.
 *
 * Responses:
 *   200 { models: string[] } on success (may be empty)
 *   200 { models: [] } when the provider cannot list models (mock, no key, error)
 *   400 when the base URL fails SSRF validation
 */
export const dynamic = "force-dynamic";

const timeoutMs = 8000;
const ModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(512) })).max(10_000),
});

export async function GET(req: NextRequest) {
  try {
    // Defense-in-depth: binary auth gate (same pattern as all other API routes).
    // This route is behind withAuth middleware, but the in-route check guards
    // against middleware misconfiguration.
    const token = await getToken({ req });
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = getConfig();
    const providerType = config.AI_PROVIDER_TYPE;

    // Mock provider — return its fixed synthetic model.
    if (providerType === "mock" || config.AI_API_KEY === "mock-ai-key-placeholder") {
      return NextResponse.json({ models: ["mock-model-v1"] });
    }

    const baseUrl = config.AI_BASE_URL.replace(/\/+$/, "");
    const apiKey = config.AI_API_KEY;

    // Guard against SSRF to internal/private endpoints the operator didn't trust.
    const guard = await validateProviderUrlWithDns(baseUrl, {
      allowInsecureLocal: config.ALLOW_INSECURE_LOCAL_ENDPOINTS,
      trustedInternalHosts: config.TRUSTED_INTERNAL_AI_HOSTS,
    });
    if (!guard.isValid) {
      return NextResponse.json({ error: guard.reason }, { status: 400 });
    }

    if (!apiKey) {
      return NextResponse.json({ error: "AI_API_KEY is not configured" }, { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
        // A public endpoint must not redirect an authenticated server request
        // into a private address that bypasses the original SSRF validation.
        redirect: "error",
      });

      if (!res.ok) {
        return NextResponse.json({ models: [] });
      }

      const data = ModelsResponseSchema.parse(await res.json());
      const models = data.data.map((model) => model.id);
      return NextResponse.json({ models });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network/timeout/abort — fall back to empty list so the UI uses free text.
    return NextResponse.json({ models: [] });
  }
}
