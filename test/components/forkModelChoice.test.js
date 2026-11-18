const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
function find(node, predicate) {
 if(Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
 if(!node || typeof node !== "object") return null;
 return predicate(node) ? node : find(node.props?.children, predicate);
}
test("missing saved models remain visible and lifecycle flags do not disable selection", async t => {
 installBrowserGlobals(t);
 const vite = await createRendererServer(t, { noExternal: ["react-i18next"], mockModules: {
   "react-i18next": `export const useTranslation = () => ({ t: (key, values) => key === 'models.savedUnavailable' ? 'Saved choice: ' + values.model + '. Not listed; your choice has been kept.' : key });`,
 } });
 const { default: List, ModelCard } = await vite.ssrLoadModule("/components/ui/ModelCardList.tsx");
 const choices = [];
 const model = { value: "old-entry", label: "Old entry", legacy: true };
 const tree = List({ models: [model], selectedModel: "my-saved-model", onModelSelect: id => choices.push(id) });
 const notice = find(tree, node => node.props?.role === "status");
 assert.match(notice.props.children, /my-saved-model.*choice has been kept/);
 assert.deepEqual(choices, []);
 const card = ModelCard({ model, isSelected: false, onSelect: id => choices.push(id) });
 assert.equal(card.props["aria-disabled"], undefined);
 card.props.onClick();
 assert.deepEqual(choices, ["old-entry"]);
});
