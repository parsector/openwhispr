const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function sources(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.name === "__tests__" || entry.name === "generated") return [];
    return entry.isDirectory() ? sources(file) : /\.[jt]sx?$/.test(file) ? [file] : [];
  });
}

test("removed event and creator subsystems have no queue, IPC or completion call site", () => {
  for (const file of [
    "src/helpers/productEvents.js",
    "src/helpers/metaActivation.js",
    "src/helpers/affiliateLinks.js",
    "src/stores/affiliateStore.ts",
    "docs/affiliate-integration.md",
    "openwhispr-mobile/src/lib/productEvents.ts",
    "openwhispr-mobile/src/lib/affiliateLink.ts",
    "openwhispr-mobile/src/lib/appsflyer.ts",
    "openwhispr-mobile/src/lib/revenuecat.ts",
    "openwhispr-mobile/src/hooks/useRevenueCatIdentity.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  for (const file of ["main.js", "preload.js", ...sources("src"), ...sources("openwhispr-mobile/src"), ...sources("openwhispr-mobile/app")]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(
      source,
      /product-events-record-|createProductEventsStore|\bMetaActivation\b|\brecordProductEventAppSession\b|\brecordOnboardingCompleted\b|\brecordDictationCompleted\b|\b_reportDictation\b|affiliate-(?:get-candidate|save-candidate|resolve-link)|from ['"][^'"]*(?:appsflyer|revenuecat|affiliate(?:Link|Store|Offer|Paywall|Attribution))['"]/,
      file
    );
  }
});
