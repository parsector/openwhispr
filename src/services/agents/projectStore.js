const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = new Set(["name", "folder", "defaultHarness", "mode", "model"]);
function validateProject(project, fsImpl = fs) {
  if (!isObject(project) || Object.keys(project).some((key) => !fields.has(key)))
    throw new Error("Invalid project fields");
  if (
    typeof project.name !== "string" ||
    !/^[a-zA-Z0-9 _.-]{1,80}$/.test(project.name) ||
    project.name !== project.name.trim()
  )
    throw new Error("Invalid project name");
  if (
    typeof project.folder !== "string" ||
    !path.isAbsolute(project.folder) ||
    !fsImpl.statSync(project.folder).isDirectory()
  )
    throw new Error("Project folder must be an existing absolute directory");
  if (!["claude", "cursor-agent"].includes(project.defaultHarness))
    throw new Error("Invalid harness");
  if (project.mode !== "read-only") throw new Error("Invalid project mode");
  if (
    project.model !== null &&
    project.model !== undefined &&
    (typeof project.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(project.model))
  )
    throw new Error("Invalid model");
  return {
    name: project.name,
    folder: project.folder,
    defaultHarness: project.defaultHarness,
    mode: project.mode,
    model: project.model || null,
  };
}
function validateData(value, fsImpl = fs) {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => key !== "projects") ||
    !Array.isArray(value.projects)
  )
    throw new Error("Invalid projects file");
  const projects = value.projects.map((project) => validateProject(project, fsImpl));
  if (new Set(projects.map((project) => project.name.toLowerCase())).size !== projects.length)
    throw new Error("Duplicate project name");
  return { projects };
}
function createProjectStore(file, fsImpl = fs) {
  function read() {
    try {
      return validateData(JSON.parse(fsImpl.readFileSync(file, "utf8")), fsImpl);
    } catch (error) {
      if (error.code === "ENOENT") return { projects: [] };
      // Keep corrupt input for diagnosis, then let the owner rebuild the allowlist.
      try {
        fsImpl.renameSync(file, `${file}.corrupt.${Date.now()}`);
      } catch {}
      return { projects: [] };
    }
  }
  function write(value) {
    const data = validateData(value, fsImpl);
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
    save(project) {
      const data = read();
      const valid = validateProject(project, fsImpl);
      data.projects = data.projects.filter((item) => item.name !== valid.name);
      data.projects.push(valid);
      return write(data);
    },
    remove(name) {
      const data = read();
      data.projects = data.projects.filter((item) => item.name !== name);
      return write(data);
    },
  };
}
module.exports = { validateProject, validateData, createProjectStore };
