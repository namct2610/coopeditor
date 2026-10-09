import { test, expect } from "@playwright/test";

// Kịch bản editor: character / paragraph formatting from the toolbar, and
// pictures inserted from a file, pasted, resized and kept across a reopen.

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
// 2×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwyBDAA9xQX7QXV5JAAAAABJRU5ErkJggg==", "base64");

async function newScript(page) {
  await page.goto(BASE_URL);
  await page.getByPlaceholder("Tài khoản DSM").fill("minh");
  await page.getByPlaceholder("Mật khẩu").fill("x");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.locator("[data-screen-label='Hub dự án']")).toBeVisible();
  await page.goto(BASE_URL + "/#/scripts");
  await page.getByRole("button", { name: "Kịch bản mới" }).click();
  await expect(page.locator(".script-doc")).toBeVisible();
}
const bodyHtml = (page) => page.evaluate(() => window.__scEditor.getHTML());
const select = (page, from, to) => page.evaluate(([a, b]) => window.__scEditor.chain().focus().setTextSelection({ from: a, to: b }).run(), [from, to]);

test.describe("script editor", () => {
  test.skip(process.env.PLAYWRIGHT_E2E !== "1", "Set PLAYWRIGHT_E2E=1 with running API/web services.");
  test.use({ viewport: { width: 1280, height: 800 } });

  test("formatting: colour, highlight, font, size, alignment, spacing, indent, link, lists, table", async ({ page }) => {
    await newScript(page);
    await page.locator(".script-doc").click();
    await page.keyboard.type("Cảnh bếp buổi sáng.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Lời dẫn.");

    await select(page, 1, 5);
    await page.locator(".tb[title^='Gạch ngang']").click();
    await page.locator(".tb[title='Màu chữ']").click();
    await page.locator(".menu .sw[title='Đỏ']").click();
    await page.locator(".tb[title^='Tô nền chữ']").click();
    await page.locator(".menu .sw[title='Vàng']").click();
    await page.locator(".tb[title='Phông chữ']").click();
    await page.locator(".menu-item", { hasText: "Georgia" }).click();
    await page.locator(".tb[title='Cỡ chữ']").click();
    await page.locator(".menu-item", { hasText: /^24$/ }).click();
    await page.locator(".tb[title='Tăng cỡ chữ']").click();
    let h = await bodyHtml(page);
    expect(h).toContain("<s>");
    expect(h).toMatch(/color: rgb\(229, 72, 77\)/);
    expect(h).toContain('data-color="#fff59d"');
    expect(h).toContain("font-family: Georgia");
    expect(h).toContain("font-size: 28px");

    await page.locator(".script-doc p").nth(1).click();
    await page.locator(".tb[title='Căn lề']").click();
    await page.locator(".menu-item", { hasText: "Căn giữa" }).click();
    await page.locator(".tb[title='Giãn dòng']").click();
    await page.locator(".menu-item", { hasText: "Đôi" }).click();
    await page.locator(".tb[title^='Tăng thụt lề']").click();
    h = await bodyHtml(page);
    expect(h).toMatch(/<p data-indent="1" style="text-align: center; line-height: 2; margin-left: 2em;">Lời dẫn\.<\/p>/);

    // ⌘/Ctrl+K in the text makes a link (not the command palette)
    await select(page, 21, 24);
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator(".sc-linkpop input").fill("example.com");
    await page.keyboard.press("Enter");
    await expect(page.locator(".sc-linkpop")).toHaveCount(0);
    expect(await bodyHtml(page)).toContain('href="https://example.com"');

    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.locator(".tb[title^='Danh sách đánh số']").click();
    await page.keyboard.type("Một");
    await page.locator(".tb[title='Chèn bảng']").click();
    await page.locator(".tg-c").nth(9).click(); // 2 × 2
    h = await bodyHtml(page);
    expect(h).toContain("<ol>");
    expect((h.match(/<table[\s\S]*?<\/tr>/) || [""])[0].match(/<t[hd]/g)).toHaveLength(2);

    // clear formatting keeps the words
    await select(page, 1, 20);
    await page.keyboard.press("ControlOrMeta+\\");
    expect((await bodyHtml(page)).startsWith("<p>Cảnh bếp buổi sáng.</p>")).toBe(true);
  });

  test("images: insert, paste, resize from the image bar, still there after reopening", async ({ page }) => {
    await newScript(page);
    await page.locator(".script-doc").click();
    await page.keyboard.type("Khung tham khảo:");
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".tb[title^='Chèn ảnh']").click();
    await (await chooser).setFiles({ name: "ref.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator(".sc-img:not(.uploading) img")).toHaveCount(1);

    await page.evaluate((b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u], "paste.png", { type: "image/png" }));
      document.querySelector(".script-doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG.toString("base64"));
    await expect(page.locator(".sc-img:not(.uploading)")).toHaveCount(2);

    await page.locator(".sc-img").first().click();
    await expect(page.locator(".sc-imgbar")).toBeVisible();
    await page.locator(".sc-imgbar .tb", { hasText: "50%" }).click();
    await page.locator(".sc-imgbar .tb[title='Căn phải']").click();
    const h = await bodyHtml(page);
    expect(h).toMatch(/<img data-image-id="[a-f0-9]{24}\.(webp|png)" data-script-id="scr_[^"]+" alt="" data-width="50" data-align="right"/);
    expect(h).not.toContain("data:image");

    await expect(page.locator(".sc-saved")).toHaveText(/Đã lưu/, { timeout: 6000 });
    await page.reload();
    await expect(page.locator(".script-doc .sc-img")).toHaveCount(2);
    await expect(page.locator(".sc-img[data-align='right'] .sc-img-box")).toHaveAttribute("style", /width: 50%/);
    await expect.poll(() => page.locator(".sc-img img").evaluateAll((l) => l.every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
  });
});
