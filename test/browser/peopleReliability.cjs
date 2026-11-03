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
  "People reliability: review return, stable refresh, isolated failure, guarded clear, and mutation focus",
  {
    skip: !fs.existsSync(browserPath) && "Chromium is unavailable",
  },
  async (t) => {
    const html = path.join(src, "people-reliability.browser.html");
    const tsx = path.join(src, "people-reliability.browser.tsx");
    fs.copyFileSync(path.join(fixtures, "people-proof.html"), html);
    fs.copyFileSync(path.join(fixtures, "people-proof.tsx"), tsx);
    fs.writeFileSync(
      html,
      fs.readFileSync(html, "utf8").replace("/people-proof.tsx", "/people-reliability.browser.tsx")
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const screenshots = path.join(repo, "artifacts/people-reliability");
    fs.mkdirSync(screenshots, { recursive: true });
    const capture = async (scene) => {
      for (const width of [1440, 412]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            (dark) => document.documentElement.classList.toggle("dark", dark),
            theme === "dark"
          );
          if (scene === "enrollment-after-refresh")
            await page
              .getByRole("dialog", { name: /Enrol voice/ })
              .evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(350);
          await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${scene}.png`) });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
    };
    const base = `http://127.0.0.1:${server.httpServer.address().port}/people-reliability.browser.html`;
    await page.goto(`${base}?reliability`);
    await page.locator('[data-person-row="1"]').waitFor();
    await page.getByRole("textbox", { name: "Search people" }).fill("Alex");
    await page.getByRole("combobox", { name: "Sort people" }).click();
    await page.getByRole("option", { name: "Last seen" }).click();

    await page.getByRole("button", { name: "Review rows" }).click();
    const review = page.getByRole("dialog", { name: "Review rows" });
    await review.getByRole("combobox", { name: "Filter by reason" }).click();
    await page.getByRole("option", { name: "Not assessed" }).click();
    await review.getByRole("combobox", { name: "Filter by person" }).click();
    await page.getByRole("option", { name: "Alexandra Rivera" }).click();
    await review.getByRole("button", { name: "Show more" }).click();
    const reviewScroller = review.locator(".overflow-y-auto").first();
    await reviewScroller.evaluate((el) => {
      el.scrollTop = 700;
    });
    const reviewPosition = await reviewScroller.evaluate((el) => el.scrollTop);
    assert.ok(reviewPosition > 0);
    await page.evaluate(() => {
      const original = window.electronAPI.listPeopleReview;
      window.electronAPI.listPeopleReview = (...args) =>
        new Promise((resolve) => {
          window.finishReviewReload = async () => resolve(await original(...args));
        });
    });
    await review.getByRole("button", { name: "Open row" }).nth(10).click();
    await page.getByRole("heading", { name: "Transcript 42" }).waitFor();
    await page.getByRole("button", { name: "Return to review" }).click();
    await review.waitFor();
    await page.waitForTimeout(100);
    await page.evaluate(() => window.finishReviewReload());
    assert.equal(await review.getByRole("button", { name: "Open row" }).count(), 130);
    assert.equal(
      await review.getByRole("combobox", { name: "Filter by person" }).textContent(),
      "Alexandra Rivera"
    );
    assert.equal(
      await review.getByRole("combobox", { name: "Filter by reason" }).textContent(),
      "Not assessed"
    );
    await page.waitForFunction(
      (position) =>
        Math.abs(document.querySelector('[role="dialog"] .overflow-y-auto').scrollTop - position) <
        5,
      reviewPosition
    );
    await page.keyboard.press("Escape");
    await review.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "Search people" }).inputValue(), "Alex");
    assert.equal(
      await page.getByRole("combobox", { name: "Sort people" }).textContent(),
      "Last seen"
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Review rows" })
        .evaluate((el) => el === document.activeElement),
      true
    );

    const enroll = page
      .locator('[data-person-row="2"]')
      .getByRole("button", { name: "Enrol voice" });
    await enroll.click();
    const enrollment = page.getByRole("dialog", { name: /Enrol voice/ });
    await enrollment.waitFor();
    assert.equal(await enrollment.getAttribute("aria-modal"), null);
    await page.evaluate(() => {
      const api = window.electronAPI;
      const original = api.listPeople;
      api.listPeople = () =>
        new Promise((resolve) => {
          window.finishPeopleRefresh = (rows) => {
            api.listPeople = original;
            resolve(rows);
          };
        });
      window.peopleProof.refresh();
    });
    assert.equal(await enrollment.count(), 1);
    await page.evaluate(() =>
      window.finishPeopleRefresh(window.peopleProof.rows.map((row) => ({ ...row })))
    );
    assert.equal(await enrollment.count(), 1);
    assert.equal(await enrollment.evaluate((el) => el.contains(document.activeElement)), true);
    await page.getByText("View Transcript").waitFor({ state: "hidden" });
    await capture("enrollment-after-refresh");
    await enrollment.getByRole("button", { name: "Cancel" }).click();

    await page
      .locator('[data-person-row="1"]')
      .getByRole("button", { name: "Enrol voice" })
      .click();
    await page.getByRole("button", { name: "Split" }).click();
    await page.getByRole("heading", { name: "Transcript 42" }).waitFor();
    await page.getByRole("button", { name: "Return to review" }).click();
    await page.getByRole("dialog", { name: /Enrol voice/ }).waitFor();
    await page.keyboard.press("Escape");

    await page.goto(`${base}?history-fail`);
    await page.locator('[data-person-row="1"]').waitFor();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("alert").waitFor();
    await page
      .getByRole("navigation", { name: "History" })
      .getByRole("button", { name: "People" })
      .click();
    assert.equal(await page.locator('[data-person-row="1"]').count(), 1);

    await page.getByRole("button", { name: "Voice settings" }).click();
    await page.getByRole("button", { name: "Clear all voice data" }).click();
    const clear = page.getByRole("dialog", { name: "Clear all voice data" });
    await clear.waitFor();
    assert.equal(
      await clear.getByRole("textbox").evaluate((el) => el === document.activeElement),
      true
    );
    assert.match(await clear.textContent(), /20 people/);
    assert.match(await clear.textContent(), /2.*embeddings/);
    assert.match(await clear.textContent(), /4.*note.*embeddings/);
    assert.match(await clear.textContent(), /3.*mappings/);
    assert.match(await clear.textContent(), /samples/);
    assert.match(await clear.textContent(), /history/);
    const clearConfirm = clear.getByRole("button", { name: "Clear all voice data" });
    assert.equal(await clearConfirm.isDisabled(), true);
    await clear.getByRole("textbox").fill("Clear all voice data");
    assert.equal(await clearConfirm.isEnabled(), true);
    await capture("clear-confirmation");
    await page.keyboard.press("Escape");
    await clear.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByRole("button", { name: "Clear all voice data" })
        .evaluate((el) => el === document.activeElement),
      true
    );
    await page.getByRole("button", { name: "Clear all voice data" }).click();
    await clear.getByRole("textbox").fill("Clear all voice data");
    await page.evaluate(() => {
      window.electronAPI.clearVoiceData = () =>
        new Promise((resolve) => {
          window.finishClearVoice = () =>
            resolve({
              success: true,
              id: "clear-1",
              personCount: 20,
              embeddingCount: 2,
              mappingCount: 3,
            });
        });
    });
    await clearConfirm.click();
    assert.equal(await clear.getByRole("button", { name: "Saving…" }).isDisabled(), true);
    assert.equal(await clear.getByRole("button", { name: "Cancel" }).isDisabled(), true);
    assert.equal(await clear.getByRole("button", { name: "Close" }).isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await clear.count(), 1);
    assert.match(await clear.textContent(), /Saving/);
    await page.evaluate(() => window.finishClearVoice());
    await clear.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Undo" }).waitFor();

    await page
      .getByRole("navigation", { name: "Voice settings" })
      .getByRole("button", { name: "People" })
      .click();
    const row = page.locator('[data-person-row="1"]');
    await row.locator('[data-person-menu="1"]').click();
    await page.getByRole("menuitem", { name: "Merge into…" }).click();
    assert.equal(await row.getByRole("alertdialog").getAttribute("aria-modal"), null);
    await row.getByRole("combobox", { name: "Keep this person" }).click();
    await page.getByRole("option", { name: "Maya Chen" }).click();
    await page.evaluate(() => {
      window.electronAPI.applyPersonAction = (request) =>
        new Promise((resolve) => {
          window.finishPersonAction = () => {
            window.peopleProof.rows.splice(
              window.peopleProof.rows.findIndex((row) => row.id === request.profileId),
              1
            );
            resolve({ success: true, id: "merge-1" });
          };
        });
    });
    await row.getByRole("button", { name: "Merge into…" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await row.getByRole("alertdialog").count(), 1);
    assert.equal(await row.getByRole("combobox", { name: "Keep this person" }).isDisabled(), true);
    assert.equal(await page.locator('[data-person-menu="2"]').isDisabled(), true);
    assert.match(await row.getByRole("alertdialog").textContent(), /Saving/);
    await page.evaluate(() => window.finishPersonAction());
    await page.waitForFunction(() => document.activeElement?.closest('[data-person-row="3"]'));
    assert.equal(await page.locator('[data-person-row="1"]').count(), 0);
    assert.notEqual(
      await page.locator('[data-person-row="3"]').evaluate((el) => getComputedStyle(el).boxShadow),
      "none"
    );
    await capture("merge-focus");

    const tabUntil = async (selector, label) => {
      for (let i = 0; i < 150; i++) {
        await page.keyboard.press("Tab");
        if (
          await page.evaluate(
            ({ selector, label }) => {
              const focused = document.activeElement;
              return (
                focused?.matches(selector) && (!label || focused.textContent?.trim() === label)
              );
            },
            { selector, label }
          )
        )
          return;
      }
      assert.fail(`Keyboard could not reach ${label || selector}`);
    };
    for (const width of [1440, 412]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}?keyboard-${width}-${theme}`);
        await page.locator('[data-person-row="1"]').waitFor();
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          theme === "dark"
        );
        await tabUntil("button", "History");
        await page.keyboard.press("Enter");
        await page.getByRole("heading", { name: "Action history" }).waitFor();
        await page.keyboard.press("Enter");
        await tabUntil("button", "Voice settings");
        await page.keyboard.press("Enter");
        await page.getByRole("heading", { name: "Voice settings" }).last().waitFor();
        await tabUntil("button", "Clear all voice data");
        await page.keyboard.press("Enter");
        await page.getByRole("dialog", { name: "Clear all voice data" }).waitFor();
        await page.keyboard.press("Escape");
        await tabUntil("button", "People");
        await page.keyboard.press("Enter");
        await tabUntil("button", "Review rows");
        await page.keyboard.press("Enter");
        await page.getByRole("dialog", { name: "Review rows" }).waitFor();
        await tabUntil('button[role="combobox"]');
        await tabUntil("button", "Open row");
        await page.keyboard.press("Escape");
        await tabUntil('input[aria-label="Search people"]');
        await page.keyboard.type("Alex");
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
        await tabUntil('[data-rename-trigger="1"]');
        await page.keyboard.press("Enter");
        assert.equal(await page.getByRole("alertdialog").getAttribute("aria-modal"), null);
        assert.equal(
          await page
            .getByRole("textbox", { name: "New name" })
            .evaluate((el) => el === document.activeElement),
          true
        );
        await page.keyboard.press("Escape");
        await tabUntil('[data-enroll-trigger="1"]');
        await page.keyboard.press("Enter");
        await page.getByRole("dialog", { name: /Enrol voice/ }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(
          await page
            .locator('[data-enroll-trigger="1"]')
            .evaluate((el) => el === document.activeElement),
          true
        );
        await tabUntil('[data-person-menu="1"]');
        await page.keyboard.press("Enter");
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
      }
    }
  }
);
