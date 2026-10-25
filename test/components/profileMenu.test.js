const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadProfileMenu(t) {
  t.after(() => {
    delete globalThis.__auth;
    delete globalThis.__menuItems;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-profile-menu-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => globalThis.__auth;",
      "/MemberAvatar": "export default function MemberAvatar() { return null; }",
      // Renders the menu open and records each item's handler under its text.
      "/ui/dropdown-menu": `
        import React from "react";
        const textOf = (node) =>
          typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : "";
        export const DropdownMenu = ({ children }) => children;
        export const DropdownMenuTrigger = ({ children, ...props }) =>
          React.createElement("button", props, children);
        export const DropdownMenuContent = ({ children }) => React.createElement("div", null, children);
        export const DropdownMenuSeparator = () => null;
        export const DropdownMenuItem = ({ children, onSelect }) => {
          globalThis.__menuItems.set(textOf(children), onSelect);
          return null;
        };
      `,
    },
  });
  const { default: ProfileMenu } = await vite.ssrLoadModule("/components/ProfileMenu.tsx");
  const opened = [];
  const render = (auth) => {
    globalThis.__auth = auth;
    globalThis.__menuItems = new Map();
    return renderToStaticMarkup(
      createElement(ProfileMenu, {
        onOpenSettings: (section) => opened.push(section),
        onOpenReferrals: () => opened.push("referrals"),
        onSignOut: () => opened.push("sign out"),
      })
    );
  };
  return { render, opened };
}

test("a session still loading shows neither Sign in nor an account", async (t) => {
  const { render } = await loadProfileMenu(t);

  const markup = render({ isLoaded: false, isSignedIn: false, user: null });

  assert.doesNotMatch(markup, /<button/);
});

test("signed out, the avatar offers Sign in", async (t) => {
  const { render } = await loadProfileMenu(t);

  const markup = render({ isLoaded: true, isSignedIn: false, user: null });

  assert.match(markup, /aria-label="common\.signIn"/);
});

const signedIn = {
  isLoaded: true,
  isSignedIn: true,
  user: { name: "Chad Piha", email: "chad@example.com", image: null },
};

test("the menu holds the account's own actions, ending with Sign out", async (t) => {
  const { render, opened } = await loadProfileMenu(t);

  render(signedIn);
  const labels = [...globalThis.__menuItems.keys()];
  for (const label of labels) globalThis.__menuItems.get(label)();

  assert.deepEqual(labels, [
    "settingsModal.sections.account.label",
    "sidebar.referral",
    "settingsPage.account.signOut.signOut",
  ]);
  assert.deepEqual(opened, ["account", "referrals", "sign out"]);
});

test("the header shows account identity without a plan badge", async (t) => {
  const { render } = await loadProfileMenu(t);

  const markup = render(signedIn);
  assert.match(markup, /Chad Piha/);
  assert.match(markup, /chad@example.com/);
  assert.doesNotMatch(markup, />Pro</);
});
