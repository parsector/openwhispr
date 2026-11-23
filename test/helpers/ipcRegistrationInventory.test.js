const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parse } = require("espree");

const root = path.resolve(__dirname, "../..");
function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? javascriptFiles(filename)
      : filename.endsWith(".js")
        ? [filename]
        : [];
  });
}

// Evaluate only platform predicates. Unknown conditions visit both arms so an
// ordinary conditional cannot conceal a conflicting registration.
function platformValue(node, platform) {
  if (node.type === "Literal") return node.value;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.name === "process" &&
    node.property.name === "platform"
  )
    return platform;
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    const left = platformValue(node.left, platform);
    const right = platformValue(node.right, platform);
    if (left === undefined || right === undefined) return undefined;
    switch (node.operator) {
      case "===":
        return left === right;
      case "!==":
        return left !== right;
      case "||":
        return left || right;
      case "&&":
        return left && right;
    }
  }
  return undefined;
}

function registrations(ast, platform, filename) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "IfStatement") {
      const value = platformValue(node.test, platform);
      if (typeof value === "boolean") {
        visit(value ? node.consequent : node.alternate);
        return;
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.name === "ipcMain" &&
      ["handle", "on"].includes(node.callee.property.name)
    ) {
      const channel = node.arguments[0];
      if (channel?.type === "Literal" && typeof channel.value === "string") {
        found.push({
          channel: channel.value,
          location: `${filename}:${node.loc.start.line}`,
          method: node.callee.property.name,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value?.type) visit(value);
    }
  }
  visit(ast);
  return found;
}

const files = [
  path.join(root, "main.js"),
  ...javascriptFiles(path.join(root, "src/helpers")),
  ...javascriptFiles(path.join(root, "src/services")),
];
const sources = files.flatMap((filename) => {
  const source = fs.readFileSync(filename, "utf8");
  if (!/\bipcMain\.(handle|on)\s*\(/.test(source)) return [];
  return [
    {
      filename: path.relative(root, filename),
      ast: parse(source, { ecmaVersion: "latest", sourceType: "module", loc: true }),
    },
  ];
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`permanent IPC inventory has no duplicate handle/on channels on ${platform}`, () => {
    const channels = new Map();
    const duplicates = [];
    for (const { filename, ast } of sources) {
      for (const registration of registrations(ast, platform, filename)) {
        const previous = channels.get(registration.channel);
        if (previous)
          duplicates.push(
            `${registration.channel}: ${previous.location} (${previous.method}), ${registration.location} (${registration.method})`
          );
        channels.set(registration.channel, registration);
      }
    }
    assert.ok(channels.size > 300, "scan must include the real main-process registrations");
    assert.deepEqual(duplicates, [], duplicates.join("\n"));
    // Both source occurrences are retained; their platform guards are disjoint.
    assert.equal(channels.get("hotkey-changed").method, "on");
  });
}

test("inventory detects duplicate listeners and handlers and respects platform branches", () => {
  const ast = parse(
    `
    if (process.platform === "darwin") ipcMain.on("hotkey", () => {});
    if (process.platform === "win32" || process.platform === "linux") ipcMain.on("hotkey", () => {});
    ipcMain.handle("duplicate", () => {});
    ipcMain.handle("duplicate", () => {});
    ipcMain.on("listener", () => {});
    ipcMain.on("listener", () => {});
  `,
    { ecmaVersion: "latest", loc: true }
  );
  for (const platform of ["darwin", "win32", "linux"]) {
    const channels = registrations(ast, platform, "fixture").map(({ channel }) => channel);
    assert.deepEqual(channels, ["hotkey", "duplicate", "duplicate", "listener", "listener"]);
  }
});
