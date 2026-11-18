const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const digest = (data) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

// The build owns the catalog. Disk cache is only a redundant copy of these
// exact shipped entries; a vendor publication can never replace this snapshot.
function createRegistryLoader({ cachePath, bundledSnapshot, applySnapshot, onError = () => {} }) {
  const snapshot = structuredClone(bundledSnapshot);
  const expectedHash = digest(snapshot.data);
  let started = false;
  let stopped = false;
  function report(error) {
    try {
      onError(error);
    } catch {}
  }
  async function readCache(file) {
    const handle = await fs.open(file, "r");
    try {
      if ((await handle.stat()).size > MAX_CATALOG_BYTES)
        throw new Error("Catalog cache too large");
      const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CATALOG_BYTES) throw new Error("Catalog cache too large");
      const cached = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (cached.authority !== "fork" || digest(cached.data) !== expectedHash)
        throw new Error("Cache does not match the catalog shipped with this build");
      return cached.data;
    } finally {
      await handle.close();
    }
  }
  async function start() {
    if (started || stopped) return;
    started = true;
    // A damaged primary cache can use its backup or the bundled snapshot.
    for (const file of [cachePath, `${cachePath}.backup`]) {
      try {
        snapshot.data = await readCache(file);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") report(error);
      }
    }
    if (stopped) return;
    applySnapshot({ ...structuredClone(snapshot), pending: false });
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const bytes = JSON.stringify({ ...snapshot, authority: "fork" });
      await fs.writeFile(`${cachePath}.tmp`, bytes, { mode: 0o600 });
      await fs.rename(cachePath, `${cachePath}.backup`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rename(`${cachePath}.tmp`, cachePath);
    } catch (error) {
      report(error);
    }
  }
  return {
    start,
    refresh: async () => {},
    stop: () => {
      stopped = true;
    },
    getSnapshot: () => structuredClone(snapshot),
  };
}
module.exports = { createRegistryLoader };
