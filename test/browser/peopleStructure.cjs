const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const repo = path.join(__dirname, "../..");
const src = path.join(repo, "src");
const fixtures = path.join(repo, "test/browser/fixtures");
const browserPath = process.env.PEOPLE_CHROMIUM_PATH || chromium.executablePath();

test(
  "People keeps its list independent of history and preserves state across child pages and review",
  { skip: !fs.existsSync(browserPath) && "Chromium is unavailable" },
  async (t) => {
    const html = path.join(src, "people-structure.browser.html");
    const tsx = path.join(src, "people-structure.browser.tsx");
    fs.copyFileSync(path.join(fixtures, "people-proof.html"), html);
    fs.copyFileSync(path.join(fixtures, "people-proof.tsx"), tsx);
    fs.writeFileSync(
      html,
      fs.readFileSync(html, "utf8").replace("/people-proof.tsx", "/people-structure.browser.tsx")
    );
    t.after(() => {
      fs.rmSync(html, { force: true });
      fs.rmSync(tsx, { force: true });
    });
    const { createServer } = await import("vite");
    const server = await createServer({
      root: src,
      configFile: path.join(src, "vite.config.mjs"),
      server: { port: 0, host: "127.0.0.1" },
    });
    await server.listen();
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 412, height: 720 } });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-structure.browser.html?history-fail`
    );
    await page.locator('[data-person-row="1"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "History" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Voice settings" }).count(), 1);
    assert.equal(await page.getByRole("region", { name: "Speaker calibration" }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "Action history" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Clear all voice data" }).count(), 0);
    await page.getByRole("textbox", { name: "Search people" }).fill("Rivera");
    await page.getByRole("combobox", { name: "Sort people" }).click();
    await page.getByRole("option", { name: "Last seen" }).click();
    await page.evaluate(() => window.scrollTo(0, 200));
    const before = await page.evaluate(() => window.scrollY);
    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("heading", { name: "Action history" }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('nav[aria-label="History"] button');
      return button === document.activeElement;
    });
    assert.equal(await page.getByRole("alert").count(), 1);
    await page.getByRole("button", { name: "People" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Search people" }).inputValue(), "Rivera");
    assert.equal(
      await page.getByRole("combobox", { name: "Sort people" }).textContent(),
      "Last seen"
    );
    assert.equal(await page.evaluate(() => window.scrollY), before);
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(
        (el) => el.textContent?.trim() === "History"
      );
      return button === document.activeElement;
    });
    await page.getByRole("button", { name: "Voice settings" }).click();
    await page.getByRole("region", { name: "Speaker calibration" }).waitFor();
    await page.getByRole("heading", { name: "Voice data" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Clear all voice data" }).count(), 1);
    await page.getByRole("button", { name: "People" }).click();
    const trigger = page.getByRole("button", { name: "Review rows" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Review rows" });
    await dialog.waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-structure.browser.html?calibration-fail`
    );
    await page.locator('[data-person-row="1"]').waitFor();
    await page.getByRole("button", { name: "Voice settings" }).click();
    await page.getByText("Calibration settings unavailable").waitFor();
    await page.getByRole("button", { name: "People" }).click();
    assert.equal(await page.locator('[data-person-row="1"]').count(), 1);
    await page.getByRole("button", { name: "Review rows" }).click();
    await page
      .getByRole("dialog", { name: "Review rows" })
      .getByRole("button", { name: "Open row" })
      .click();
    await page.getByText("View Transcript").waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.openedRow), "row-1");

    const screenshots = path.join(repo, "artifacts/people-structure");
    fs.mkdirSync(screenshots, { recursive: true });
    await page.evaluate(() => sessionStorage.removeItem("peopleReviewReturn"));
    await page.evaluate(() => sessionStorage.removeItem("peopleListReturn"));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-structure.browser.html?proof-rich`
    );
    await page.locator('[data-person-row="1"]').waitFor();
    for (const width of [1440, 412]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          theme === "dark"
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-people.png`) });
        await page.getByRole("button", { name: "History" }).click();
        await page.getByRole("button", { name: "Undo" }).waitFor();
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-history.png`) });
        await page
          .getByRole("navigation", { name: "History" })
          .getByRole("button", { name: "People" })
          .click();
        await page.getByRole("button", { name: "Voice settings" }).click();
        await page.getByRole("region", { name: "Speaker calibration" }).waitFor();
        await page.screenshot({
          path: path.join(screenshots, `${width}-${theme}-voice-settings.png`),
          fullPage: true,
        });
        await page
          .getByRole("navigation", { name: "Voice settings" })
          .getByRole("button", { name: "People" })
          .click();
        await page.getByRole("button", { name: "Review rows" }).click();
        await page.getByRole("dialog", { name: "Review rows" }).waitFor();
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-review.png`) });
        await page.keyboard.press("Escape");
      }
    }
  }
);
