const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const SQLite = require("better-sqlite3");
const createTempDir = require("../lib/tempDir");

function fixture(t) {
  const dir = createTempDir("crypto-init-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new SQLite(path.join(dir, "transcriptions.db"));
  db.exec("CREATE TABLE voice_exemplar_audio(ciphertext BLOB)");
  db.close();
  fs.mkdirSync(path.join(dir, "secure-keys"));
  const legacy = Buffer.from("safe:legacy secret");
  fs.writeFileSync(path.join(dir, "secure-keys", "API_KEY.enc"), legacy);
  let password = null;
  const calls = { fs: 0, sweeps: 0, opens: 0 };
  const observedFs = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.fs++;
        if (/^(readdir|opendir)/.test(property)) calls.sweeps++;
        return value.apply(target, args);
      };
    },
  });
  const load = Module._load;
  t.mock.method(Module, "_load", function (name, ...args) {
    if (name === "fs") return observedFs;
    if (name === "better-sqlite3")
      return new Proxy(SQLite, {
        construct(target, args) {
          calls.opens++;
          return new target(...args);
        },
      });
    if (name === "electron")
      return {
        app: { getPath: () => dir },
        safeStorage: {
          isEncryptionAvailable: () => true,
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
            return password;
          }
          setPassword(value) {
            password = value;
          }
        },
      };
    if (name === "./debugLogger") return { info() {}, warn() {} };
    return load.call(this, name, ...args);
  });
  const modulePath = require.resolve("../../src/helpers/secretCrypto");
  delete require.cache[modulePath];
  const secrets = require(modulePath);
  t.after(() => delete require.cache[modulePath]);
  const reset = () => Object.assign(calls, { fs: 0, sweeps: 0, opens: 0 });
  reset();
  return { secrets, calls, dir, legacy, reset, password: () => password };
}

for (const operation of ["decrypt", "encrypt", "encryptBytes", "decryptBytes", "isAvailable"]) {
  test(`cold ${operation} never sweeps the profile or opens SQLite to authorize a key`, (t) => {
    const f = fixture(t);
    if (operation.endsWith("Bytes")) {
      assert.throws(() => f.secrets[operation](Buffer.alloc(64)), {
        code: "audio_key_unavailable",
      });
    } else if (operation === "decrypt") {
      assert.equal(f.secrets.decrypt(f.legacy).value, "legacy secret");
    } else if (operation === "encrypt") {
      assert.deepEqual(f.secrets.encrypt("new secret"), Buffer.from("safe:new secret"));
    } else {
      assert.equal(f.secrets.isAvailable(), true);
    }
    assert.equal(f.calls.sweeps, 0);
    assert.equal(f.calls.opens, 0);
    assert.equal(f.password(), null);
  });
}

test("startup decides once; second and later decryptBytes calls perform zero filesystem or SQLite calls", (t) => {
  const f = fixture(t);
  f.secrets.initializeKey();
  assert.equal(f.calls.sweeps, 1, "the legacy credential directory is inspected at startup");
  assert.equal(f.calls.opens, 1, "the legacy exemplar check runs at startup");
  const bytes = Buffer.from("saved audio");
  const encrypted = f.secrets.encryptBytes(bytes);
  assert.deepEqual(f.secrets.decryptBytes(encrypted), bytes);
  f.reset();
  for (let i = 0; i < 4; i++) assert.deepEqual(f.secrets.decryptBytes(encrypted), bytes);
  f.secrets.initializeKey();
  assert.deepEqual(f.calls, { fs: 0, sweeps: 0, opens: 0 });
});

test("a key-use marker refuses creation without sweeping directories or opening the database", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "secure-keys", "master-key-in-use"), "1");
  f.secrets.initializeKey();
  assert.equal(f.calls.sweeps, 0);
  assert.equal(f.calls.opens, 0);
  assert.equal(f.password(), null);
  f.reset();
  for (let i = 0; i < 3; i++)
    assert.throws(() => f.secrets.decryptBytes(Buffer.alloc(64)), {
      code: "audio_key_unavailable",
    });
  f.secrets.initializeKey();
  assert.deepEqual(f.calls, { fs: 0, sweeps: 0, opens: 0 });
});

test("an unreadable startup database fails closed and its failure is cached", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "transcriptions.db"), "not a SQLite database");
  f.secrets.initializeKey();
  assert.equal(f.calls.opens, 1);
  assert.equal(f.password(), null);
  f.reset();
  f.secrets.initializeKey();
  assert.throws(() => f.secrets.encryptBytes(Buffer.from("new recording")), {
    code: "audio_key_unavailable",
  });
  assert.deepEqual(f.calls, { fs: 0, sweeps: 0, opens: 0 });
});
