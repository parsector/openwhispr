const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized), so
// assertions match on the raw translation key rather than resolved copy. The dropdown
// primitives are stubbed so the menu's items render inline instead of into a portal.
async function renderMenu(t, { canCreateTeamSpace, withAssistant = true, onNewTodo }) {
  installBrowserGlobals(t);
  globalThis.__newNoteMenuTodoSelect = undefined;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-new-note-menu-test-",
    mockModules: {
      "/ui/dropdown-menu": `
        import { createElement } from "react";
        const passthrough = (props) => createElement("div", null, props.children);
        export const DropdownMenu = passthrough;
        export const DropdownMenuTrigger = passthrough;
        export const DropdownMenuContent = passthrough;
        export const DropdownMenuItem = (props) => {
          if (props.children?.[1] === "notes.createMenu.todo") globalThis.__newNoteMenuTodoSelect = props.onSelect;
          return passthrough(props);
        };
        export const DropdownMenuSeparator = () => createElement("div", null);
      `,
      "/hooks/useCanCreateTeamSpace": `
        export const useCanCreateTeamSpace = () => globalThis.__canCreateTeamSpace === true;
      `,
      "/CreateSpaceDialog": `
        export default function CreateSpaceDialog() { return null; }
      `,
    },
  });
  globalThis.__canCreateTeamSpace = canCreateTeamSpace;
  t.after(() => {
    delete globalThis.__canCreateTeamSpace;
    delete globalThis.__newNoteMenuTodoSelect;
  });
  const mod = await vite.ssrLoadModule("/components/notes/NewNoteMenu.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      onNewNote: () => {},
      ...(onNewTodo ? { onNewTodo } : {}),
      ...(withAssistant ? { onNewChat: () => {} } : {}),
    })
  );
}

test("the New note menu always offers a note and an assistant chat", async (t) => {
  const markup = await renderMenu(t, { canCreateTeamSpace: false });

  assert.match(markup, /notes\.list\.newNote/);
  assert.match(markup, /notes\.createMenu\.note/);
  assert.match(markup, /notes\.createMenu\.assistantChat/);
});

test("the New note menu offers a todo only with a handler and selects it once", async (t) => {
  const withoutTodo = await renderMenu(t, { canCreateTeamSpace: false });
  assert.doesNotMatch(withoutTodo, /notes\.createMenu\.todo/);
  let calls = 0;
  const withTodo = await renderMenu(t, { canCreateTeamSpace: false, onNewTodo: () => { calls += 1; } });
  assert.match(withTodo, /notes\.createMenu\.note[\s\S]*notes\.createMenu\.todo[\s\S]*notes\.createMenu\.assistantChat/);
  assert.equal(typeof globalThis.__newNoteMenuTodoSelect, "function");
  globalThis.__newNoteMenuTodoSelect();
  assert.equal(calls, 1);
});

test("the New note menu never offers a team space, even with create permission", async (t) => {
  const withoutPermission = await renderMenu(t, { canCreateTeamSpace: false });
  assert.doesNotMatch(withoutPermission, /notes\.createMenu\.teamSpace/);

  const withPermission = await renderMenu(t, { canCreateTeamSpace: true });
  assert.doesNotMatch(withPermission, /notes\.createMenu\.teamSpace/);
});

// The Chat tab disappears entirely when an org turns the assistant off, so the
// item that navigates there goes with it.
test("the New note menu hides the assistant chat when the assistant is off", async (t) => {
  const markup = await renderMenu(t, { canCreateTeamSpace: false, withAssistant: false });

  assert.doesNotMatch(markup, /notes\.createMenu\.assistantChat/);
  assert.match(markup, /notes\.createMenu\.note/);
});
