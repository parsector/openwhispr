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
    assert.equal(await page.getByRole("tab", { name: "History" }).count(), 1);
    assert.equal(await page.getByRole("tab", { name: "Voice settings" }).count(), 1);
    assert.equal(
      await page.getByRole("tab", { name: "People" }).getAttribute("aria-selected"),
      "true"
    );
    await page.getByRole("tab", { name: "People" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.getByRole("tab", { name: "History" }).getAttribute("aria-selected"),
      "true"
    );
    await page.keyboard.press("ArrowLeft");
    assert.equal(
      await page.getByRole("tab", { name: "People" }).getAttribute("aria-selected"),
      "true"
    );
    assert.equal(await page.getByRole("region", { name: "Speaker calibration" }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "Action history" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Clear all voice data" }).count(), 0);
    await page.getByRole("textbox", { name: "Search people" }).fill("Rivera");
    await page.getByRole("combobox", { name: "Sort people" }).click();
    await page.getByRole("option", { name: "Last seen" }).click();
    await page.evaluate(() => window.scrollTo(0, 200));
    const before = await page.evaluate(() => window.scrollY);
    await page.getByRole("tab", { name: "History" }).click();
    await page.getByRole("heading", { name: "Action history" }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('[role="tab"][aria-selected="true"]');
      return button === document.activeElement;
    });
    assert.equal(await page.getByRole("alert").count(), 1);
    await page.getByRole("tab", { name: "People" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Search people" }).inputValue(), "Rivera");
    assert.equal(
      await page.getByRole("combobox", { name: "Sort people" }).textContent(),
      "Last seen"
    );
    assert.equal(await page.evaluate(() => window.scrollY), before);
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find(
        (el) => el.textContent?.trim() === "People"
      );
      return button === document.activeElement;
    });
    await page.getByRole("tab", { name: "History" }).click();
    await page.reload();
    assert.equal(
      await page.getByRole("tab", { name: "History" }).getAttribute("aria-selected"),
      "true"
    );
    await page.getByRole("tab", { name: "People" }).click();
    assert.equal(
      await page.getByRole("tab", { name: "People" }).getAttribute("aria-selected"),
      "true"
    );
    await page.getByRole("tab", { name: "Voice settings" }).click();
    await page.getByRole("region", { name: "Speaker calibration" }).waitFor();
    await page.getByRole("heading", { name: "Voice data" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Clear all voice data" }).count(), 1);
    await page.getByRole("tab", { name: "People" }).click();
    await page.evaluate(() => {
      const load = window.electronAPI.listPeopleReview;
      window.electronAPI.listPeopleReview = async () => [
        ...(await load()),
        {
          noteId: 42,
          rowId: "row-too-short",
          noteTitle: "October planning meeting",
          reason: "unassessed",
          candidates: null,
          profileId: 1,
          text: "This span is too short.",
          speakerName: "Alexandra Rivera",
          eligibilityReason: "short",
        },
      ];
    });
    const trigger = page.getByRole("button", { name: "Review rows" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Review rows" });
    await dialog.waitFor();
    const eligibleOnly = dialog.getByRole("checkbox", {
      name: "Only show rows eligible for voice samples",
    });
    assert.equal(await eligibleOnly.isChecked(), true);
    await dialog.getByText("Showing 1 of 2").waitFor();
    await eligibleOnly.uncheck();
    await dialog.getByText("Showing 2 of 2").waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-structure.browser.html?calibration-fail`
    );
    await page.locator('[data-person-row="1"]').waitFor();
    await page.getByRole("tab", { name: "Voice settings" }).click();
    await page.getByText("Calibration settings unavailable").waitFor();
    await page.getByRole("tab", { name: "People" }).click();
    assert.equal(await page.locator('[data-person-row="1"]').count(), 1);
    await page.getByRole("button", { name: "Review rows" }).click();
    const returnedReview = page.getByRole("dialog", { name: "Review rows" });
    const persistedToggle = returnedReview.getByRole("checkbox", {
      name: "Only show rows eligible for voice samples",
    });
    assert.equal(await persistedToggle.isChecked(), false);
    await persistedToggle.check();
    await returnedReview.getByRole("button", { name: "Open row" }).click();
    await page.getByText("View Transcript").waitFor();
    assert.equal(await page.evaluate(() => document.body.dataset.openedRow), "row-1");

    const screenshots = path.join(repo, "artifacts/people-structure");
    fs.mkdirSync(screenshots, { recursive: true });
    await page.evaluate(() => sessionStorage.removeItem("peopleReviewReturn"));
    await page.evaluate(() => sessionStorage.removeItem("peopleListReturn"));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/people-structure.browser.html?proof-rich`
    );
    await page.getByRole("tab", { name: "People" }).click();
    await page.locator('[data-person-row="1"]').waitFor();
    const resetScroll = () =>
      page.evaluate(() => {
        window.scrollTo(0, 0);
        const header = document.querySelector("[data-people-list-header]");
        const host = header?.closest(".overflow-y-auto");
        if (host) host.scrollTop = 0;
      });
    const measurements = [];
    for (const width of [1440, 412]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          theme === "dark"
        );
        await page.waitForTimeout(250);
        await resetScroll();
        const dimensions = await page.evaluate(() => {
          const read = (root) => {
            const description = root.querySelector("p");
            const tabRow = root.querySelector("[data-tab-button]")?.parentElement;
            const selected =
              root.querySelector('[data-tab-button][aria-selected="true"]') ||
              root.querySelector("[data-tab-button]");
            const indicator = tabRow?.firstElementChild;
            if (!description || !tabRow || !selected || !indicator) throw Error("Tabs are missing");
            const style = getComputedStyle(indicator);
            return {
              tabHeight: selected.getBoundingClientRect().height,
              iconLabelGap: getComputedStyle(selected).columnGap,
              selectedBackground: style.backgroundColor,
              selectedBorder: style.boxShadow,
              descriptionToTabs:
                tabRow.getBoundingClientRect().top - description.getBoundingClientRect().bottom,
            };
          };
          return {
            people: read(document.querySelector("[data-people-list-header]")),
            speechToText: read(document.querySelector("[data-speech-tab-reference]")),
          };
        });
        for (const key of Object.keys(dimensions.people)) {
          assert.equal(
            dimensions.people[key],
            dimensions.speechToText[key],
            `${width} ${theme}: ${key}`
          );
        }
        measurements.push({ width, theme, ...dimensions });
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-people.png`) });
        await page.getByRole("tab", { name: "History" }).click();
        await page.getByRole("button", { name: "Undo" }).waitFor();
        await page.waitForTimeout(250);
        assert.equal(
          await page.getByRole("tab", { name: "History" }).getAttribute("aria-selected"),
          "true"
        );
        await resetScroll();
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-history.png`) });
        await page.getByRole("tab", { name: "People" }).click();
        await page.getByRole("tab", { name: "Voice settings" }).click();
        await page.getByRole("region", { name: "Speaker calibration" }).waitFor();
        await page.waitForTimeout(250);
        assert.equal(
          await page.getByRole("tab", { name: "Voice settings" }).getAttribute("aria-selected"),
          "true"
        );
        await resetScroll();
        await page.screenshot({
          path: path.join(screenshots, `${width}-${theme}-voice-settings.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Review rows" }).click();
        await page.getByRole("dialog", { name: "Review rows" }).waitFor();
        await resetScroll();
        await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-review.png`) });
        await page.keyboard.press("Escape");
        await page.getByRole("tab", { name: "People" }).click();
      }
    }
    fs.writeFileSync(
      path.join(screenshots, "tab-measurements.json"),
      JSON.stringify(measurements, null, 2)
    );
  }
);
