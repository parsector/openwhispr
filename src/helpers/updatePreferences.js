const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "update-preferences.json";
// The renderer's fresh-install default is true. It syncs the legacy
// onboarding-based preference on startup for existing installations.
const DEFAULT_ENABLED = true;

function readAutoUpdatesEnabled(userData) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(userData, FILE_NAME), "utf8"));
    return typeof value.autoUpdatesEnabled === "boolean"
      ? value.autoUpdatesEnabled
      : DEFAULT_ENABLED;
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_ENABLED;
    throw error;
  }
}

function writeAutoUpdatesEnabled(userData, enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("Expected boolean update preference");
  fs.mkdirSync(userData, { recursive: true });
  const file = path.join(userData, FILE_NAME);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ autoUpdatesEnabled: enabled }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

module.exports = { DEFAULT_ENABLED, readAutoUpdatesEnabled, writeAutoUpdatesEnabled };
