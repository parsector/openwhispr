const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("pre-summary picker shows the resolved default, lists templates, and passes the selection to the first run", async (t) => {
  const { Window } = await import("happy-dom");
  const dom = new Window({ url: "http://localhost:5173" });
  const originals = new Map();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "Element",
    "Event",
    "CustomEvent",
    "FocusEvent",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "MutationObserver",
    "ResizeObserver",
    "localStorage",
  ]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value:
        key === "getComputedStyle" || key.includes("AnimationFrame")
          ? dom[key]?.bind(dom)
          : dom[key],
      configurable: true,
      writable: true,
    });
  }
  originals.set(
    "IS_REACT_ACT_ENVIRONMENT",
    Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const vite = await createRendererServer(t, {
    cachePrefix: "pre-summary-template-picker-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation=()=>({t:(key)=>({'notes.editor.generateSummary':'Generate AI Summary','notes.templates.select':'Choose template','notes.templates.tab':'Templates','notes.templates.manage':'Manage Templates...','notes.templates.regenerate':'Regenerate'}[key]??key)});`,
      "/stores/actionStore": `export const getActionName=(action)=>action.name;export const resolveTemplate=(templates,id)=>templates.find((t)=>t.client_id===id)??templates.find((t)=>t.translation_key==='builtin.summary')??templates[0]??null;`,
    },
  });
  const { default: Callout } = await vite.ssrLoadModule(
    "/components/notes/PreSummaryTemplateCallout.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const templates = [
    { id: 1, client_id: "default", translation_key: "builtin.summary", name: "AI Summary" },
    { id: 2, client_id: "sales", name: "Sales call" },
    { id: 3, client_id: "weekly", name: "Weekly review" },
  ];
  const runs = [];
  const render = async (visible) =>
    React.act(async () =>
      root.render(
        React.createElement(Callout, {
          visible,
          noteId: 7,
          savedTemplateId: null,
          templates,
          disabled: false,
          onRun: (template) => runs.push(template),
          onManage: () => {},
        })
      )
    );
  await render(true);
  assert.equal(
    container.querySelector('[aria-label="Choose template"]')?.textContent,
    "AI Summary"
  );
  const trigger = container.querySelector('[aria-label="Choose template"]');
  await React.act(async () =>
    trigger.dispatchEvent(
      new dom.MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
    )
  );
  assert.match(dom.document.body.textContent, /Sales call/);
  assert.match(dom.document.body.textContent, /Weekly review/);
  const sales = [...dom.document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent.includes("Sales call")
  );
  assert.ok(sales);
  await React.act(async () => sales.dispatchEvent(new dom.MouseEvent("click", { bubbles: true })));
  assert.equal(trigger.textContent, "Sales call");
  const cta = [...container.querySelectorAll("button")].find((el) =>
    el.textContent.includes("Generate AI Summary")
  );
  await React.act(async () => cta.click());
  assert.equal(runs[0].client_id, "sales");
  await render(false);
  assert.equal(container.querySelector('[aria-label="Choose template"]'), null);
});
