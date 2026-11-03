const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

async function mountDialog(t, overrides = {}, stateOverrides = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__inviteTest;
  });
  const state = {
    workspaces: [{ id: "w1", seats: 2, stripe_subscription_id: null }],
    seatsUsed: 1,
    sends: [],
    toasts: [],
    invited: [],
    closed: [],
    ...stateOverrides,
  };
  globalThis.__inviteTest = state;
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-teammate-own-dialog-",
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({ t: (key) => key });
      `,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children }) => React.createElement("div", null, children);
        export const DialogContent = ({ children }) => React.createElement("div", null, children);
        export const DialogHeader = ({ children }) => React.createElement("div", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
        export const DialogFooter = ({ children }) => React.createElement("div", null, children);
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) => selector(globalThis.__inviteTest);
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          list: async () => globalThis.__inviteTest.workspaces.map((workspace) => ({
            ...workspace, seats_used: globalThis.__inviteTest.seatsUsed,
          })),
          listMembers: async () => [],
        };
      `,
      "/services/InvitationsService": `
        export const InvitationsService = {
          send: async (workspaceId, payload) => {
            globalThis.__inviteTest.sends.push({ workspaceId, payload });
            if (globalThis.__inviteTest.sendGate) await globalThis.__inviteTest.sendGate;
            if (globalThis.__inviteTest.sendError) throw globalThis.__inviteTest.sendError;
            return { email_sent: globalThis.__inviteTest.emailSent ?? true };
          },
        };
      `,
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (message) => globalThis.__inviteTest.toasts.push(message),
        });
      `,
    },
  });
  const { default: InviteTeammateDialog } = await vite.ssrLoadModule(
    "/components/InviteTeammateDialog.tsx"
  );
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(InviteTeammateDialog, {
        open: true,
        onOpenChange: (open) => state.closed.push(open),
        workspaceId: "w1",
        workspaceName: "Acme",
        initialEmail: "A@X.com",
        teamIds: ["t1"],
        cancelLabel: "Skip",
        onInvited: (email) => state.invited.push(email),
        ...overrides,
      })
    )
  );
  return { container, state };
}

test("existing callers send one normalized invitation and receive its email", async (t) => {
  const { container, state } = await mountDialog(t);
  assert.equal(
    findElement(container, (node) => node.getAttribute?.("id") === "invite-email")?.value,
    "A@X.com"
  );
  assert.match(container.textContent, /Skip/);
  await React.act(async () =>
    findElement(container, (node) => node.tagName === "FORM").dispatchEvent({
      type: "submit",
      bubbles: true,
      cancelable: true,
    })
  );
  assert.deepEqual(state.sends, [
    { workspaceId: "w1", payload: { email: "a@x.com", role: "member", team_ids: ["t1"] } },
  ]);
  assert.deepEqual(state.invited, ["a@x.com"]);
  assert.deepEqual(state.closed, [false]);
});

test("a subscribed workspace with no spare seat cannot send an invitation", async (t) => {
  const { container, state } = await mountDialog(
    t,
    {},
    { workspaces: [{ id: "w1", seats: 2, stripe_subscription_id: "sub_1" }], seatsUsed: 2 }
  );
  const send = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.getAttribute("type") === "submit"
  );
  assert.equal(send?.getAttribute("disabled"), "");
  assert.deepEqual(state.sends, []);
  assert.doesNotMatch(container.textContent, /seatCost|checkout|upgrade/i);
});

test("a subscribed workspace with an unknown seat count stays blocked", async (t) => {
  const { container } = await mountDialog(
    t,
    {},
    { workspaces: [{ id: "w1", seats: 2, stripe_subscription_id: "sub_1" }], seatsUsed: null }
  );
  const send = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.getAttribute("type") === "submit"
  );
  assert.equal(send.getAttribute("disabled"), "");
  assert.match(container.textContent, /common.unavailableInBuild/);
});

test("an unsubscribed workspace can invite without a known seat count", async (t) => {
  const { container } = await mountDialog(t, {}, { seatsUsed: null });
  const send = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.getAttribute("type") === "submit"
  );
  assert.equal(send.getAttribute("disabled"), null);
});

test("space scope goes with the invitation", async (t) => {
  const { container, state } = await mountDialog(t, { teamIds: undefined, spaceIds: ["space-1"] });
  await React.act(async () =>
    findElement(container, (node) => node.tagName === "FORM").dispatchEvent({
      type: "submit",
      bubbles: true,
      cancelable: true,
    })
  );
  assert.deepEqual(state.sends[0].payload, {
    email: "a@x.com",
    role: "member",
    space_ids: ["space-1"],
  });
});

test("an invitation whose email failed still reports the invitation", async (t) => {
  const { container, state } = await mountDialog(t, {}, { emailSent: false });
  await React.act(async () =>
    findElement(container, (node) => node.tagName === "FORM").dispatchEvent({
      type: "submit",
      bubbles: true,
      cancelable: true,
    })
  );
  assert.deepEqual(state.invited, ["a@x.com"]);
  assert.equal(state.toasts[0].variant, "destructive");
});

test("a server refusal keeps the dialog open and reports no invitation", async (t) => {
  const { container, state } = await mountDialog(t, {}, { sendError: new Error("refused") });
  await React.act(async () =>
    findElement(container, (node) => node.tagName === "FORM").dispatchEvent({
      type: "submit",
      bubbles: true,
      cancelable: true,
    })
  );
  assert.deepEqual(state.invited, []);
  assert.deepEqual(state.closed, []);
  assert.equal(state.toasts[0].description, "refused");
});
