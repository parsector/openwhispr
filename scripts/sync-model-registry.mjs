#!/usr/bin/env node
// The fork owns both the catalog and its reader. No publisher or network input.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/models");
const READERS = ["registrySchema.cjs", "registrySelection.js"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HOW_TO_ADD =
  "Edit src/models/modelRegistryData.json in this fork, then run npm run model-registry:sync and npm run model-registry:verify.";

async function inspect(dir) {
  const catalog = await fs.readFile(path.join(dir, "modelRegistryData.json"), "utf8");
  const data = JSON.parse(catalog);
  require(path.join(dir, "registrySchema.cjs")).validateCatalog(data);
  const { withTrustedDownloads } = require("../src/helpers/registryDownloadTrust.js");
  const refused = [];
  withTrustedDownloads(data, data, (id) => refused.push(id));
  if (refused.length) throw new Error(`Untrusted catalog downloads: ${refused.join(", ")}`);
  const readerSha256 = {};
  for (const name of READERS) readerSha256[name] = hash(await fs.readFile(path.join(dir, name)));
  return {
    authority: "fork",
    schemaVersion: 2,
    manifestVersion: 4,
    catalogSha256: hash(catalog),
    readerSha256,
  };
}

export async function check(dir = output) {
  const expected = await inspect(dir);
  const saved = JSON.parse(await fs.readFile(path.join(dir, "registryMetadata.json"), "utf8"));
  if (JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error(`Fork catalog integrity metadata is stale.\n${HOW_TO_ADD}`);
  return `fork-owned catalog ${expected.catalogSha256.slice(0, 12)}; schema and download trust verified offline`;
}

export async function sync(dir = output) {
  const metadata = await inspect(dir);
  await fs.writeFile(
    path.join(dir, "registryMetadata.json"),
    JSON.stringify(metadata, null, 2) + "\n"
  );
  return check(dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--check", "--release-check"].includes(arg)))
      throw new Error(HOW_TO_ADD);
    console.log(args.length ? await check() : await sync());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
