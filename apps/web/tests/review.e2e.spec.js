import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";

test.describe("review flow", () => {
  test.skip(process.env.PLAYWRIGHT_E2E !== "1", "Set PLAYWRIGHT_E2E=1 with running API/web services to execute the end-to-end review flow.");

  test("login -> import -> wait transcode -> post comment -> resolve", async ({ page }) => {
    await page.goto(BASE_URL);

    await page.getByLabel("Tài khoản").fill("minh");
    await page.getByLabel("Mật khẩu").fill("x");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(page.getByText("Workspace")).toBeVisible();
    await page.getByText("TVC Q3 2026 — Karofi Hero").click();
    await page.getByRole("button", { name: "Import từ NAS" }).click();
    await page.getByText("Hero_take7.mov").click();
    await page.getByRole("button", { name: /Import 1 nguồn/i }).click();

    await page.getByText("Opening_Wide_Kitchen").click();
    await page.getByRole("button", { name: /1080p/i }).click();

    await expect.poll(async () => page.locator("text=1080p").first().textContent()).not.toContain("Tạo proxy");

    const commentBox = page.locator("#commentInput");
    await commentBox.fill("playwright smoke comment");
    await page.locator('[data-act="postComment"]').click();
    await expect(page.getByText("playwright smoke comment")).toBeVisible();

    await page.locator('[data-act="toggleResolve"]').first().click();
    await expect(page.getByText("playwright smoke comment")).toBeVisible();
  });
});
