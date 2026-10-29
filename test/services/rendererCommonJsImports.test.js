const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const src = path.resolve(__dirname, "../../src");
const helpers = path.join(src, "helpers");

function* rendererFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* rendererFiles(file);
    else if (/\.tsx?$/.test(entry.name)) yield file;
  }
}

test("renderer TypeScript does not import CommonJS helpers", () => {
  const offenders = [];
  for (const area of ["components", "services", "stores"]) {
    for (const file of rendererFiles(path.join(src, area))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function inspect(node) {
        const importPath = ts.isImportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
            : undefined;
        if (importPath && ts.isStringLiteral(importPath)) {
          const specifier = importPath.text;
          if (specifier.startsWith(".")) {
            const target = path.resolve(path.dirname(file), specifier);
            const candidates = path.extname(specifier) ? [target] : [`${target}.js`, path.join(target, "index.js")];
            const resolved = candidates.find((candidate) => candidate.endsWith(".js") && fs.existsSync(candidate));
            if (!resolved) return;
            const relative = path.relative(helpers, resolved);
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) &&
                /\bmodule\.exports\b|\bexports\./.test(fs.readFileSync(resolved, "utf8"))) {
              offenders.push(`${path.relative(src, file)} imports ${specifier} (${path.relative(src, resolved)})`);
            }
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
  }
  assert.deepEqual(offenders, [], `Renderer imports CommonJS helpers:\n${offenders.join("\n")}`);
});
