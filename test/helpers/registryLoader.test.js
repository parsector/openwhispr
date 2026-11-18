const createTempDir = require("../lib/tempDir");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRegistryLoader } = require("../../src/helpers/registryLoader");
const seed = require("../../src/models/modelRegistryData.json");

function setup(t, data = seed) {
 const dir = createTempDir(path.join(os.tmpdir(), "fork-catalog-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const applied = [], errors = [], requests = [];
 const cachePath = path.join(dir, "registry.json");
 const loader = createRegistryLoader({
   cachePath, bundledSnapshot: { data, manifestVersion: 4 },
   applySnapshot: snapshot => applied.push(snapshot), onError: error => errors.push(error),
   fetch: (...args) => { requests.push(args); throw new Error("Network is forbidden"); },
   isEnabled: () => true, startupDelayMs: 0, intervalMs: 1,
 });
 t.after(() => loader.stop());
 return { loader, applied, errors, requests, cachePath };
}

test("the shipped fork catalog is authoritative; start and repeated refresh never contact a publisher", async t => {
 const x = setup(t);
 await x.loader.start(); await x.loader.start();
 await x.loader.refresh(); await x.loader.refresh();
 assert.equal(x.applied.length, 1);
 assert.deepEqual(x.applied[0].data, seed);
 assert.equal(x.applied[0].pending, false);
 assert.deepEqual(x.requests, []);
});

test("retirement, legacy and minimum app version metadata never hide a shipped entry", async t => {
 const data = structuredClone(seed);
 const model = data.cloudProviders[0].models[0];
 Object.assign(model, { retired: true, legacy: true, minAppVersion: "999.0.0", plan: "enterprise" });
 const x = setup(t, data);
 await x.loader.start();
 assert.deepEqual(x.loader.getSnapshot().data, data);
 assert.deepEqual(x.requests, []);
});

for (const payload of [
 { authority: "vendor", data: seed, manifestVersion: 9999 },
 { authority: "fork", data: { ...seed, cloudProviders: [] }, manifestVersion: 9999 },
 { payload: "vendor signed envelope", signature: "unused" },
]) test("a vendor or mismatched cache cannot override this build", async t => {
 const x = setup(t);
 fs.writeFileSync(x.cachePath, JSON.stringify(payload));
 await x.loader.start();
 assert.deepEqual(x.loader.getSnapshot().data, seed);
 assert.ok(x.errors.length);
});

test("a damaged primary cache falls back to an exact fork backup", async t => {
 const x = setup(t);
 fs.writeFileSync(x.cachePath, "{broken");
 fs.writeFileSync(x.cachePath + ".backup", JSON.stringify({ authority: "fork", data: seed }));
 await x.loader.start();
 assert.deepEqual(x.applied[0].data, seed);
 assert.deepEqual(JSON.parse(fs.readFileSync(x.cachePath)).data, seed);
});

test("oversized or missing cache falls back to bundled data", async t => {
 const x = setup(t);
 fs.writeFileSync(x.cachePath, Buffer.alloc(4 * 1024 * 1024 + 1));
 await x.loader.start();
 assert.deepEqual(x.applied[0].data, seed);
 assert.match(x.errors[0].message, /too large/);
});

test("a cache write failure preserves usable bundled data", async t => {
 const x = setup(t);
 fs.mkdirSync(x.cachePath + ".tmp");
 await x.loader.start();
 assert.deepEqual(x.applied[0].data, seed);
 assert.ok(x.errors.length);
});

test("snapshots are isolated and stopping before start has no effects", async t => {
 const x = setup(t);
 const first = x.loader.getSnapshot();
 first.data.cloudProviders.length = 0;
 assert.deepEqual(x.loader.getSnapshot().data, seed);
 x.loader.stop(); await x.loader.start(); await x.loader.refresh();
 assert.equal(x.applied.length, 0);
 assert.deepEqual(x.requests, []);
});
