const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const SQLite = require("better-sqlite3");
const createTempDir = require("../lib/tempDir");

function fixture(t) {
  const dir = createTempDir("exemplar-key-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let password = null;
  let locked = false;
  let backupAvailable = true;
  const logs = [];
  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === "electron")
      return {
        app: { getPath: () => dir, isReady: () => false },
        safeStorage: {
          isEncryptionAvailable: () => backupAvailable,
          encryptString: (value) => Buffer.from(`safe:${value}`),
          decryptString: (value) => {
            const text = value.toString();
            if (!text.startsWith("safe:")) throw Error("Not a safeStorage credential");
            return text.slice(5);
          },
        },
      };
    if (name === "@napi-rs/keyring")
      return {
        Entry: class {
          getPassword() {
            if (locked) throw Error("locked");
            return password;
          }
          setPassword(value) {
            password = value;
          }
        },
      };
    if (name === "./debugLogger")
      return {
        warn: (...args) => logs.push(args),
        info: (...args) => logs.push(args),
      };
    return original.call(this, name, ...args);
  };
  t.after(() => {
    Module._load = original;
  });
  const reload = () => {
    for (const file of ["secretCrypto", "voiceExemplarAudio"])
      delete require.cache[require.resolve(`../../src/helpers/${file}`)];
    return {
      encryption: require("../../src/helpers/secretCrypto"),
      audio: require("../../src/helpers/voiceExemplarAudio"),
    };
  };
  let db = new SQLite(path.join(dir, "transcriptions.db"));
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE speaker_profiles(id INTEGER PRIMARY KEY); CREATE TABLE notes(id INTEGER PRIMARY KEY, client_note_id TEXT); INSERT INTO speaker_profiles VALUES(1); INSERT INTO notes VALUES(1, 'note')"
  );
  const first = reload();
  first.audio.open(db);
  const bytes = Buffer.alloc(44 + 24000 * 2 * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 24000 * 4; i++)
    bytes.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), 44 + i * 2);
  const candidate = {
    id: "clip",
    profileId: 1,
    noteId: 1,
    rowIds: ["row"],
    revision: "approved",
    track: "mic",
    startSample: 0,
    endSample: 24000 * 4,
    durationSeconds: 4,
    meetingDate: "2026-11-05",
  };
  const seal = () => {
    first.audio.save(db, candidate, bytes, first.audio.seal(first, bytes), Buffer.alloc(4));
  };
  return {
    get db() {
      return db;
    },
    bytes,
    logs,
    reload,
    restart() {
      db.close();
      db = new SQLite(path.join(dir, "transcriptions.db"));
      return reload();
    },
    seal,
    first,
    loseCredential() {
      password = null;
    },
    lock() {
      locked = true;
    },
    noBackup() {
      backupAvailable = false;
    },
    enableBackup() {
      backupAvailable = true;
    },
    backupExists: () => fs.existsSync(path.join(dir, "secure-keys", "master-key-backup.enc")),
    forgetBackup() {
      fs.rmSync(path.join(dir, "secure-keys"), { recursive: true, force: true });
    },
    password: () => password,
    replaceCredential() {
      password = crypto.randomBytes(32).toString("base64");
    },
    legacySecret(blob = Buffer.from("safe:legacy-test-value")) {
      const file = path.join(dir, "secure-keys", "OPENAI_API_KEY.enc");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, blob);
      return blob;
    },
  };
}

test("sealed exemplar plays after restarting the production crypto init path and recovering its backup", (t) => {
  const f = fixture(t);
  f.seal();
  f.loseCredential();
  const next = f.restart();
  assert.deepEqual(next.audio.play(f.db, next, "clip").wav, f.bytes);
});

test("missing credential and backup never replace the key of an existing exemplar", (t) => {
  const f = fixture(t);
  f.noBackup();
  f.seal();
  f.loseCredential();
  f.forgetBackup(); // also simulates an install predating key backups/markers
  const next = f.reload();
  assert.throws(() => next.encryption.encryptBytes(Buffer.from("new recording")), {
    code: "audio_key_unavailable",
  });
  assert.equal(f.password(), null);
  assert.equal(next.audio.play(f.db, next, "clip").error, "exemplar_key_unavailable");
  assert.equal(f.db.prepare("SELECT count(*) n FROM voice_exemplar_audio").get().n, 1);
});

test("authentication failures and truncated blobs are not reported as missing keys", (t) => {
  const f = fixture(t);
  f.seal();
  f.db.prepare("UPDATE voice_exemplar_audio SET ciphertext=?").run(Buffer.alloc(3));
  assert.equal(f.first.audio.play(f.db, f.first, "clip").error, "exemplar_audio_truncated");
});

test("a different persisted key is an authentication failure, not an unavailable key", (t) => {
  const f = fixture(t);
  f.seal();
  f.replaceCredential();
  const next = f.reload();
  assert.equal(next.audio.play(f.db, next, "clip").error, "exemplar_authentication_failed");
  assert.equal(f.db.prepare("SELECT count(*) n FROM voice_exemplar_audio").get().n, 1);
});

