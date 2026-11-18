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

const WORKSPACE = { id: "w1", name: "Acme", role: "admin", seats: 20, seat_limit: 500 };

const OPENING_REFRESH = [{ fresh: true }];

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

test("seats left come from the workspace list", async (t) => {
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: true,
      seats: 20,
      seats_used: 10,
      seat_limit: 500,
    },
    { knownEmails: { members: [], invited: [] } }
  );

  assert.deepEqual(latest().state.seats, { purchasedLeft: 10, ceilingLeft: 490 });
});

test("the seat line and the seat warning count the same seats", async (t) => {
  // An admin: the owner-only preview refuses, and seats_used counts pending invitations too.
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: true,
      seats_used: 10,
    },
    { knownEmails: { members: [], invited: [] } }
  );
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":10,"seats":20}');
  assert.deepEqual(latest().state.seats, { purchasedLeft: 10, ceilingLeft: 490 });
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("the seat line prefers the workspace list over the preview", async (t) => {
  globalThis.__seatPreview = {
    seats_used: 9,
    current_quantity: 20,
    amount_due: 1200,
    currency: "usd",
  };
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: true,
    seats_used: 10,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":10,"seats":20}');
});

test("a free workspace hides the seat line and reads no members for it", async (t) => {
  // Its seats is a placeholder 1, so "Using 12 of 1 seats" would read wrong.
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: false,
    seats: 1,
    seats_used: 12,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a free workspace on an older API without seats_used reads no members either", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: false,
    seats: 1,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a subscribed workspace shows the seat line", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    has_subscription: true,
    seats_used: 12,
  });
  await React.act(async () => {});

  assert.equal(latest().seatLine, 'workspaces.invite.seatUsage|{"used":12,"seats":20}');
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a subscribed workspace with no count to show hides the line and reads no members", async (t) => {
  // An older API without seats_used, and an admin, whom the owner-only preview refuses.
  const { latest } = await mountWithWorkspace(t, { ...WORKSPACE, has_subscription: true });
  await React.act(async () => {});

  assert.equal(latest().seatLine, null);
  assert.equal(globalThis.__memberListCalls, undefined);
});

test("a free workspace gets no seat warning", async (t) => {
  // A free workspace's seats is a placeholder 1, so it says nothing about room left.
  const { latest } = await mountWithWorkspace(
    t,
    {
      ...WORKSPACE,
      has_subscription: false,
      seats: 1,
      seats_used: 3,
    },
    { knownEmails: { members: [], invited: [] } }
  );

  assert.deepEqual(latest().state.seats, { purchasedLeft: null, ceilingLeft: 497 });
});

test("an older API without seat_limit has no ceiling check", async (t) => {
  const { seat_limit: _omitted, ...older } = WORKSPACE;
  const { latest } = await mountWithWorkspace(t, {
    ...older,
    has_subscription: true,
    seats_used: 18,
  });

  assert.deepEqual(latest().state.seats, { purchasedLeft: 2, ceilingLeft: null });
});

test("without a roster, an existing address cannot block a valid batch near the ceiling", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    {},
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () => {
    propsOf(input).onChange({ target: { value: "existing@example.com, new@example.com," } });
  });
  const send = findNode(
    container,
    (node) =>
      node.localName === "button" && node.textContent.startsWith("workspaces.invite.submit|")
  );

  assert.ok(send, container.textContent);
  assert.equal(send.hasAttribute("disabled"), false);
  await pressButton(send);
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["existing@example.com", "new@example.com"]);
});

test("without a roster, a seat refusal still allows a valid mixed retry after trimming", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 1 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    {},
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () =>
    propsOf(input).onChange({
      target: { value: "existing@example.com, new@example.com, extra@example.com," },
    })
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  await rerender();
  assert.match(
    findNode(container, (node) => node.getAttribute("role") === "alert")?.textContent ?? "",
    /workspaces\.invite\.errors\.seatLimit/
  );
  const removeExtra = findNode(
    container,
    (node) =>
      node.localName === "button" && node.getAttribute("aria-label")?.includes("extra@example.com")
  );
  await pressButton(removeExtra);

  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[1].emails, ["existing@example.com", "new@example.com"]);
});

test("a complete roster keeps the server ceiling through refresh and a trimmed retry", async (t) => {
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 1 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 498, seat_limit: 500 },
    { knownEmails: { members: ["existing@example.com"], invited: [] } },
    { realView: true }
  );
  const input = findNode(container, (node) => node.getAttribute("role") === "combobox");
  await React.act(async () =>
    propsOf(input).onChange({
      target: { value: "existing@example.com, new@example.com, extra@example.com," },
    })
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[0].emails, ["new@example.com", "extra@example.com"]);
  assert.equal(send().hasAttribute("disabled"), true);

  globalThis.__workspaces = [{ ...WORKSPACE, seats_used: 499, seat_limit: 500 }];
  await rerender();
  assert.equal(send().hasAttribute("disabled"), true);
  const removeExtra = findNode(
    container,
    (node) =>
      node.localName === "button" && node.getAttribute("aria-label")?.includes("extra@example.com")
  );
  await pressButton(removeExtra);

  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.deepEqual(globalThis.__sendCalls[1].emails, ["new@example.com"]);
});

