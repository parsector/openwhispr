const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isEnterpriseConsoleAvailable,
  hasSharedDictionaryPlan,
} = require("../../src/lib/workspaceBilling.ts");

const workspace = (overrides = {}) => ({
  plan: "free",
  status: "active",
  role: "owner",
  ...overrides,
});

test("isEnterpriseConsoleAvailable: entitled Enterprise plan for owners and admins only", () => {
  const enterprise = (overrides) => workspace({ plan: "enterprise", ...overrides });
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "owner" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "admin" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "member" })), false);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "trialing" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "past_due" })), false);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "canceled" })), false);
  assert.equal(isEnterpriseConsoleAvailable(workspace({ plan: "business", role: "owner" })), false);
});

test("hasSharedDictionaryPlan grants entitled Business and Enterprise workspaces", () => {
  for (const plan of ["business", "enterprise"]) {
    assert.equal(hasSharedDictionaryPlan({ plan, status: "active" }), true);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "trialing" }), true);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "past_due" }), false);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "canceled" }), false);
  }
  for (const plan of ["free", "pro"]) {
    assert.equal(hasSharedDictionaryPlan({ plan, status: "active" }), false);
  }
  assert.equal(hasSharedDictionaryPlan(null), false);
  assert.equal(hasSharedDictionaryPlan(undefined), false);
});

test("workspace billing module has no self-serve commerce entry point", () => {
  const billing = require("../../src/lib/workspaceBilling.ts");
  assert.equal(billing.canSelfServeEnterprise, undefined);
  assert.equal(billing.canUpgradeWorkspaceToEnterprise, undefined);
  assert.equal(billing.enterpriseTileCta, undefined);
});
