import { expect, test } from "@playwright/test";

// Reuse the suite's authenticated context. This spec never writes credentials
// or shared auth files; API interception keeps these cases independent of DB data.
const approval = {
  id: "approval-fixture",
  sessionId: "session-fixture",
  action: "RESPOND",
  risk: "low",
  confidence: 0.95,
  reason: "Regression fixture",
  proposedResponse: "Initial response",
  createdAt: "2026-01-01T00:00:00.000Z",
};

for (const failure of [409, 503, "network"] as const) {
  test(`keeps approval and edits after ${failure}, then accepts a confirmed retry`, async ({
    page,
  }) => {
    await page.route("**/api/approvals", (route) =>
      route.fulfill({ json: { approvals: [approval] } }),
    );
    let fail = true;
    await page.route("**/api/approvals/approval-fixture", (route) => {
      if (!fail) return route.fulfill({ json: { success: true, status: "EDITED" } });
      if (failure === "network") return route.abort();
      return route.fulfill({ status: failure, json: { error: "Fixture failure" } });
    });
    await page.goto("/approvals");
    await page.getByRole("button", { name: /edit response/i }).click();
    await page.locator("textarea").fill("Preserve the operator's correction");
    await page.getByRole("button", { name: /save.*send/i }).click();
    const errorAlert = page.locator("div[role='alert']:not(#__next-route-announcer__)");
    await expect(errorAlert).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("Preserve the operator's correction");
    await expect(page.getByText("approval-fixture", { exact: true })).toBeVisible();
    await expect(page.getByText(/marked as .* successfully/i)).toHaveCount(0);

    fail = false;
    await page.getByRole("button", { name: /save.*send/i }).click();
    await expect(page.getByText(/marked as EDITED successfully/i)).toBeVisible();
    await expect(errorAlert).toHaveCount(0);
    await expect(page.locator("textarea")).toHaveCount(0);
  });
}
