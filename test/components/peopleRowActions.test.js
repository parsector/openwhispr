/* global document, innerHeight, scrollY */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const repo = path.join(__dirname, "../..");
const src = path.join(repo, "src");
const fixtures = path.join(repo, "test/browser/fixtures");
const browserPath =
  process.env.PEOPLE_CHROMIUM_PATH ||
  (process.arch === "arm64" &&
  fs.existsSync("/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome")
    ? "/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome"
    : chromium.executablePath());

test(
  "People actions stay in their row and Cancel restores it with focus and scroll",
  {
    skip: !fs.existsSync(browserPath) && "Playwright Chromium is not installed",
  },
  async (t) => {
    const html = path.join(src, "people-proof.browser.html");
    const tsx = path.join(src, "people-proof.browser.tsx");
    fs.copyFileSync(path.join(fixtures, "people-proof.html"), html);
    fs.copyFileSync(path.join(fixtures, "people-proof.tsx"), tsx);
    fs.writeFileSync(
      html,
      fs.readFileSync(html, "utf8").replace("/people-proof.tsx", "/people-proof.browser.tsx")
    );
    t.after(() => {
      fs.rmSync(html, { force: true });
      fs.rmSync(tsx, { force: true });
    });
    const { createServer } = await import("vite");
    const server = await createServer({
      root: src,
      configFile: path.join(src, "vite.config.mjs"),
      server: { port: 0, strictPort: false, host: "127.0.0.1" },
    });
    await server.listen();
    t.after(() => server.close());
    const port = server.httpServer.address().port;
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);
    await page.goto(`http://127.0.0.1:${port}/people-proof.browser.html`);
    const row = page.locator('[data-person-row="1"]');
    await row.waitFor();
    const originalText = await row.textContent();
    const originalHeight = await row.evaluate((element) => element.getBoundingClientRect().height);
    const trigger = row.locator('[data-person-menu="1"]');
    await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const scrollBefore = await page.evaluate(() => scrollY);
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await page.getByRole("menuitem", { name: "Delete person" }).click();
    const question = row.getByRole("alertdialog");
    await question.getByText(/Deletion cannot be undone/).waitFor();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 1);
    assert.equal(await page.locator('[role="alertdialog"]').count(), 1);
    assert.equal(
      await row.evaluate((element) => element.parentElement.nextElementSibling),
      null,
      "the list has no trailing action panel"
    );
    assert.match(await question.textContent(), /10 notes, 895 segments, 2 history entries/);
    assert.match(await question.textContent(), /4 note voice embeddings/);
    assert.equal(await page.evaluate(() => scrollY), scrollBefore);
    assert.equal(
      await row.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top < innerHeight && rect.bottom > 0;
      }),
      true
    );
    const cancel = question.getByRole("button", { name: "Cancel" });
    assert.equal(await cancel.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Tab");
    assert.equal(
      await question
        .getByRole("button", { name: "Delete person" })
        .evaluate((element) => document.activeElement === element),
      true
    );
    await page.keyboard.press("Tab");
    assert.equal(await cancel.evaluate((element) => document.activeElement === element), true);
    await cancel.click();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 0);
    assert.equal(await row.textContent(), originalText);
    assert.equal(
      await row.evaluate((element) => element.getBoundingClientRect().height),
      originalHeight
    );
    assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);

    await trigger.click();
    await page.getByRole("menuitem", { name: "Merge into…" }).click();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 1);
    assert.equal(
      await row
        .getByRole("combobox", { name: "Keep this person" })
        .evaluate((element) => document.activeElement === element),
      true
    );
    await row.getByRole("combobox", { name: "Keep this person" }).click();
    await page.getByRole("option", { name: "Maya Chen" }).click();
    assert.match(
      await row.getByRole("alertdialog").textContent(),
      /10 notes, 895 segments, 3 pinned names/
    );
    const other = page.locator('[data-person-row="2"]');
    await other.locator('[data-person-menu="2"]').click();
    await page.getByRole("menuitem", { name: "Delete person" }).click();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 0);
    assert.equal(await other.locator('[role="alertdialog"]').count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await other.locator('[role="alertdialog"]').count(), 0);
    await row.getByRole("button", { name: /Rename/ }).click();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 1);
    assert.equal(
      await row
        .getByRole("textbox", { name: "New name" })
        .evaluate((element) => document.activeElement === element),
      true
    );
    await page.keyboard.press("Escape");
    assert.equal(await row.textContent(), originalText);
    assert.equal(
      await row
        .locator('[data-rename-trigger="1"]')
        .evaluate((element) => document.activeElement === element),
      true
    );
    await row.getByRole("button", { name: /Rename/ }).click();
    await row.getByRole("textbox", { name: "New name" }).fill("Alexandra New");
    await page.keyboard.press("Enter");
    await row.getByText("Alexandra New", { exact: true }).waitFor();
    assert.equal(await row.locator('[role="alertdialog"]').count(), 0);
    assert.equal(
      await row
        .locator('[data-rename-trigger="1"]')
        .evaluate((element) => document.activeElement === element),
      true
    );
    const voice = page.locator('[data-person-row="3"]');
    await voice.locator('[data-person-menu="3"]').click();
    await page.getByRole("menuitem", { name: "Reset voice" }).click();
    assert.match(await voice.getByRole("alertdialog").textContent(), /2 samples/);
    await page.keyboard.press("Escape");
    assert.equal(await voice.locator('[role="alertdialog"]').count(), 0);
  }
);
