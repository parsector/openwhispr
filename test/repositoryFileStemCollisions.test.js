const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const resolverExtensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const resolverExtensionSet = new Set(resolverExtensions);

// These three files are imported with explicit extensions, so resolution never
// has to choose between their shared stems.
const explicitExtensionTrio = new Set([
  "src/helpers/voiceSurfaceGeometry.js",
  "src/helpers/voiceSurfaceGeometry.mjs",
  "src/helpers/voiceSurfaceGeometry.json",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean);
}

function collidingPairs(files) {
  const byStem = new Map();
  for (const file of files) {
    const extension = path.posix.extname(file);
    if (!resolverExtensionSet.has(extension)) continue;
    const stem = path.posix.basename(file, extension).toLowerCase();
    const key = `${path.posix.dirname(file).toLowerCase()}/${stem}`;
    const group = byStem.get(key) ?? [];
    group.push(file);
    byStem.set(key, group);
  }

  const pairs = [];
  for (const group of byStem.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (explicitExtensionTrio.has(group[i]) && explicitExtensionTrio.has(group[j])) continue;
        pairs.push(`${group[i]} <-> ${group[j]}`);
      }
    }
  }
  return pairs;
}

test("tracked resolver stems have no unapproved case-insensitive collisions", () => {
  const pairs = collidingPairs(trackedFiles());
  assert.deepEqual(pairs, [], `Ambiguous tracked file pair(s):\n${pairs.join("\n")}`);
});

test("the overlay's component and model imports resolve to distinct files on a case-insensitive filesystem", () => {
  const files = trackedFiles().filter((file) => file.startsWith("src/components/"));
  const collisions = collidingPairs(files);
  assert.deepEqual(collisions, [], `Ambiguous src/components file pair(s):\n${collisions.join("\n")}`);

  const importer = "src/components/MeetingNotificationOverlay.tsx";
  function resolveCaseInsensitive(specifier) {
    const requested = path.posix.join(path.posix.dirname(importer), specifier).toLowerCase();
    for (const extension of resolverExtensions) {
      const found = files.find((file) => file.toLowerCase() === requested + extension);
      if (found) return found;
    }
    assert.fail(`Cannot resolve ${specifier} from ${importer}`);
  }

  assert.equal(resolveCaseInsensitive("./todos/PreMeetingBrief"), "src/components/todos/PreMeetingBrief.tsx");
  assert.equal(resolveCaseInsensitive("./todos/preMeetingBriefModel"), "src/components/todos/preMeetingBriefModel.ts");
  assert.notEqual(resolveCaseInsensitive("./todos/PreMeetingBrief"), resolveCaseInsensitive("./todos/preMeetingBriefModel"));
});
