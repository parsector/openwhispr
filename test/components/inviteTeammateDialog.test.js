const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function mountDialog(t, props, { realView = false } = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of [
      "__viewProps",
      "__sendCalls",
      "__seatPreview",
      "__sendGate",
      "__previewCalls",
      "__workspaces",
      "__sendOutcome",
      "__refreshCalls",
      "__members",
      "__memberListCalls",
      "__settingsRequests",
      "__toasts",
      "__sendOutcomes",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        searchInviteContacts: async () => ({ success: true, contacts: [] }),
        openSettingsSection: async (section) => {
          (globalThis.__settingsRequests ??= []).push(section);
          return { success: true };
        },
      },
    },
  });
  const container = installHostDom(t);
  globalThis.__sendCalls = [];
  globalThis.__previewCalls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-teammate-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/dialog": `
        import React from "react";
        const box = ({ children }) => React.createElement("div", null, children);
        export const Dialog = box;
        export const DialogContent = box;
        export const DialogTitle = box;
        export const DialogDescription = box;
      `,
      "/ui/dropdown-menu": `
        import React from "react";
        const box = ({ children }) => React.createElement("div", null, children);
        export const DropdownMenu = box;
        export const DropdownMenuTrigger = box;
        export const DropdownMenuContent = box;
        export const DropdownMenuRadioGroup = box;
        export const DropdownMenuRadioItem = box;
      `,
      // Records every render's props, so the test can read the state and press Send.
      ...(realView
        ? {}
        : {
            "/InvitePeopleView": `
              export function InvitePeopleView(props) {
                (globalThis.__viewProps ??= []).push(props);
                return null;
              }
            `,
          }),
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (toast) => {
            (globalThis.__toasts ??= []).push(toast);
            return "toast";
          },
        });
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          async sendInvitations(input) {
            globalThis.__sendCalls.push(input);
            if (globalThis.__sendGate) await globalThis.__sendGate;
            for (const email of input.emails) {
              input.onResult(
                email,
                globalThis.__sendOutcomes?.shift() ??
                  globalThis.__sendOutcome ?? { ok: true, emailSent: true }
              );
            }
          },
        };
      `,
      "/stores/workspaceStore": `
        export const useWorkspaceStore = (selector) =>
          selector({ workspaces: globalThis.__workspaces ?? [] });
        useWorkspaceStore.getState = () => ({
          workspaces: globalThis.__workspaces ?? [],
          refresh: async (options) => {
            (globalThis.__refreshCalls ??= []).push(options);
          },
        });
      `,
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          // Prices each added seat at the opening preview's amount.
          previewSeats: (workspaceId, seats) => {
            globalThis.__previewCalls.push(seats);
            return globalThis.__seatPreview
              ? Promise.resolve({
                  ...globalThis.__seatPreview,
                  amount_due: globalThis.__seatPreview.amount_due * seats,
                })
              : Promise.reject(new Error("no subscription"));
          },
          listMembers: async () => {
            globalThis.__memberListCalls = (globalThis.__memberListCalls ?? 0) + 1;
            return globalThis.__members ?? [];
          },
        };
      `,
    },
  });
  const { default: InviteTeammateDialog } = await vite.ssrLoadModule(
    "/components/InviteTeammateDialog.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(InviteTeammateDialog, props)));
  return {
    container,
    latest: () => globalThis.__viewProps.at(-1),
    rerender: async (overrides = {}) => {
      await React.act(async () =>
        root.render(React.createElement(InviteTeammateDialog, { ...props, ...overrides }))
      );
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("single-email callers preserve normalized scope and callback delivery", async (t) => {
  const invited = [];
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "A@X.com", teamIds: ["t1"], spaceIds: ["s1"], cancelLabel: "Skip",
    onInvited: (emails) => invited.push(emails),
  });
  assert.deepEqual(latest().state.recipients.map(r => r.email), ["a@x.com"]);
  assert.equal(latest().cancelLabel, "Skip");
  await React.act(async () => latest().onSend());
  assert.equal(globalThis.__sendCalls.length, 1);
  const call = globalThis.__sendCalls[0];
  assert.equal(call.workspaceId, "w1");
  assert.deepEqual(call.emails, ["a@x.com"]);
  assert.deepEqual(call.teamIds, ["t1"]);
  assert.deepEqual(call.spaceIds, ["s1"]);
  assert.equal(call.role, "member");
  assert.deepEqual(invited, [["a@x.com"]]);
  assert.equal(latest().state.phase, "done");
});

test("an email delivery failure still reports the created invitation", async (t) => {
  globalThis.__sendOutcome = { ok: true, emailSent: false };
  const invited = [];
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com", onInvited: emails => invited.push(emails),
  });
  await React.act(async () => latest().onSend());
  assert.deepEqual(invited, [["a@x.com"]]);
  assert.equal(latest().state.sent[0].emailSent, false);
});

test("a server refusal keeps the dialog open without reporting an invitation", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "refused", message: "refused" };
  const invited = [], closed = [];
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com", onInvited: emails => invited.push(emails),
    onOpenChange: open => closed.push(open),
  });
  await React.act(async () => latest().onSend());
  assert.deepEqual(invited, []);
  assert.deepEqual(closed, []);
  assert.equal(latest().state.phase, "editing");
  assert.equal(latest().state.recipients[0].state.message, "refused");
});

const WORKSPACE = { id: "w1", name: "Acme", role: "admin", seats: 20, seat_limit: 500 };

const OPENING_REFRESH = [];

async function mountWithWorkspace(t, workspace, props = {}, options) {
  globalThis.__workspaces = [workspace];
  return mountDialog(
    t,
    {
      open: true,
      onOpenChange: () => {},
      workspaceId: "w1",
      workspaceName: "Acme",
      ...props,
    },
    options
  );
}

test("fork has no paid invitation gate: seats left come from the workspace list", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: the seat line and the seat warning count the same seats", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: the seat line prefers the workspace list over the preview", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a free workspace hides the seat line and reads no members for it", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a free workspace on an older API without seats_used reads no members either", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a subscribed workspace shows the seat line", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a subscribed workspace with no count to show hides the line and reads no members", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a free workspace gets no seat warning", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: an older API without seat_limit has no ceiling check", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: without a roster, an existing address cannot block a valid batch near the ceiling", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: without a roster, a seat refusal still allows a valid mixed retry after trimming", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a complete roster keeps the server ceiling through refresh and a trimmed retry", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: a roster lost during sending cannot leave a blocking ceiling after refusal", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: Upgrade shows from every entry point", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: Upgrade closes the dialog and asks for Plan & Billing", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: admins never see it", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: Upgrade can't interrupt a send with seats already over", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: Upgrade pressed as a send starts leaves the run alone", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: opening reads the workspace list, since canceled invitations free seats", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("a team or teamspace invite tells the view skipped people aren't added", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { spaceIds: ["s1"] });

  assert.equal(latest().addsToContainer, true);
});

test("a workspace invite doesn't", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { teamIds: [] });

  assert.equal(latest().addsToContainer, false);
});

test("a ceiling refusal refreshes the workspace list so the seats catch up", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 0 };
  const { latest } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499 },
    {
      initialEmail: "a@x.com",
      knownEmails: { members: [], invited: [] },
    }
  );

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  assert.equal(latest().state.seats.ceilingLeft, null, "server refusal does not create a plan gate");
});

test("a run that invited someone refreshes the workspace list so the seats count them", async (t) => {
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
});

test("a run that invited nobody and met no seat refusal leaves the workspace list alone", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "requestFailed" };
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.deepEqual(globalThis.__refreshCalls ?? [], OPENING_REFRESH);
});

test("an already-member refusal from the switcher invites nobody and says so", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyMember" };
  const invited = [];
  // The workspace switcher passes no knownEmails, so only the server can say who is a member.
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "m@x.com",
    onInvited: (emails) => invited.push(emails),
  });

  await React.act(async () => latest().onSend());

  assert.equal(latest().state.phase, "editing");
  assert.deepEqual(latest().state.sent, []);
  assert.deepEqual(latest().state.recipients, [
    { email: "m@x.com", state: { status: "blocked", reason: "alreadyMember" } },
  ]);
  assert.deepEqual(invited, []);
  assert.deepEqual(globalThis.__refreshCalls ?? [], OPENING_REFRESH);
});

test("a run answered already invited refreshes the workspace list so the seats count them", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyInvited" };
  const { latest } = await mountWithWorkspace(t, WORKSPACE, { initialEmail: "a@x.com" });

  await React.act(async () => latest().onSend());

  assert.equal(latest().state.phase, "editing");
  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
});

test("an already-invited answer asks the caller to reload", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "alreadyInvited" };
  const invited = [];
  let changes = 0;
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com",
    onInvited: (emails) => invited.push(emails),
    onInvitationsChanged: () => {
      changes += 1;
    },
  });

  await React.act(async () => latest().onSend());

  assert.equal(changes, 1);
  // Nobody was invited, so a caller that says "Invitation sent to" has nothing to say.
  assert.deepEqual(invited, []);
});

test("a run that invited someone asks once", async (t) => {
  const invited = [];
  let changes = 0;
  const { latest } = await mountWithWorkspace(t, WORKSPACE, {
    onInvited: (emails) => invited.push(emails),
    onInvitationsChanged: () => {
      changes += 1;
    },
  });
  await React.act(async () => latest().dispatch({ type: "draft", text: "a@x.com, b@x.com," }));

  await React.act(async () => latest().onSend());

  assert.equal(changes, 1);
  assert.deepEqual(invited, [["a@x.com", "b@x.com"]]);
});

test("an aborted run doesn't", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  let changes = 0;
  const { latest, unmount } = await mountWithWorkspace(t, WORKSPACE, {
    initialEmail: "a@x.com",
    onInvitationsChanged: () => {
      changes += 1;
    },
  });
  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  await unmount();

  release();
  await sending;
  assert.equal(changes, 0);
});

test("a run that changed no invitation doesn't ask", async (t) => {
  for (const kind of ["alreadyMember", "requestFailed"]) {
    globalThis.__sendOutcome = { ok: false, kind };
    let changes = 0;
    const { latest, unmount } = await mountWithWorkspace(t, WORKSPACE, {
      initialEmail: "a@x.com",
      onInvitationsChanged: () => {
        changes += 1;
      },
    });

    await React.act(async () => latest().onSend());
    await unmount();

    assert.equal(changes, 0, kind);
  }
});

test("initialEmails open as chips and reopening resets to them", async (t) => {
  const { latest, rerender } = await mountDialog(t, {
    open: true,
    onOpenChange: () => {},
    workspaceId: "w1",
    workspaceName: "Acme",
    initialEmails: ["jin@x.com", "ravi@x.com"],
  });
  const chips = () => latest().state.recipients.map((recipient) => recipient.email);
  assert.deepEqual(chips(), ["jin@x.com", "ravi@x.com"]);

  await React.act(async () => latest().dispatch({ type: "remove", email: "jin@x.com" }));
  assert.deepEqual(chips(), ["ravi@x.com"]);

  await rerender({ open: false });
  await rerender({ open: true });
  assert.deepEqual(chips(), ["jin@x.com", "ravi@x.com"]);
});

test("heading replaces the title and description", async (t) => {
  const heading = {
    title: "Invite 2 guests to Ronnie's Space",
    description: "They'll get a link.",
  };
  const { container } = await mountWithWorkspace(t, WORKSPACE, { heading }, { realView: true });
  assert.match(container.textContent, /Invite 2 guests to Ronnie's Space/);
  assert.match(container.textContent, /They'll get a link\./);
  assert.doesNotMatch(container.textContent, /workspaces\.invite\.title/);
});

test("fork has no paid invitation gate: the view learns who manages billing", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("fork has no paid invitation gate: an owner can upgrade from the invite dialog", async (t) => {
  const { latest } = await mountWithWorkspace(t,
    { ...WORKSPACE, plan: "free", has_subscription: true, seats: 0, seats_used: 50, seat_limit: 0 },
    { initialEmails: ["a@x.com", "b@x.com"], knownEmails: { members: [], invited: [] } });
  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: null });
  assert.equal(latest().seatLine, undefined);
  assert.equal(latest().seatCostLine, undefined);
  assert.equal(latest().onUpgrade, undefined);
  assert.equal(globalThis.__previewCalls.length, 0);
  await React.act(async () => latest().onSend());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["a@x.com", "b@x.com"]);
  assert.equal(latest().state.phase, "done");
  assert.equal(globalThis.__settingsRequests, undefined);
});
