import { test, expect } from "@playwright/test";

// Menus render in their own layer on <body>: nothing on the page (a card's
// thumbnail, a scrolling toolbar, the video stage) may clip or cover them,
// and right-click opens the same actions at the pointer.

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";

async function login(page) {
  await page.goto(BASE_URL);
  await page.getByPlaceholder("Tài khoản DSM").fill("minh");
  await page.getByPlaceholder("Mật khẩu").fill("x");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.locator("[data-screen-label='Hub dự án']")).toBeVisible();
}

// Every item of the open menu is inside the window and is the element the
// pointer would hit at its centre.
async function expectMenuUsable(page) {
  const menu = page.locator(".menu");
  await expect(menu).toHaveCount(1);
  await expect(menu).toBeVisible();
  await page.waitForTimeout(200); // open animation
  const items = await menu.locator(".menu-item").evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const top = inView ? document.elementFromPoint(x, y) : null;
    return { label: el.textContent.trim(), ok: inView && !!top && el.contains(top) };
  }));
  expect(items.length).toBeGreaterThan(0);
  expect(items.filter((i) => !i.ok)).toEqual([]);
}

test.describe("menus", () => {
  test.skip(process.env.PLAYWRIGHT_E2E !== "1", "Set PLAYWRIGHT_E2E=1 with running API/web services.");
  test.use({ viewport: { width: 1280, height: 720 } });

  test("video cards: ⋯ menu and right-click menu are fully usable", async ({ page }) => {
    await login(page);
    await page.goto(BASE_URL + "/#/p/p1");
    const card = page.locator(".grid-assets .card").first();
    await card.hover();
    await card.locator(".more-btn").click();
    await expectMenuUsable(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);

    await card.click({ button: "right", position: { x: 60, y: 40 } });
    await expect(page.locator(".menu .menu-title")).toHaveText(/Opening_Wide_Kitchen/i);
    await expectMenuUsable(page);
    // the click that dismisses the menu doesn't also open the video
    await card.click({ position: { x: 60, y: 40 } });
    await expect(page.locator(".menu")).toHaveCount(0);
    await expect(page.locator("[data-screen-label='Chi tiết dự án']")).toBeVisible();

    await card.click({ button: "right", position: { x: 60, y: 40 } });
    await page.locator(".menu-item", { hasText: "Mở review" }).click();
    await expect(page.locator("[data-screen-label='Review video']")).toBeVisible();
  });

  test("review: right-click on the video, quality menu, sketch templates", async ({ page }) => {
    await login(page);
    await page.goto(BASE_URL + "/#/p/p1/v/p1s1");
    const stage = page.locator(".stage");
    await expect(stage).toBeVisible();
    await stage.click({ button: "right", position: { x: 40, y: 40 } });
    await expectMenuUsable(page);
    await expect(page.locator(".menu-item", { hasText: /Ghi chú tại/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);

    await page.locator(".ctl.ring").nth(1).click();
    await expectMenuUsable(page);
    await page.keyboard.press("Escape");

    await page.locator(".controls .ctl", { hasText: "Phác thảo" }).click();
    await page.locator(".sk-chip", { hasText: "Mẫu nhanh" }).click();
    await expectMenuUsable(page);
    // Esc closes the menu, not the sketch editor
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);
    await expect(page.locator(".sk-bar")).toBeVisible();
    // drawing on the frame closes it too
    await page.locator(".sk-chip", { hasText: "Mẫu nhanh" }).click();
    await expect(page.locator(".menu")).toHaveCount(1);
    await page.locator(".sk-hit").click({ position: { x: 80, y: 80 } });
    await expect(page.locator(".menu")).toHaveCount(0);
  });

  test("script editor: toolbar menus are not clipped and a reopened script keeps its text", async ({ page }) => {
    await login(page);
    await page.goto(BASE_URL + "/#/scripts");
    await page.getByRole("button", { name: "Kịch bản mới" }).click();
    const doc = page.locator(".script-doc");
    await expect(doc).toBeVisible();
    await doc.click();
    await page.keyboard.type("Cảnh mở đầu: nhà bếp buổi sáng.");
    await expect(page.locator(".sc-saved")).toHaveText(/Đã lưu/, { timeout: 5000 });

    for (const title of ["Kiểu đoạn", "Phông chữ", "Cỡ chữ", "Căn lề", "Giãn dòng", "Định dạng khác"]) {
      await page.locator(`.sc-toolbar .tb[title="${title}"]`).click();
      await expectMenuUsable(page);
      await page.keyboard.press("Escape");
    }
    await page.locator(".sc-top .icon-btn").click();
    await expectMenuUsable(page);
    await page.keyboard.press("Escape");

    await page.locator(".rv-crumb", { hasText: "Kịch bản" }).click();
    await page.locator(".grid-scripts .card").first().click();
    await expect(page.locator(".script-doc")).toContainText("Cảnh mở đầu: nhà bếp buổi sáng.");
  });
});
