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
  "fanOut",
  "schedule",
  "lastRunAt",
  "nextRunAt",
]);
const requiredFields = [...fields].filter(
  (key) => !["fanOut", "schedule", "lastRunAt", "nextRunAt"].includes(key)
);

function validatePreset(preset, projects, { allowMissingProject = false } = {}) {
  if (
    !isObject(preset) ||
    Object.keys(preset).some((key) => !fields.has(key)) ||
    requiredFields.some((key) => !(key in preset))
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
  if (!project && !allowMissingProject) throw new Error("Unknown preset project");
  if (preset.schedule?.enabled && project?.mode === "write" && !allowMissingProject)
    throw new Error("schedule_requires_read_only");
  if (
    !allowMissingProject &&
    project &&
    (preset.harness !== project.defaultHarness || preset.mode !== project.mode)
  )
    throw new Error("Preset harness or mode does not match project");
  if (preset.model !== null && !safeModel(preset.model)) throw new Error("Invalid preset model");
  const placeholders = extractPlaceholders(preset.prompt);
  if (
    preset.fanOut !== undefined &&
    (preset.fanOut !== "open-pull-requests" || !placeholders.includes("pr"))
  )
    throw new Error("Invalid preset fanOut");
  if (preset.schedule !== undefined) {
    if (
      !isObject(preset.schedule) ||
      Object.keys(preset.schedule).some((key) => !["intervalMinutes", "enabled"].includes(key)) ||
      !Number.isInteger(preset.schedule.intervalMinutes) ||
      preset.schedule.intervalMinutes < 15 ||
      preset.schedule.intervalMinutes > 10080 ||
      typeof preset.schedule.enabled !== "boolean"
    )
      throw new Error("Invalid preset schedule");
    if (
      preset.schedule.enabled &&
      (preset.mode === "write" || (!allowMissingProject && project?.mode === "write"))
    )
      throw new Error("schedule_requires_read_only");
    if (preset.schedule.enabled && (preset.fanOut || placeholders.length))
      throw new Error("schedule_requires_static_prompt");
  }
  for (const key of ["lastRunAt", "nextRunAt"])
    if (
      preset[key] !== undefined &&
      preset[key] !== null &&
      (!Number.isSafeInteger(preset[key]) || preset[key] < 0 || preset[key] > 8.64e15)
    )
      throw new Error(`Invalid preset ${key}`);
  return {
    id: preset.id,
    name: preset.name,
    project: preset.project,
    harness: preset.harness,
    model: preset.model?.trim() || null,
    mode: preset.mode,
    prompt: preset.prompt,
    description: preset.description,
    ...(preset.fanOut ? { fanOut: preset.fanOut } : {}),
    ...(preset.schedule ? { schedule: { ...preset.schedule } } : {}),
    ...(preset.lastRunAt !== undefined ? { lastRunAt: preset.lastRunAt } : {}),
    ...(preset.nextRunAt !== undefined ? { nextRunAt: preset.nextRunAt } : {}),
  };
}

function createPresetStore(file, projectStore, fsImpl = fs, now = Date.now) {
  const validateData = (value) => {
    if (
      !isObject(value) ||
      Object.keys(value).some((key) => key !== "presets") ||
      !Array.isArray(value.presets)
    )
      throw new Error("Invalid presets file");
    const projects = projectStore.read().projects;
    const presets = value.presets.map((preset) =>
      validatePreset(preset, projects, { allowMissingProject: true })
    );
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
      const previous = data.presets.find((item) => item.id === valid.id);
      const changed =
        valid.schedule?.enabled &&
        (!previous?.schedule?.enabled ||
          previous.schedule.intervalMinutes !== valid.schedule.intervalMinutes);
      valid.lastRunAt = previous?.lastRunAt ?? null;
      valid.nextRunAt = valid.schedule?.enabled
        ? changed
          ? now() + valid.schedule.intervalMinutes * 60_000
          : (previous?.nextRunAt ?? now() + valid.schedule.intervalMinutes * 60_000)
        : null;
      data.presets = data.presets.filter((item) => item.id !== valid.id);
      data.presets.push(valid);
      return write(data);
    },
    remove(id) {
      const data = read();
      data.presets = data.presets.filter((item) => item.id !== id);
      return write(data);
    },
    recordRun(id, runAt) {
      const data = read();
      const preset = data.presets.find((item) => item.id === id);
      if (!preset?.schedule?.enabled) return false;
      preset.lastRunAt = runAt;
      preset.nextRunAt = runAt + preset.schedule.intervalMinutes * 60_000;
      write(data);
      return true;
    },
  };
}
module.exports = { extractPlaceholders, resolvePresetPrompt, validatePreset, createPresetStore };
