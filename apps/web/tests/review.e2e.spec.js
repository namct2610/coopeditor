import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";

test.describe("review flow", () => {
  test.skip(process.env.PLAYWRIGHT_E2E !== "1", "Set PLAYWRIGHT_E2E=1 with running API/web services to execute the end-to-end review flow.");

  test("login -> import -> request proxy -> comment -> resolve -> status", async ({ page }) => {
    await page.goto(BASE_URL);

    await page.getByPlaceholder("Tài khoản DSM").fill("minh");
    await page.getByPlaceholder("Mật khẩu").fill("x");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(page.locator("[data-screen-label='Hub dự án']")).toBeVisible();
    await page.getByText("TVC Q3 2026 — Karofi Hero").first().click();
    await expect(page.locator("[data-screen-label='Chi tiết dự án']")).toBeVisible();

    await page.getByRole("button", { name: "Thêm nguồn" }).click();
    await page.locator(".file-row", { hasText: "Footage" }).click();
    await page.locator(".file-row", { hasText: "TVC Q3 2026" }).click();
    await page.locator(".file-row", { hasText: "Hero" }).first().click();
    await page.locator(".file-row", { hasText: "Hero_take7.mov" }).click();
    await page.getByRole("button", { name: /Thêm vào/ }).click();
    await expect(page.locator(".grid-assets .card", { hasText: "Hero_take7" })).toBeVisible();

    await page.locator(".grid-assets .card", { hasText: "Opening_Wide_Kitchen" }).click();
    await expect(page.locator("[data-screen-label='Review video']")).toBeVisible();

    // Proxy quality menu: ask for 1080p, the memory backend simulates the encode.
    await page.locator(".ctl.ring").nth(1).click();
    await page.locator(".menu-item", { hasText: "1080p" }).click();
    await expect(page.getByText(/Đã gửi yêu cầu tạo proxy 1080p|Proxy 1080p đang tạo/)).toBeVisible();

    await page.locator("#noteComposer").fill("playwright smoke comment");
    await page.keyboard.press("Enter");
    const thread = page.locator(".thread", { hasText: "playwright smoke comment" });
    await expect(thread).toBeVisible();

    // Resolving under the "Mở" filter moves the thread to "Xong".
    await thread.locator(".check").click();
    await expect(thread).toBeHidden();
    await page.locator(".notes .seg-opt", { hasText: "Xong" }).click();
    await expect(thread.locator(".check.done")).toBeVisible();

    await page.locator(".status-btn").click();
    await page.locator(".menu-item", { hasText: "Đã duyệt" }).click();
    await expect(page.locator(".status-btn")).toContainText("Đã duyệt");
  });
});
