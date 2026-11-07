const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isMainThread } = require("node:worker_threads");
const { app, safeStorage } = isMainThread ? require("electron") : {};
const debugLogger = require("./debugLogger");

const SERVICE = "OpenWhispr";
const ACCOUNT = "secrets-master-key";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const BACKUP_FILE = "master-key-backup.enc";

let mode = null;
let masterKey = null;

function _backupPath() {
  return path.join(app.getPath("userData"), "secure-keys", BACKUP_FILE);
}

function _saveMasterKeyBackup() {
  if (!masterKey || !safeStorage.isEncryptionAvailable()) return;
  const target = _backupPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const encrypted = safeStorage.encryptString(masterKey.toString("base64"));
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    debugLogger.warn("failed to save master key backup", { error: error?.message }, "secretCrypto");
  }
}

function _loadMasterKeyBackup() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const buf = fs.readFileSync(_backupPath());
    const b64 = safeStorage.decryptString(buf);
    const key = Buffer.from(b64, "base64");
    if (key.length !== KEY_LEN) return false;
    masterKey = key;
    return true;
  } catch {
    return false;
  }
}

function _initKeychain(allowCreate = true) {
  let Entry;
  try {
    ({ Entry } = require("@napi-rs/keyring"));
  } catch (error) {
    debugLogger.warn("@napi-rs/keyring failed to load", { error: error?.message }, "secretCrypto");
    return false;
  }

  try {
    const entry = new Entry(SERVICE, ACCOUNT);
    let stored = null;
    stored = entry.getPassword();
    if (stored) {
      const key = Buffer.from(stored, "base64");
      if (key.length !== KEY_LEN) throw new Error("stored key length invalid");
      masterKey = key;
    } else {
      if (fs.existsSync(_backupPath())) {
        if (!_loadMasterKeyBackup()) throw new Error("Existing master key backup is unreadable");
      } else if (allowCreate) masterKey = crypto.randomBytes(KEY_LEN);
      else return false;
      entry.setPassword(masterKey.toString("base64"));
      // Write a backup only for a newly generated key. Never replace the
      // existing backup after a Keychain read failure or missing entry.
      if (!fs.existsSync(_backupPath())) _saveMasterKeyBackup();
    }
    return true;
  } catch (error) {
    debugLogger.warn(
      "OS keychain unavailable — falling back to safeStorage",
      { error: error?.message, platform: process.platform },
      "secretCrypto"
    );
    return false;
  }
}

function _ensureInit(allowCreate = true) {
  if (mode) return;
  if (_initKeychain(allowCreate)) {
    mode = "keychain";
    return;
  }
  if (_loadMasterKeyBackup()) {
    mode = "keychain";
    debugLogger.info("recovered master key from safeStorage backup", {}, "secretCrypto");
    return;
  }
  mode = safeStorage.isEncryptionAvailable() ? "safeStorage" : "unavailable";
}

// Called once per scheduled key-related recovery retry. Ordinary reads keep
// their cached backend; refresh never generates a replacement recording key.
function refreshAudioKey() {
  if (mode === "keychain" && masterKey) return;
  mode = null;
  _ensureInit(false);
}

function isAvailable() {
  _ensureInit();
  return mode !== "unavailable";
}

function encrypt(plaintext) {
  _ensureInit();
  if (mode === "keychain") {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }
  if (mode === "safeStorage") return safeStorage.encryptString(plaintext);
  throw new Error("no encryption backend available");
}

function decrypt(blob) {
  _ensureInit();
  if (mode === "keychain" && blob.length > IV_LEN + TAG_LEN) {
    try {
      const iv = blob.subarray(0, IV_LEN);
      const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = blob.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      return { value, needsReencrypt: false };
    } catch {
      // Legacy safeStorage blob — handled by the fallback below.
    }
  }
  if (safeStorage.isEncryptionAvailable()) {
    return {
      value: safeStorage.decryptString(blob),
      needsReencrypt: mode === "keychain",
    };
  }
  throw new Error("decryption failed: no backend available");
}

// Audio is binary and must never be turned into a UTF-8 string. Keep the
// authenticated envelope separate from the legacy string secret format.
function encryptBytes(bytes) {
  _ensureInit();
  if (mode !== "keychain" || !masterKey) {
    throw Object.assign(
      new Error("Audio encryption key is unavailable in the OS credential store"),
      {
        code: "audio_key_unavailable",
      }
    );
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

function decryptBytes(blob) {
  _ensureInit();
  if (mode !== "keychain" || !masterKey) {
    throw Object.assign(
      new Error("Audio encryption key is unavailable in the OS credential store"),
      { code: "audio_key_unavailable" }
    );
  }
  try {
    if (blob.length < IV_LEN + TAG_LEN) throw new Error("Encrypted audio chunk is truncated");
    const decipher = crypto.createDecipheriv(ALGO, masterKey, blob.subarray(0, IV_LEN));
    decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
    return Buffer.concat([decipher.update(blob.subarray(IV_LEN, -TAG_LEN)), decipher.final()]);
  } catch (cause) {
    throw Object.assign(new Error("Encrypted audio authentication failed", { cause }), {
      code: "audio_corrupt",
    });
  }
}

function clearDeviceKey() {
  // The device erasure path calls this only after every recording is removed.
  try {
    const { Entry } = require("@napi-rs/keyring");
    const entry = new Entry(SERVICE, ACCOUNT);
    try {
      entry.deletePassword();
    } catch (error) {
      if (!/NoEntry|no entry|not found/i.test(String(error?.message))) throw error;
    }
  } finally {
    fs.rmSync(_backupPath(), { force: true });
    if (masterKey) masterKey.fill(0);
    masterKey = null;
    mode = null;
  }
}

module.exports = {
  // Copy an already unlocked key to a local calibration worker. Never perform
  // credential-store I/O on the UI thread merely to start a background job.
  getWorkerKey: () => (mode === "keychain" && masterKey ? Buffer.from(masterKey) : null),
  encrypt,
  decrypt,
  isAvailable,
  encryptBytes,
  decryptBytes,
  refreshAudioKey,
  clearDeviceKey,
};
