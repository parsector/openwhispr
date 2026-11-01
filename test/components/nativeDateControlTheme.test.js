const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { Window } = require("happy-dom");
const postcss = require("postcss");
const i18next = require("i18next");
const { I18nextProvider } = require("react-i18next");

global.React = React;
const TodosView = require("../../src/components/todos/TodosView.tsx").default;
const { useTodosStore } = require("../../src/stores/todosStore.ts");
const rendererRoot = path.join(__dirname, "../../src");
const css = fs.readFileSync(path.join(rendererRoot, "index.css"), "utf8");

for (const theme of ["light", "dark"]) {
  test(`native date/time controls resolve to ${theme} in the ${theme} app theme`, async () => {
    const browser = new Window();
    const previous = {
      window: global.window,
      document: global.document,
      navigator: global.navigator,
      IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
    };
    const previousStore = useTodosStore.getState();
    global.window = browser;
    global.document = browser.document;
    global.navigator = browser.navigator;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const row = {
      id: "theme-test",
      text: "Send report",
      status: "open",
      direction: "owe",
      due_date: "2026-10-29",
      pinned_fields: "[]",
    };
    browser.electronAPI = {
      isDebugEnabled: async () => false,
      commitmentsList: async () => [row],
      commitmentsProposalsList: async () => [],
      commitmentsOverdueCount: async () => 0,
      onCommitmentsUpdated: () => () => {},
    };
    const { createRoot } = require("react-dom/client");
    const host = browser.document.createElement("div");
    browser.document.body.append(host);
    const root = createRoot(host);
    try {
      const i18n = i18next.createInstance();
      await i18n.init({ lng: "en", resources: {} });
      const { document } = browser;
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.body.classList.toggle("dark", theme === "dark");
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      useTodosStore.setState({ composerRequestAt: previousStore.composerRequestAt + 1 });
      await React.act(async () =>
        root.render(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(TodosView, { onOpenNote() {} })
          )
        )
      );
      document.querySelector("details").open = true;
      assert.equal(
        host.querySelectorAll('input[type="date"]').length,
        2,
        "the composer and todo menu retain their native date inputs"
      );

      // Exercise the shared rule independently of todo markup, including future time
      // controls and inline fields excluded from the generic input appearance rules.
      for (const type of ["date", "time", "datetime-local"]) {
        for (const className of ["", "input-inline"]) {
          const input = document.createElement("input");
          input.type = type;
          input.className = className;
          document.body.append(input);
        }
      }
      for (const input of document.querySelectorAll(
        'input:is([type="date"], [type="time"], [type="datetime-local"])'
      )) {
        for (const state of ["idle", "focus", "disabled"]) {
          input.disabled = state === "disabled";
          if (state === "focus") input.focus();
          else input.blur();
          assert.equal(
            browser.getComputedStyle(input).getPropertyValue("color-scheme"),
            theme,
            `${input.type} ${input.className} (${state}) follows the app theme`
          );
        }
      }
    } finally {
      await React.act(async () => root.unmount());
      useTodosStore.setState(previousStore, true);
      browser.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete global[key];
        else global[key] = value;
      }
    }
  });
}

test("renderer styles leave native calendar glyph painting to the themed browser", () => {
  for (const file of fs.readdirSync(rendererRoot, { recursive: true })) {
    if (!file.endsWith(".css") || file.startsWith(`dist${path.sep}`)) continue;
    const stylesheet = postcss.parse(fs.readFileSync(path.join(rendererRoot, file), "utf8"));
    stylesheet.walkRules((rule) => {
      rule.walkDecls((declaration) => {
        if (declaration.prop === "color-scheme") {
          assert.doesNotMatch(
            rule.selector,
            /:(?:hover|focus[\w-]*|active|disabled|enabled)\b/,
            `${file}: interaction states must retain the shared native color scheme`
          );
        }
        if (rule.selector.includes("::-webkit-calendar-picker-indicator")) {
          assert.doesNotMatch(
            declaration.prop,
            /^(?:color|filter|background(?:-.*)?|(?:-webkit-)?mask(?:-.*)?|fill|stroke)$/,
            `${file}: do not override the native indicator palette or glyph`
          );
        }
      });
    });
  }
});
