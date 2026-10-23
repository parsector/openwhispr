const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createTokenStore(userData, fsImpl = fs) {
  const dir = path.join(userData, "mcp");
  const file = path.join(dir, "tokens.json");
  const logFile = path.join(dir, "activity.json");

  function read(target) {
    try { return JSON.parse(fsImpl.readFileSync(target, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  function write(target, value) {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fsImpl.chmodSync(dir, 0o700);
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fsImpl.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
      fsImpl.renameSync(temp, target);
      if (process.platform !== "win32") fsImpl.chmodSync(target, 0o600);
    } catch (error) {
      try { fsImpl.unlinkSync(temp); } catch { /* No temp file was created. */ }
      throw error;
    }
  }
  const publicToken = ({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt });
  function list() { return read(file).map(publicToken); }
  function create(label) {
    if (typeof label !== "string" || !label.trim() || label.length > 100) {
      throw new Error("Token label must be 1–100 characters");
    }
    const plaintext = `owk_${crypto.randomBytes(32).toString("base64url")}`;
    const entry = {
      id: crypto.randomUUID(), label: label.trim(),
      hash: crypto.createHash("sha256").update(plaintext).digest("hex"),
      createdAt: new Date().toISOString(), lastUsedAt: null,
    };
    write(file, [...read(file), entry]);
    return { ...publicToken(entry), plaintext };
  }
  function verify(plaintext) {
    if (typeof plaintext !== "string" || !/^owk_[A-Za-z0-9_-]{43}$/.test(plaintext)) return null;
    const digest = crypto.createHash("sha256").update(plaintext).digest();
    const entries = read(file);
    let match = null;
    for (const entry of entries) {
      const stored = Buffer.from(entry.hash, "hex");
      if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest)) match = entry;
    }
    if (match) {
      match.lastUsedAt = new Date().toISOString();
      write(file, entries);
      return publicToken(match);
    }
    return null;
  }
  function revoke(id) {
    const entries = read(file);
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length === entries.length) return false;
    write(file, remaining);
    return true;
  }
  function activity() { return read(logFile); }
  function record(clientName, tool) {
    const safeName = typeof clientName === "string" ? clientName.slice(0, 100) : "Unknown client";
    write(logFile, [...read(logFile), { clientName: safeName, tool, timestamp: new Date().toISOString() }].slice(-100));
  }
  return { create, list, verify, revoke, activity, record };
}

module.exports = { createTokenStore };
