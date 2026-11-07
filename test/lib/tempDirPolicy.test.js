const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const testRoot = path.resolve(__dirname, "..");
const helperPath = path.join(__dirname, "tempDir.js");
// Only the helper may access the raw filesystem APIs, including through aliases.
const rawApiAllowlist = new Set([helperPath]);
const rawApiName = /^mkdtemp(?:Sync)?$/;

function* sourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield file;
  }
}

function violations(file, text) {
  if (rawApiAllowlist.has(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const failures = [];
  let importsHelper = false;
  const helperCalls = [];
  function inspect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "createTempDir" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      const target = path.resolve(path.dirname(file), node.initializer.arguments[0].text);
      importsHelper = target === helperPath || `${target}.js` === helperPath;
    }
    const rawIdentifier = ts.isIdentifier(node) && rawApiName.test(node.text);
    const rawStringProperty =
      ts.isStringLiteral(node) &&
      rawApiName.test(node.text) &&
      (ts.isElementAccessExpression(node.parent) || ts.isBindingElement(node.parent));
    if (rawIdentifier || rawStringProperty) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      failures.push(`${path.relative(testRoot, file)}:${line}: use test/lib/tempDir.js`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createTempDir"
    ) {
      helperCalls.push(node);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  if (helperCalls.length && !importsHelper) {
    failures.push(
      `${path.relative(testRoot, file)}: createTempDir must be imported from test/lib/tempDir.js`
    );
  }
  return failures;
}

test("test temp directories use the shared helper that creates their parents", () => {
  const failures = [...sourceFiles(testRoot)].flatMap((file) =>
    violations(file, fs.readFileSync(file, "utf8"))
  );
  assert.deepEqual(failures, [], `Temporary-directory policy violations:\n${failures.join("\n")}`);
});

test("temp-directory guard catches direct, aliased, async and computed API access", () => {
  const file = path.join(testRoot, "helpers/example.test.js");
  for (const source of [
    'fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache/gap-"));',
    'await fs.mkdtemp(path.join(os.tmpdir(), "gap-"));',
    'const { mkdtempSync: makeDir } = require("node:fs"); makeDir(prefix);',
    'const { "mkdtemp": makeDir } = require("node:fs/promises");',
    'fs["mkdtempSync"](prefix);',
    "const makeDir = fs.mkdtempSync; makeDir(prefix);",
    'function createTempDir() {} createTempDir("gap-");',
  ]) {
    assert.ok(violations(file, source).length > 0, source);
  }
  assert.deepEqual(
    violations(file, '// fs.mkdtempSync(prefix)\nconst message = "mkdtempSync(prefix)";'),
    []
  );
  assert.deepEqual(
    violations(file, 'const createTempDir = require("../lib/tempDir"); createTempDir("gap-");'),
    []
  );
});
