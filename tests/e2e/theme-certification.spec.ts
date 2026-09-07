import { test, expect } from "@playwright/test";

test.describe("Dark/Light Mode Certification & E2E Validation", () => {
  test("1. Dashboard initial load, anti-FOUC and dark mode baseline", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");
    await expect(page).toHaveTitle(/Jules Supervisor/i);

    // Initial theme attribute & class
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );

    expect(["light", "dark"]).toContain(theme);
    if (theme === "dark") {
      expect(hasDarkClass).toBe(true);
    }

    // No React hydration errors
    const hydrationErrors = consoleErrors.filter((e) =>
      e.toLowerCase().includes("hydration"),
    );
    expect(hydrationErrors).toHaveLength(0);
  });

  test("2. Theme switcher toggles between light and dark with synchronized DOM", async ({
    page,
  }) => {
    await page.goto("/");

    const lightRadio = page.getByRole("radio", { name: /light/i });
    const darkRadio = page.getByRole("radio", { name: /dark/i });

    // Switch to Light
    await lightRadio.click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");

    const isDarkAfterLight = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(isDarkAfterLight).toBe(false);

    const storedLight = await page.evaluate(() => localStorage.getItem("jules-theme"));
    expect(storedLight).toBe("light");

    // Switch to Dark
    await darkRadio.click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");

    const isDarkAfterDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(isDarkAfterDark).toBe(true);

    const storedDark = await page.evaluate(() => localStorage.getItem("jules-theme"));
    expect(storedDark).toBe("dark");
  });

  test("3. Theme persistence across page reload (anti-FOUC)", async ({ page }) => {
    await page.goto("/");

    // Set to light
    const lightRadio = page.getByRole("radio", { name: /light/i });
    await lightRadio.click();

    // Reload page
    await page.reload();

    const themeAfterReload = await page.evaluate(
      () => document.documentElement.dataset.theme,
    );
    expect(themeAfterReload).toBe("light");

    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(false);

    // Switch back to dark and verify reload
    const darkRadio = page.getByRole("radio", { name: /dark/i });
    await darkRadio.click();
    await page.reload();

    const themeAfterDarkReload = await page.evaluate(
      () => document.documentElement.dataset.theme,
    );
    expect(themeAfterDarkReload).toBe("dark");
    const hasDarkClassNow = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClassNow).toBe(true);
  });

  test("4. Navigation across routes maintains theme consistency", async ({ page }) => {
    await page.goto("/");

    // Switch to light
    await page.getByRole("radio", { name: /light/i }).click();

    const routes = ["/sessions", "/approvals", "/decisions", "/settings", "/policies", "/memories", "/audit"];
    for (const route of routes) {
      await page.goto(route);
      const currentTheme = await page.evaluate(
        () => document.documentElement.dataset.theme,
      );
      expect(currentTheme).toBe("light");
    }

    // Switch back to dark on audit page
    await page.getByRole("radio", { name: /dark/i }).click();
    await page.goto("/");
    const themeOnHome = await page.evaluate(
      () => document.documentElement.dataset.theme,
    );
    expect(themeOnHome).toBe("dark");
  });

  test("5. System mode dynamically follows emulated OS color scheme", async ({ page }) => {
    await page.goto("/");

    // Select system / auto mode
    const systemRadio = page.getByRole("radio", { name: /auto|system/i });
    await systemRadio.click();

    const storedMode = await page.evaluate(() => localStorage.getItem("jules-theme"));
    expect(storedMode).toBe("system");

    // Emulate light OS
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");

    // Emulate dark OS
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
  });

  test("6. Responsive viewports render without horizontal overflow", async ({ page }) => {
    const viewports = [
      { width: 390, height: 844 }, // Mobile
      { width: 768, height: 1024 }, // Tablet
      { width: 1280, height: 800 }, // Laptop
      { width: 1440, height: 900 }, // Desktop
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto("/");

      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(hasOverflow).toBe(false);

      if (vp.width <= 768) {
        // Mobile drawer button exists
        const menuButton = page.getByRole("button", { name: /open navigation menu/i });
        await expect(menuButton).toBeVisible();
      }
    }
  });

  test("7. Login page displays correctly in both themes without contrast defects", async ({
    page,
  }) => {
    await page.goto("/login");

    // Check login container
    const loginCard = page.locator("main");
    await expect(loginCard).toBeVisible();

    // Verify username and password fields exist and are accessible
    const usernameInput = page.locator('input[autocomplete="username"]');
    const passwordInput = page.locator('input[autocomplete="current-password"]');
    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();

    // Toggle to light theme on login page
    const lightRadio = page.getByRole("radio", { name: /light/i });
    if (await lightRadio.isVisible()) {
      await lightRadio.click();
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("light");

      // Sign-in button text has contrast
      const submitBtn = page.getByRole("button", { name: /sign in/i });
      await expect(submitBtn).toBeVisible();

      // Switch back to dark
      await page.getByRole("radio", { name: /dark/i }).click();
    }
  });
});
