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

test("businessDowngradeAction: active eligible billing workspace wins before billing method", () => {
  const provisioned = workspace({ id: "provisioned", plan: "enterprise" });
  const stripe = workspace({ id: "stripe", plan: "enterprise", stripe_subscription_id: "sub_1" });
  const workspaces = [provisioned, stripe];
  assert.deepEqual(businessDowngradeAction(workspaces, "provisioned"), { kind: "contactSales" });
  assert.deepEqual(businessDowngradeAction(workspaces, "stripe"), {
    kind: "stripePortal",
    workspaceId: "stripe",
  });
  for (const activeWorkspaceId of [null, "missing"]) {
    assert.deepEqual(businessDowngradeAction(workspaces, activeWorkspaceId), {
      kind: "contactSales",
    });
  }
});

test("businessDowngradeAction: skips ineligible active workspaces and respects billing capabilities", () => {
  const fallback = workspace({ id: "fallback", plan: "enterprise" });
  for (const overrides of [
    { status: "past_due" },
    { status: "canceled" },
    { plan: "business" },
    { role: "member" },
    { capabilities: { manage_billing: false } },
  ]) {
    const active = workspace({
      id: "active",
      plan: "enterprise",
      stripe_subscription_id: "sub_1",
      ...overrides,
    });
    assert.deepEqual(businessDowngradeAction([active, fallback], "active"), {
      kind: "contactSales",
    });
    assert.equal(businessDowngradeAction([active], "active"), null);
  }
  const delegated = workspace({
    id: "delegated",
    plan: "enterprise",
    role: "member",
    status: "trialing",
    capabilities: { manage_billing: true },
    stripe_subscription_id: "sub_delegated",
  });
  assert.deepEqual(businessDowngradeAction([fallback, delegated], "delegated"), {
    kind: "stripePortal",
    workspaceId: "delegated",
  });
});
