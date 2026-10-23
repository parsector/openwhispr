const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function filesUnder(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(name);
    return /\.(?:ts|tsx|js|jsx)$/.test(entry.name) ? [name] : [];
  });
}

test("Settings has no billing section or route", () => {
  const modal = source("src/components/SettingsModal.tsx");
  const page = source("src/components/SettingsPage.tsx");
  assert.doesNotMatch(modal, /plansBilling|CreditCard/);
  assert.doesNotMatch(page, /plansBilling|case "plansBilling"/);
  assert.doesNotMatch(source("src/components/ControlPanel.tsx"), /plansBilling/);
  assert.doesNotMatch(source("src/components/SettingsPage.tsx"), /EnterpriseCheckoutDialog/);
});

test("renderer and main contain no checkout, portal, or plan-switch call site", () => {
  const paths = [
    ...filesUnder("src/components"),
    ...filesUnder("src/hooks"),
    ...filesUnder("src/services"),
    "src/helpers/ipcHandlers.js",
    "preload.js",
    "main.js",
  ];
  for (const file of paths) {
    const text = source(file);
    assert.doesNotMatch(text, /\b(?:cloudCheckout|cloudBillingPortal|cloudSwitchPlan|cloudPreviewSwitch|billingCheckout|billingPortal|upgradeToEnterprise|openCheckout|openBillingPortal|UpsellBar)\b/, file);
    assert.doesNotMatch(text, /\/api\/stripe\/(?:checkout|portal|switch-plan|preview-switch)/, file);
  }
  assert.doesNotMatch(source("src/services/WorkspacesService.ts"), /\/billing\//);
});

test("locked integrations and cloud upload use neutral notices", () => {
  assert.match(source("src/components/IntegrationsView.tsx"), /common\.unavailableInBuild/);
  assert.match(source("src/components/integrations/McpPane.tsx"), /common\.unavailableInBuild/);
  assert.match(source("src/components/ConnectorsSection.tsx"), /common\.unavailableInBuild/);
  assert.match(source("src/components/notes/UploadAudioView.tsx"), /cloudLimitUnavailable/);
  assert.match(source("src/hooks/useUsage.ts"), /hasPaidAccessOptimistic/);
});
