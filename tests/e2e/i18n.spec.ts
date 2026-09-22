import { test, expect } from "@playwright/test";

// Verifies the next-intl locale pipeline end-to-end on the authenticated
// dashboard: default EN, switcher flips to ES, the choice persists across
// navigation and reloads, `<html lang>` follows the locale, and switching
// produces no hydration/console errors.

const EN_COOKIE = "NEXT_LOCALE";

test.describe("i18n language switching (dashboard)", () => {
  test("defaults to English with html lang=en and no flash-prone state", async ({
    page,
  }) => {
    await page.goto("/");
    // Clean cookie context — assert EN chrome before any interaction.
    await expect(page).toHaveTitle(/Jules Supervisor/i);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("body")).toContainText("Overview");
  });

  test("switching to Spanish updates chrome, persists across navigation and reload", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    // Flip to Spanish via the header switcher.
    await page.getByRole("button", { name: /switch language to es/i }).click();

    // Switcher reloads the page; wait for the ES chrome to appear.
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("body")).toContainText("Resumen");

    // Cookie was set.
    const cookies = await page.context().cookies();
    const cookie = cookies.find((c) => c.name === EN_COOKIE);
    expect(cookie?.value).toBe("es");

    // Persists across same-session navigation.
    await page.goto("/sessions");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("body")).toContainText("Sesiones de Jules");

    // Persists across a full reload (cookie-driven).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("body")).toContainText("Sesiones de Jules");

    // Switching produced no console errors (a hydration mismatch would log one).
    expect(consoleErrors).toEqual([]);
  });

  test("switching back to English restores English chrome", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /switch language to es/i }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    await page.getByRole("button", { name: /switch language to en/i }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("body")).toContainText("Overview");
  });
});