const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { safeModel } = require("./modelSafety");
const { extractPlaceholders, resolvePresetPrompt } = require("./presetPlaceholders.mjs");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = new Set([
  "id",
  "name",
  "project",
  "harness",
  "model",
  "mode",
  "prompt",
  "description",
]);

function validatePreset(preset, projects) {
  if (
    !isObject(preset) ||
    Object.keys(preset).some((key) => !fields.has(key)) ||
    [...fields].some((key) => !(key in preset))
  )
    throw new Error("Invalid preset fields");
  if (typeof preset.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(preset.id))
    throw new Error("Invalid preset id");
  if (
    typeof preset.name !== "string" ||
    !/^[\p{L}\p{M}\p{N} _.,:;!?()'-]{1,80}$/u.test(preset.name) ||
    preset.name !== preset.name.trim()
  )
    throw new Error("Invalid preset name");
  if (typeof preset.description !== "string" || preset.description.length > 500)
    throw new Error("Invalid preset description");
  const project = projects.find((item) => item.name === preset.project);
  if (!project) throw new Error("Unknown preset project");
  if (preset.harness !== project.defaultHarness || preset.mode !== project.mode)
    throw new Error("Preset harness or mode does not match project");
  if (preset.model !== null && !safeModel(preset.model)) throw new Error("Invalid preset model");
  extractPlaceholders(preset.prompt);
  return {
    id: preset.id,
    name: preset.name,
    project: preset.project,
    harness: preset.harness,
    model: preset.model?.trim() || null,
    mode: preset.mode,
    prompt: preset.prompt,
    description: preset.description,
  };
}

function createPresetStore(file, projectStore, fsImpl = fs) {
  const validateData = (value) => {
    if (
      !isObject(value) ||
      Object.keys(value).some((key) => key !== "presets") ||
      !Array.isArray(value.presets)
    )
      throw new Error("Invalid presets file");
    const projects = projectStore.read().projects;
    const presets = value.presets.map((preset) => validatePreset(preset, projects));
    if (
      new Set(presets.map((item) => item.id)).size !== presets.length ||
      new Set(presets.map((item) => item.name.toLowerCase())).size !== presets.length
    )
      throw new Error("Duplicate preset id or name");
    return { presets };
  };
  function read() {
    try {
      return validateData(JSON.parse(fsImpl.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return { presets: [] };
      try {
        fsImpl.renameSync(file, `${file}.corrupt.${Date.now()}`);
      } catch {}
      return { presets: [] };
    }
  }
  function write(value) {
    const data = validateData(value);
    const dir = path.dirname(file);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fsImpl.chmodSync(dir, 0o700);
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fsImpl.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fsImpl.renameSync(temp, file);
      if (process.platform !== "win32") fsImpl.chmodSync(file, 0o600);
    } catch (error) {
      try {
        fsImpl.unlinkSync(temp);
      } catch {}
      throw error;
    }
    return data;
  }
  return {
    read,
    write,
    save(preset) {
      const valid = validatePreset(preset, projectStore.read().projects);
      const data = read();
      data.presets = data.presets.filter((item) => item.id !== valid.id);
      data.presets.push(valid);
      return write(data);
    },
    remove(id) {
      const data = read();
      data.presets = data.presets.filter((item) => item.id !== id);
      return write(data);
    },
  };
}
module.exports = { extractPlaceholders, resolvePresetPrompt, validatePreset, createPresetStore };
