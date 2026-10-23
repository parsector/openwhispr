const test = require("node:test");
const assert = require("node:assert/strict");

const en = require("../../src/locales/en/translation.json");

test("Clear History describes account and device cleanup without a retired sync label", () => {
  const confirmationCopy = en.controlPanel.history.clearAllDescription;
  const signedOutConfirmationCopy = en.controlPanel.history.clearAllDescriptionDevice;

  assert.equal(en.settingsPage.privacy.insightsSyncDescription, undefined);
  assert.match(confirmationCopy, /Insights|counters/);
  assert.match(confirmationCopy, /account/);
  assert.match(signedOutConfirmationCopy, /device/);
  assert.match(signedOutConfirmationCopy, /not affected/);
});
