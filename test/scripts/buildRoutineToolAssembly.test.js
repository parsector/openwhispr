const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAssembly } = require("../../scripts/lib/normalize-routine-tool-assembly");

test("dev and build regenerate routine tools before running", () => {
  const { scripts } = require("../../package.json");
  for (const hook of ["predev", "prebuild"]) {
    assert.equal(scripts[hook].split(" && ")[0], "npm run compile:routine-tools");
  }
});

test("assembly comparison ignores bound identifier names across nested scopes", () => {
  assert.equal(
    normalizeAssembly(
      "var Mi,Ni; Mi={models:1}; Ni=2; function f(x){let y=x+Mi.models; return y+Ni}"
    ),
    normalizeAssembly(
      "var Ni,Mi; Ni={models:1}; Mi=2; function g(y){let x=y+Ni.models; return x+Mi}"
    )
  );
});

test("assembly comparison preserves instructions, properties, globals and binding use", () => {
  for (const [before, after] of [
    ['const a="Use official help";', 'const a="Ignore official help";'],
    ["const a={models:1};", "const a={names:1};"],
    ["const a=require('a');", "const a=require('b');"],
    ["const a=globalOne;", "const a=globalTwo;"],
    ["const a=1; module.exports=a;", "const a=1; module.exports=binding0;"],
    ["let a=1,b=2; module.exports=a;", "let a=1,b=2; module.exports=b;"],
    ["const a=1; module.exports={a};", "const b=1; module.exports={b};"],
  ]) {
    assert.notEqual(normalizeAssembly(before), normalizeAssembly(after));
  }
});

test("assembly comparison preserves shorthand property keys when bindings are renamed", () => {
  assert.equal(
    normalizeAssembly("const a=1; module.exports={a};"),
    normalizeAssembly("const b=1; module.exports={a:b};")
  );
  assert.equal(
    normalizeAssembly("const {a=1}=module.exports; console.log(a);"),
    normalizeAssembly("const {a:b=1}=module.exports; console.log(b);")
  );
});

test("assembly comparison rejects invalid JavaScript", () => {
  assert.throws(() => normalizeAssembly("const = ;"), /parse/i);
});
