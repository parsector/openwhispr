const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourceRoot = path.resolve(__dirname, "../../src");

test("the fork does not keep the upstream plan hook or its entry points", () => {
  assert.equal(existsSync(path.join(sourceRoot, "hooks/useAccountPlan.ts")), false);
  for (const file of ["components/ProfileMenu.tsx", "components/SettingsPage.tsx"]) {
    const source = readFileSync(path.join(sourceRoot, file), "utf8");
    assert.doesNotMatch(source, /useAccountPlan|plansBilling/);
  }
});
