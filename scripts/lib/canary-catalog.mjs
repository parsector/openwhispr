// Canary probes read the same fork-owned catalog as this build. No publication.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bundled = require("../../src/models/modelRegistryData.json");
export async function loadCanaryCatalog(argv = process.argv) {
  if (argv.includes("--published"))
    throw new Error(
      "This fork uses src/models/modelRegistryData.json; --published is unsupported."
    );
  return structuredClone(bundled);
}
