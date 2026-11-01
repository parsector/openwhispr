const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const en = require("../../src/locales/en/translation.json");

test("Clear History describes account and device cleanup without showing a retired sync label", () => {
  const confirmationCopy = en.controlPanel.history.clearAllDescription;
  const signedOutConfirmationCopy = en.controlPanel.history.clearAllDescriptionDevice;

  const sourceRoot = path.join(__dirname, "../../src");
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "locales" && entry.name !== "generated" && entry.name !== "dist")
          visit(path.join(directory, entry.name));
      } else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        const file = path.join(directory, entry.name);
        assert.ok(!fs.readFileSync(file, "utf8").includes("insightsSyncDescription"), file);
      }
    }
  };
  visit(sourceRoot);
  assert.match(confirmationCopy, /Insights|counters/);
  assert.match(confirmationCopy, /account/);
  assert.match(signedOutConfirmationCopy, /device/);
  assert.match(signedOutConfirmationCopy, /not affected/);
});
