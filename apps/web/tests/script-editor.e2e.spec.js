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

  test("Nhắc chữ: words only, size from the screen, runs, pauses on a tap, keeps its line on resize", async ({ page }) => {
    await newScript(page);
    await page.locator(".script-doc").click();
    for (let i = 1; i <= 12; i++) {
      await page.keyboard.type("Đoạn " + i + ": anh em thân mến, hôm nay mình kể chuyện mua linh kiện mùa bão giá.");
      await page.keyboard.press("Enter");
    }
    await expect(page.locator(".sc-saved")).toHaveText(/Đã lưu/, { timeout: 6000 });
    await page.locator(".sc-prompt").click();
    await expect(page).toHaveURL(/\/nhac-chu$/);
    const text = page.locator(".pr-text");
    await expect(text).toContainText("Đoạn 12");
    await expect(page.locator(".prompter [contenteditable]")).toHaveCount(0);

    // size slider: range and starting size follow the column width
    const size = page.locator('.pr-slider input[aria-label="Cỡ chữ"]');
    const [min, val, max] = await size.evaluate((r) => [+r.min, +r.value, +r.max]);
    expect(min).toBeLessThan(val);
    expect(val).toBeLessThan(max);
    expect(await text.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(val);

    const scroller = page.locator(".pr-scroll");
    await page.locator(".pr-play").click();
    await expect(page.locator(".pr-count")).toBeVisible();
    await expect.poll(() => scroller.evaluate((e) => e.scrollTop), { timeout: 8000 }).toBeGreaterThan(20);
    await page.mouse.click(640, 400); // a tap on the words pauses
    const at = await scroller.evaluate((e) => e.scrollTop);
    await page.waitForTimeout(500);
    expect(await scroller.evaluate((e) => e.scrollTop)).toBe(at);

    // the same words stay on the reading line when the window changes
    await scroller.evaluate((e) => { e.scrollTop = 900; });
    const onLine = () => page.evaluate(() => {
      const eye = document.querySelector(".pr-eye").getBoundingClientRect();
      const r = document.querySelector(".pr-text").getBoundingClientRect();
      const c = document.caretRangeFromPoint(r.left + 20, eye.top + eye.height / 2);
      return c && c.startContainer.nodeValue ? c.startContainer.nodeValue.split(":")[0] : null;
    });
    const before = await onLine();
    await page.setViewportSize({ width: 600, height: 800 });
    await expect.poll(onLine).toBe(before);

    await page.keyboard.press("Escape");
    await expect(page.locator(".script-doc")).toBeVisible();
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
