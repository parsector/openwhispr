const createTempDir = require("../lib/tempDir");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const models = path.join(__dirname, "../../src/models");
function copy(t) {
 const dir = createTempDir(path.join(__dirname, "../../node_modules/.cache-sync-check-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 for (const name of ["modelRegistryData.json", "registryMetadata.json", "registrySchema.cjs", "registrySelection.js"])
   fs.copyFileSync(path.join(models, name), path.join(dir, name));
 return dir;
}
test("the offline check verifies fork data and reader integrity without a vendor publication", async t => {
 const { check } = await import("../../scripts/sync-model-registry.mjs");
 assert.match(await check(copy(t)), /fork-owned catalog.*verified offline/);
});
test("fork edits require local integrity regeneration, then pass without a publisher", async t => {
 const { check, sync } = await import("../../scripts/sync-model-registry.mjs");
 for (const name of ["modelRegistryData.json", "registrySelection.js"]) {
   const dir = copy(t), target = path.join(dir, name);
   fs.appendFileSync(target, "\n");
   await assert.rejects(check(dir), /Edit src\/models\/modelRegistryData.json/);
   await sync(dir);
   assert.match(await check(dir), /fork-owned catalog/);
 }
});
test("the fork check still rejects unsafe artifact publishers", async t => {
 const { sync } = await import("../../scripts/sync-model-registry.mjs");
 const dir = copy(t);
 const data = JSON.parse(fs.readFileSync(path.join(dir, "modelRegistryData.json")));
 data.localProviders[0].models[0].hfRepo = "untrusted-attacker/model";
 fs.writeFileSync(path.join(dir, "modelRegistryData.json"), JSON.stringify(data));
 await assert.rejects(sync(dir), /Untrusted catalog downloads/);
});