test("a roster lost during sending cannot leave a blocking ceiling after refusal", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  globalThis.__sendOutcome = { ok: false, kind: "seatLimit", available: 0 };
  const { container, rerender } = await mountWithWorkspace(
    t,
    { ...WORKSPACE, seats_used: 499, seat_limit: 500 },
    { initialEmail: "new@example.com", knownEmails: { members: [], invited: [] } },
    { realView: true }
  );
  const send = () =>
    findNode(
      container,
      (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
    );
  await pressButton(send());
  await rerender({ knownEmails: undefined });
  await React.act(async () => release());

  assert.deepEqual(globalThis.__refreshCalls, [...OPENING_REFRESH, { fresh: true }]);
  assert.match(
    findNode(container, (node) => node.getAttribute("role") === "alert")?.textContent ?? "",
    /workspaces\.invite\.errors\.seatLimit/
  );
  assert.equal(send().hasAttribute("disabled"), false);
  globalThis.__sendOutcome = { ok: true, emailSent: true };
  await pressButton(send());
  assert.equal(globalThis.__sendCalls.length, 2);
});

test("Upgrade shows from every entry point", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    { initialEmail: "a@x.com" },
    { realView: true }
  );
  await React.act(async () => {});

  assert.ok(findUpgrade(container), container.textContent);
});

test("Upgrade closes the dialog and asks for Plan & Billing", async (t) => {
  const steps = [];
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => steps.push(`open:${open}`),
    },
    { realView: true }
  );
  await React.act(async () => {});

  await pressButton(findUpgrade(container));

  assert.deepEqual(steps, ["open:false"]);
  assert.deepEqual(globalThis.__settingsRequests, ["plansBilling"]);
});

test("admins never see it", async (t) => {
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "admin" },
    { initialEmail: "a@x.com" },
    { realView: true }
  );
  await React.act(async () => {});

  assert.ok(!findUpgrade(container), "no Upgrade for admins");
  assert.match(container.textContent, /workspaces\.invite\.seatsNoneAskOwner/);
  assert.equal(globalThis.__settingsRequests, undefined);
});

test("Upgrade can't interrupt a send with seats already over", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const opens = [];
  const invited = [];
  const { container } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner", seats_used: 22 },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => opens.push(open),
      onInvited: (emails) => invited.push(emails),
    },
    { realView: true }
  );
  await React.act(async () => {});
  assert.ok(findUpgrade(container), "offered before the send");

  const send = findNode(
    container,
    (node) => node.localName === "button" && /invite\.submit/.test(node.textContent)
  );
  let sending;
  await React.act(async () => {
    sending = propsOf(send).onClick();
  });

  assert.equal(globalThis.__sendCalls.length, 1);
  assert.ok(!findUpgrade(container), "no Upgrade while sending");
  assert.deepEqual(opens, []);

  release();
  await React.act(async () => {
    await sending;
  });
  assert.deepEqual(invited, [["a@x.com"]]);
});

test("Upgrade pressed as a send starts leaves the run alone", async (t) => {
  let release;
  globalThis.__sendGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const opens = [];
  const invited = [];
  const { latest } = await mountWithWorkspace(
    t,
    { ...NO_SEATS_LEFT, role: "owner" },
    {
      initialEmail: "a@x.com",
      onOpenChange: (open) => opens.push(open),
      onInvited: (emails) => invited.push(emails),
    }
  );
  // A press the render hadn't caught up with: the handler is the view's, from before the send.
  let sending;
  await React.act(async () => {
    sending = latest().onSend();
  });
  assert.equal(latest().state.phase, "sending");

  await React.act(async () => latest().onUpgrade());

  assert.deepEqual(opens, []);
  assert.equal(globalThis.__settingsRequests, undefined);
  assert.equal(globalThis.__sendCalls[0].signal.aborted, false);

  release();
  await React.act(async () => {
    await sending;
  });
  assert.deepEqual(invited, [["a@x.com"]]);
});

test("opening reads the workspace list, since canceled invitations free seats", async (t) => {
  await mountWithWorkspace(t, WORKSPACE, {});

  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
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
  assert.equal(latest().state.seats.ceilingLeft, 0);
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

  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
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
  assert.deepEqual(globalThis.__refreshCalls, OPENING_REFRESH);
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

test("the view learns who manages billing", async (t) => {
  const { latest } = await mountWithWorkspace(t, {
    ...WORKSPACE,
    role: "admin",
    billing_manager: "Olivia",
  });

  assert.equal(latest().canManageBilling, false);
  assert.equal(latest().billingManager, "Olivia");
});

test("an owner can upgrade from the invite dialog", async (t) => {
  const { latest } = await mountWithWorkspace(t, { ...WORKSPACE, role: "owner" });

  assert.equal(latest().canManageBilling, true);
  assert.equal(latest().billingManager, null);
});

// Seats all taken, so one address brings up the warning. These run the real view, so they read and
// press what a person does, and pass nothing about billing: the caller is any entry point.
const NO_SEATS_LEFT = {
  ...WORKSPACE,
  has_subscription: true,
  seats_used: 20,
  billing_manager: "Olivia",
};
const UPGRADE = "workspaces.invite.upgrade";

function findNode(node, predicate) {
  if (node.nodeType === 1 && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const findUpgrade = (container) =>
  findNode(container, (node) => node.localName === "button" && node.textContent === UPGRADE);

const propsOf = (node) => node[Object.keys(node).find((name) => name.startsWith("__reactProps$"))];

const pressButton = (button) => React.act(async () => propsOf(button).onClick());
