import { test, expect } from "@playwright/test";

const ROUTES = [
  { path: "/", name: "dashboard" },
  { path: "/sessions", name: "sessions" },
  { path: "/approvals", name: "approvals" },
  { path: "/decisions", name: "decisions" },
  { path: "/memories", name: "memories" },
  { path: "/policies", name: "policies" },
  { path: "/audit", name: "audit" },
  { path: "/settings", name: "settings" },
];

test.describe("Visual Audit & Contrast Certification across all routes", () => {
  for (const { path, name } of ROUTES) {
    test(`Visual check: ${name} in Light and Dark mode`, async ({ page }) => {
      // 1. Check Dark Mode
      await page.goto(path);
      await page.getByRole("radio", { name: /dark/i }).click();
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("dark");

      // Verify dark theme body styling
      const darkBg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor,
      );
      // Abyss background #060a13
      expect(darkBg).toBe("rgb(6, 10, 19)");

      // Check for elements with improper white text leaks or broken layout
      const darkOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(darkOverflow).toBe(false);

      // 2. Check Light Mode
      await page.getByRole("radio", { name: /light/i }).click();
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("light");

      const lightBg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor,
      );
      // Slate-50 background #f8fafc
      expect(lightBg).toBe("rgb(248, 250, 252)");

      // Primary text color is inverted dark slate #0f172a
      const heading = page.locator("h2, h1").first();
      if (await heading.isVisible()) {
        const textColor = await heading.evaluate(
          (el) => window.getComputedStyle(el).color,
        );
        // Slate-100 inverted in light mode is #0f172a -> rgb(15, 23, 42)
        expect(textColor).toBe("rgb(15, 23, 42)");
      }

      // Check for horizontal overflow in light mode
      const lightOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(lightOverflow).toBe(false);
    });
  }

  test("Mobile visual check (390px) on Dashboard & Navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    // Dark mode mobile
    await page.getByRole("radio", { name: /dark/i }).click();
    const menuBtn = page.getByRole("button", { name: /open navigation menu/i });
    await expect(menuBtn).toBeVisible();

    // Open mobile drawer
    await menuBtn.click();
    const mobileDrawer = page.locator('aside[aria-label="Mobile Navigation"]');
    await expect(mobileDrawer).toHaveClass(/translate-x-0/);
    await expect(mobileDrawer).toHaveAttribute("aria-hidden", "false");

    // Close mobile drawer
    await page.getByRole("button", { name: /close navigation menu/i }).click();
    await expect(mobileDrawer).toHaveClass(/-translate-x-full/);
    await expect(mobileDrawer).toHaveAttribute("aria-hidden", "true");

    // Light mode mobile
    await page.getByRole("radio", { name: /light/i }).click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");

    await menuBtn.click();
    await expect(mobileDrawer).toHaveClass(/translate-x-0/);
    await expect(mobileDrawer).toHaveAttribute("aria-hidden", "false");
    await page.getByRole("button", { name: /close navigation menu/i }).click();
    await expect(mobileDrawer).toHaveClass(/-translate-x-full/);
  });
});
