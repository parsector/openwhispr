const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

test('an unreadable or missing Keychain entry recovers the existing backup without replacing it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-key-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backup = path.join(dir, 'secure-keys', 'master-key-backup.enc');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const oldKey = crypto.randomBytes(32);
  const original = Buffer.from(oldKey.toString('base64'));
  const load = read => {
    fs.writeFileSync(backup, original);
    let writes = 0;
    const oldLoad = Module._load;
    Module._load = function(request, ...args) {
      if (request === 'electron') return { app: { getPath: () => dir }, safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString(),
      } };
      if (request === '@napi-rs/keyring') return { Entry: class {
        getPassword() { if (read === 'throw') throw Error('locked'); return null; }
        setPassword() { writes++; }
      } };
      return oldLoad.call(this, request, ...args);
    };
    const modulePath = require.resolve('../../src/helpers/secretCrypto');
    delete require.cache[modulePath];
    const secrets = require(modulePath);
    let ciphertext;
    try { ciphertext = secrets.encryptBytes(Buffer.from('old recording')); }
    finally { Module._load = oldLoad; }
    const iv = ciphertext.subarray(0, 12);
    const decipher = crypto.createDecipheriv('aes-256-gcm', oldKey, iv);
    decipher.setAuthTag(ciphertext.subarray(-16));
    assert.equal(Buffer.concat([decipher.update(ciphertext.subarray(12, -16)), decipher.final()]).toString(), 'old recording');
    assert.deepEqual(fs.readFileSync(backup), original);
    assert.equal(writes, read === 'throw' ? 0 : 1);
  };
  load('throw');
  load('missing');
});

test('device erasure removes the Keychain key and its on-disk backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-key-wipe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let password = null, deletes = 0;
  const oldLoad = Module._load;
  Module._load = function(request, ...args) {
    if (request === 'electron') return { app: { getPath: () => dir }, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text),
      decryptString: bytes => bytes.toString(),
    } };
    if (request === '@napi-rs/keyring') return { Entry: class {
      getPassword() { return password; }
      setPassword(value) { password = value; }
      deletePassword() { password = null; deletes++; }
    } };
    return oldLoad.call(this, request, ...args);
  };
  try {
    const modulePath = require.resolve('../../src/helpers/secretCrypto');
    delete require.cache[modulePath];
    const secrets = require(modulePath);
    secrets.encryptBytes(Buffer.from('old'));
    const first = password;
    const backup = path.join(dir, 'secure-keys', 'master-key-backup.enc');
    assert.equal(fs.existsSync(backup), true);
    secrets.clearDeviceKey();
    assert.equal(deletes, 1);
    assert.equal(password, null);
    assert.equal(fs.existsSync(backup), false);
    secrets.encryptBytes(Buffer.from('new'));
    assert.notEqual(password, first);
  } finally { Module._load = oldLoad; }
});
