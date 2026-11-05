const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

test("person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes", async (t) => {
  const root = path.join(__dirname, "../../src");
  const modulePath = path.join(root, "voice-exemplar-proof.tsx");
  const wav = Buffer.alloc(44 + 4800 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures/people-proof.tsx"), "utf8");
  const inject = `
    rows[0].exemplars = [{ id: "permanent-clip", durationSeconds: 3.5, meetingDate: "2026-10-30 12:00:00", createdAt: "2026-11-05" }];
    window.electronAPI.playVoiceEnrollmentCandidate = async (id) => {
      window.playedExemplar = id;
      return { state: "available", wav: ${JSON.stringify(wav.toString("base64"))} };
    };
    window.electronAPI.listVoiceEnrollmentCandidates = async () => { throw Error("Note audio is expired"); };
  `;
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    configFile: path.join(root, "vite.config.mjs"),
    server: { port: 0, host: "127.0.0.1" },
    plugins: [
      {
        name: "voice-exemplar-proof",
        resolveId(id) {
          if (id === "/voice-exemplar-proof.tsx" || id === modulePath) return modulePath;
        },
        load(id) {
          if (id === modulePath)
            return fixture.replace(
              'createRoot(document.getElementById("root")!)',
              inject + '\ncreateRoot(document.getElementById("root")!)'
            );
        },
        configureServer(vite) {
          vite.middlewares.use("/voice-exemplar-proof.html", async (_req, res) => {
            const html = fs
              .readFileSync(path.join(__dirname, "fixtures/people-proof.html"), "utf8")
              .replace("/people-proof.tsx", "/voice-exemplar-proof.tsx");
            res.setHeader("Content-Type", "text/html");
            res.end(await vite.transformIndexHtml("/voice-exemplar-proof.html", html));
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/voice-exemplar-proof.html`);
  const row = page.locator('[data-person-row="1"]');
  await row
    .getByText(
      "This clip is kept until the person is deleted, independently of recording retention."
    )
    .waitFor();
  assert.match(await row.textContent(), /3.5 s/);
  await row.getByRole("button", { name: "Listen", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
  assert.equal(await page.evaluate(() => window.playedExemplar), "permanent-clip");
  assert.equal(await page.getByRole("heading", { name: /Transcript/ }).count(), 0);
  const artifacts = path.join(__dirname, "../../artifacts/enrolment-audio-retention");
  fs.mkdirSync(artifacts, { recursive: true });
  for (const width of [1440, 412]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark
      );
      assert.ok(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({
        path: path.join(artifacts, `${width}-${dark ? "dark" : "light"}.png`),
      });
    }
  }
  await page.evaluate(() => {
    window.electronAPI.playVoiceEnrollmentCandidate = async () => ({
      state: "key_unavailable",
      error: "exemplar_key_unavailable",
    });
  });
  await row.getByRole("button", { name: "Listen", exact: true }).click();
  await row
    .getByRole("alert")
    .filter({
      hasText: "The saved clip cannot be played because its encryption key is unavailable.",
    })
    .waitFor();
  assert.doesNotMatch(await row.getByRole("alert").textContent(), /No exemplar was saved/);
  assert.deepEqual(errors, []);
});
