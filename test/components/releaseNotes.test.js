const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderReleaseNotes(t, notes) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-release-notes-test-",
  });
  const { ReleaseNotes } = await vite.ssrLoadModule("/components/ui/ReleaseNotes.tsx");
  return renderToStaticMarkup(createElement(ReleaseNotes, { notes }));
}

test("release notes render markdown heading, list, emphasis, code and link as elements", async (t) => {
  const html = await renderReleaseNotes(
    t,
    "## [1.12.2] - 2026-11-02\n\n- **Safer** `notes` with [details](https://openwhispr.com)\n- Another fix\n"
  );

  for (const tag of ["h2", "ul", "li", "strong", "code", "a"]) {
    assert.match(html, new RegExp(`<${tag}\\b`), `${tag} renders as an element`);
  }
  assert.doesNotMatch(html, /## \[1\.12\.2\]|- \*\*Safer/);
  assert.match(html, /max-h-/);
  assert.match(html, /overflow-y-auto/);
});

test("a script in markdown release notes stays inert while markdown still renders", async (t) => {
  const html = await renderReleaseNotes(
    t,
    '## Safe heading\n\n- **Fixed** notes\n\n<script>window.pwned = true</script>'
  );

  assert.match(html, /<h2\b/);
  assert.match(html, /<ul\b/);
  assert.match(html, /<strong\b/);
  assert.doesNotMatch(html, /<script\b/);
  assert.match(html, /&lt;script&gt;window\.pwned = true&lt;\/script&gt;/);
});
