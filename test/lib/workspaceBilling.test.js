const test = require("node:test");
const assert = require("node:assert/strict");
const { isEnterpriseConsoleAvailable } = require("../../src/lib/workspaceBilling.ts");

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
