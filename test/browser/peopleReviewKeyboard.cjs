const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const repo = path.join(__dirname, "../..");
const src = path.join(repo, "src");
const fixtures = path.join(__dirname, "fixtures");
const browserPath = process.env.PEOPLE_CHROMIUM_PATH || chromium.executablePath();

test(
  "Review rows keeps keyboard focus through cached row replacement",
  { skip: !fs.existsSync(browserPath) && "Chromium is unavailable" },
  async (t) => {
    const html = path.join(src, "people-review-keyboard.browser.html");
    const tsx = path.join(src, "people-review-keyboard.browser.tsx");
    fs.copyFileSync(path.join(fixtures, "people-proof.html"), html);
    fs.copyFileSync(path.join(fixtures, "people-proof.tsx"), tsx);
    fs.writeFileSync(
      html,
      fs
        .readFileSync(html, "utf8")
        .replace("/people-proof.tsx", "/people-review-keyboard.browser.tsx")
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
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-review-keyboard.browser.html`
    );

    const trigger = page.getByRole("button", { name: "Review rows" });
    await trigger.waitFor();
    await page.getByRole("tab", { name: "People", exact: true }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);

    await page.evaluate(async () => {
      const row = (await window.electronAPI.listPeopleReview())[0];
      const retained = { ...row, rowId: "retained", speakerDecision: { candidateSetStatus: "not_recorded" } };
      window.electronAPI.listPeopleReviewPage = (noteId) =>
        noteId === null
          ? Promise.resolve({ rows: [{ ...row, rowId: "removed" }, retained], pending: [42] })
          : new Promise((resolve) => {
              window.finishReviewPage = () => resolve({ rows: [retained], pending: [] });
            });
    });
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Review rows" });
    await dialog.waitFor();
    const openRows = dialog.getByRole("button", { name: "Open row" });
    await openRows.first().focus();
    assert.equal(await dialog.getByText('Candidate set not recorded', { exact: true }).count(), 1);
    await page.waitForFunction(() => typeof window.finishReviewPage === "function");
    await page.evaluate(() => window.finishReviewPage());
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="dialog"] button')].filter(
          (button) => button.textContent.trim() === "Open row"
        ).length === 1
    );
    assert.equal(await openRows.count(), 1);
    assert.equal(await openRows.first().evaluate((el) => el === document.activeElement), true);
    if (process.env.PEOPLE_REVIEW_SCREENSHOT)
      await page.screenshot({ path: process.env.PEOPLE_REVIEW_SCREENSHOT });

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press("Space");
    await dialog.waitFor();
  }
);