test("a locked key without a usable backup is reported once for all saved clips", (t) => {
  const f = fixture(t);
  f.noBackup();
  f.seal();
  f.db.exec(
    "INSERT INTO voice_exemplar_audio SELECT 'second-clip', profile_id, note_id, note_identity, recording_id, note_title, row_ids, revision, track, start_sample, end_sample, duration_ms, byte_length, codec, sample_rate, meeting_date, approved_at, created_at, content_hash, ciphertext, embedding, valid FROM voice_exemplar_audio"
  );
  f.lock();
  const next = f.reload();
  assert.equal(next.audio.play(f.db, next, "clip").error, "exemplar_key_unavailable");
  assert.equal(next.audio.play(f.db, next, "second-clip").error, "exemplar_key_unavailable");
  assert.equal(
    f.logs.filter(([message]) => message === "Saved exemplar audio unavailable").length,
    1
  );
});

test("ciphertext authentication and plaintext integrity failures remain distinct", (t) => {
  const f = fixture(t);
  f.seal();
  const { ciphertext } = f.db.prepare("SELECT ciphertext FROM voice_exemplar_audio").get();
  const damaged = Buffer.from(ciphertext);
  damaged[13] ^= 1;
  f.db.prepare("UPDATE voice_exemplar_audio SET ciphertext=?").run(damaged);
  assert.equal(f.first.audio.play(f.db, f.first, "clip").error, "exemplar_authentication_failed");
  f.db
    .prepare("UPDATE voice_exemplar_audio SET ciphertext=?, content_hash='wrong'")
    .run(ciphertext);
  assert.equal(f.first.audio.play(f.db, f.first, "clip").error, "exemplar_integrity_failed");
});

test("reading ciphertext on a new install does not create a master key", (t) => {
  const f = fixture(t);
  assert.throws(() => f.first.encryption.decryptBytes(Buffer.alloc(64)), {
    code: "audio_key_unavailable",
  });
  assert.equal(f.password(), null);
});

test("a readable safeStorage-only install can initialize its first audio key", (t) => {
  const f = fixture(t);
  const legacy = f.legacySecret();
  assert.equal(f.first.encryption.decrypt(legacy).value, "legacy-test-value");
  f.seal();
  const next = f.restart();
  assert.deepEqual(next.audio.play(f.db, next, "clip").wav, f.bytes);
});

test("an unreadable old master-key credential also prevents silent replacement", (t) => {
  const f = fixture(t);
  const encrypted = f.first.encryption.encrypt("old test credential");
  f.loseCredential();
  f.forgetBackup();
  f.legacySecret(encrypted);
  const next = f.reload();
  assert.throws(() => next.encryption.encryptBytes(Buffer.from("new clip")), {
    code: "audio_key_unavailable",
  });
  assert.equal(f.password(), null);
});

test("an unreadable profile cannot be mistaken for a fresh install when the key is missing", (t) => {
  const f = fixture(t);
  f.noBackup();
  f.seal();
  f.loseCredential();
  f.forgetBackup();
  const root = path.dirname(f.db.name);
  const exists = fs.existsSync;
  const access = fs.accessSync;
  // existsSync swallows EACCES and returns false: that is not proof of absence.
  t.mock.method(fs, "existsSync", (file) => (String(file).startsWith(root) ? false : exists(file)));
  t.mock.method(fs, "accessSync", (file, ...args) => {
    if (String(file).startsWith(root))
      throw Object.assign(Error("unreadable profile"), { code: "EACCES" });
    return access(file, ...args);
  });
  const next = f.reload();
  assert.throws(() => next.encryption.encryptBytes(Buffer.from("new recording")), {
    code: "audio_key_unavailable",
  });
  assert.equal(f.password(), null);
});

test("an existing credential gains a missing backup without changing its key", (t) => {
  const f = fixture(t);
  f.noBackup();
  f.seal();
  const original = f.password();
  assert.equal(f.backupExists(), false);
  f.enableBackup();
  // Availability of safeStorage can change independently of the credential.
  const next = f.reload();
  assert.deepEqual(next.audio.play(f.db, next, "clip").wav, f.bytes);
  assert.equal(f.password(), original);
  assert.equal(f.backupExists(), true);
});

test("an unwritable key-use marker cannot hide a reachable persisted playback key", (t) => {
  const f = fixture(t);
  f.seal();
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (String(file).endsWith("master-key-in-use"))
      throw Object.assign(Error("read-only"), { code: "EACCES" });
    return write(file, ...args);
  });
  const next = f.reload();
  assert.deepEqual(next.audio.play(f.db, next, "clip").wav, f.bytes);
});

test("an unexpected cipher exception is not mislabeled as a missing key", (t) => {
  const f = fixture(t);
  f.seal();
  f.first.encryption.decryptBytes = () => {
    throw new TypeError("cipher runtime failure");
  };
  assert.equal(f.first.audio.play(f.db, f.first, "clip").error, "exemplar_decryption_failed");
});

test("a worker without Electron reports an unavailable key through the exemplar boundary", async (t) => {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const audio = require(workerData);
    const db = { prepare: () => ({ get: () => ({ ciphertext: Buffer.alloc(64) }) }) };
    parentPort.postMessage(audio.play(db, null, "clip"));
  `,
    { eval: true, workerData: require.resolve("../../src/helpers/voiceExemplarAudio") }
  );
  t.after(() => worker.terminate());
  const result = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.deepEqual(result, { state: "key_unavailable", error: "exemplar_key_unavailable" });
});
