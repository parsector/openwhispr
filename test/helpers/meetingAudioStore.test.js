const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { MeetingAudioStore, RATE } = require("../../src/helpers/meetingAudioStore");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const encryption = {
    encryptBytes(bytes) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(blob) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      cipher.setAuthTag(blob.subarray(-16));
      return Buffer.concat([cipher.update(blob.subarray(12, -16)), cipher.final()]);
    },
  };
  let clock = 1_700_000_000_000;
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY, transcript TEXT);
    CREATE TABLE speaker_profiles(id INTEGER PRIMARY KEY, embedding BLOB, sample_count INTEGER, voice_needs_reapproval INTEGER DEFAULT 0);
    CREATE TABLE voice_exemplars(id TEXT PRIMARY KEY, profile_id INTEGER, note_id INTEGER, track TEXT);
    CREATE TABLE voice_enrollment_candidates(id TEXT PRIMARY KEY, profile_id INTEGER, note_id INTEGER, track TEXT);
    CREATE TABLE note_speaker_embeddings(note_id INTEGER, speaker_id TEXT, embedding BLOB);
    INSERT INTO notes VALUES(1, '{"text":"corrected","corrections":["kept"]}');
    INSERT INTO speaker_profiles VALUES(7, x'01020304', 1, 0);
    INSERT INTO voice_exemplars VALUES('sample-1', 7, 1, 'mic');`);
  t.after(() => db.close());
  const makeStore = () => new MeetingAudioStore(root, { database: { db }, now: () => clock, encryption });
  return { root, db, makeStore, setClock: (value) => { clock = value; }, clock };
}

function signal(seconds, frequency) {
  const pcm = Buffer.alloc(seconds * RATE * 2);
  for (let i = 0; i < seconds * RATE; i++) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / RATE)), i * 2);
  }
  return pcm;
}

function correlation(actual, expected) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < actual.length; i += 48) {
    const a = actual.readInt16LE(i), b = expected.readInt16LE(i);
    dot += a * b; aa += a * a; bb += b * b;
  }
  return dot / Math.sqrt(aa * bb);
}

test("interrupt, repair encrypted tracks, retrieve two arbitrary exact-duration spans", (t) => {
  const f = fixture(t);
  const mic = signal(23, 440);
  const system = signal(23, 660);
  let store = f.makeStore();
  store.begin(1);
  for (let offset = 0; offset < mic.length; offset += RATE * 2) {
    store.append(1, "mic", mic.subarray(offset, offset + RATE * 2));
    store.append(1, "system", system.subarray(offset, offset + RATE * 2));
  }
  // Simulate process death: no finish, then a new store scans real chunk files.
  store = f.makeStore();
  assert.equal(store.status(1).state, "incomplete");
  assert.equal(store.status(1).tracks.mic.chunks.length, 4);
  assert.equal(store.status(1).tracks.system.chunks.length, 4);
  // A crash after a ciphertext write but before manifest rename is recovered
  // from the encrypted packet's sample cursor, without re-encoding.
  const pathToManifest = path.join(f.root, "1", "manifest.json");
  const beforeRepair = JSON.parse(fs.readFileSync(pathToManifest, "utf8"));
  beforeRepair.tracks.mic.chunks.pop();
  fs.writeFileSync(pathToManifest, JSON.stringify(beforeRepair));
  store = f.makeStore();
  assert.equal(store.status(1).tracks.mic.chunks.length, 4);
  for (const file of fs.readdirSync(path.join(f.root, "1"))) {
    assert.ok(!file.endsWith(".wav") && !file.endsWith(".pcm"));
    if (file.endsWith(".owac")) {
      const bytes = fs.readFileSync(path.join(f.root, "1", file));
      assert.ok(!bytes.includes(mic.subarray(0, 48)));
      assert.ok(!bytes.includes(system.subarray(0, 48)));
      assert.ok(!bytes.includes(Buffer.from("OggS")));
    }
  }
  for (const [track, from, to] of [["mic", 12.4, 19.1], ["system", 3.1, 5.6]]) {
    const result = store.span(1, track, from, to);
    assert.equal(result.state, "available");
    assert.equal(result.wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(result.wav.readUInt32LE(40), result.wav.length - 44);
    assert.equal(result.wav.length - 44, (Math.round(to * RATE) - Math.round(from * RATE)) * 2);
    const source = track === "mic" ? mic : system;
    const expected = source.subarray(Math.round(from * RATE) * 2, Math.round(to * RATE) * 2);
    assert.ok(correlation(result.wav.subarray(44), expected) > 0.95);
    assert.ok(result.wav.length > 44);
  }
  assert.equal(store.span(1, "mic", 22, 23).state, "unavailable"); // last 3s were unflushed
  store.begin(1, f.clock + 20000);
  store.append(1, "mic", mic.subarray(20 * RATE * 2), f.clock + 20000);
  store.finish(1);
  const tail = store.span(1, "mic", 20, 23);
  assert.equal(tail.state, "available");
  assert.equal(tail.wav.length - 44, 3 * RATE * 2);
});

test("expiry and explicit deletion remove audio and derived voice, retain corrected transcript", (t) => {
  const f = fixture(t);
  const store = f.makeStore();
  store.begin(1);
  store.append(1, "mic", signal(6, 440));
  store.finish(1);
  const size = store.status(1).bytes;
  assert.ok(size > 0);
  const deleted = store.delete(1);
  assert.equal(deleted.freedBytes, size);
  assert.equal(store.span(1, "mic", 0, 1).state, "deleted");
  assert.deepEqual(fs.readdirSync(path.join(f.root, "1")), ["manifest.json"]);
  assert.match(f.db.prepare("SELECT transcript FROM notes WHERE id=1").get().transcript, /corrected/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM voice_exemplars").get().n, 0);
  assert.equal(f.db.prepare("SELECT voice_needs_reapproval FROM speaker_profiles WHERE id=7").get().voice_needs_reapproval, 1);
  store.begin(2);
  store.append(2, "system", signal(6, 660));
  store.finish(2);
  f.db.exec(`INSERT INTO notes VALUES(2, 'second transcript');
    INSERT INTO speaker_profiles VALUES(8, x'01020304', 1, 0);
    INSERT INTO voice_exemplars VALUES('sample-2', 8, 2, 'system');
    INSERT INTO voice_enrollment_candidates VALUES('candidate-2', 8, 2, 'system');`);
  f.setClock(f.clock + 4 * 86400000);
  const expired = store.enforce();
  assert.equal(expired.removed[0].noteId, 2);
  assert.equal(store.span(2, "system", 0, 1).state, "expired");
  assert.deepEqual(fs.readdirSync(path.join(f.root, "2")), ["manifest.json"]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM voice_enrollment_candidates WHERE note_id=2").get().n, 0);
  assert.equal(f.db.prepare("SELECT voice_needs_reapproval FROM speaker_profiles WHERE id=8").get().voice_needs_reapproval, 1);
  assert.equal(f.db.prepare("SELECT transcript FROM notes WHERE id=2").get().transcript, "second transcript");
});

test("budget evicts the oldest recording and keep only exempts age expiry", (t) => {
  const f = fixture(t);
  const store = f.makeStore();
  store.begin(1);
  store.append(1, "mic", signal(6, 440));
  store.finish(1);
  const firstSize = store.status(1).bytes;
  f.setClock(f.clock + 1000);
  store.begin(2);
  store.append(2, "mic", signal(6, 660));
  store.finish(2);
  store.setKeep(1, true);
  const secondSize = store.status(2).bytes;
  assert.ok(firstSize + secondSize < 1024 * 1024);
  // The public policy has a 1 MiB minimum, so create enough meetings to hit it.
  for (let noteId = 3; noteId <= 15; noteId++) {
    f.setClock(f.clock + 1000);
    store.begin(noteId);
    store.append(noteId, "mic", signal(25, 440 + noteId * 30));
    store.finish(noteId);
  }
  store.setPolicy({ days: 3, budgetBytes: 1024 * 1024 });
  assert.ok(store.usage().usedBytes <= 1024 * 1024);
  assert.ok(store.usage().evictions.length > 0);
  assert.equal(store.status(1).state, "evicted");
});

test("missing encryption key fails closed without a plaintext file", (t) => {
  const f = fixture(t);
  const store = new MeetingAudioStore(f.root, { encryption: {
    encryptBytes() { throw new Error("Audio encryption key is unavailable in the OS credential store"); },
    decryptBytes() { throw new Error("Audio encryption key is unavailable in the OS credential store"); },
  } });
  assert.throws(() => store.begin(3), /key is unavailable/);
  assert.equal(fs.existsSync(path.join(f.root, "3")), false);
});

test("a replaced key leaves existing ciphertext and its manifest intact", (t) => {
  const f = fixture(t);
  const first = f.makeStore();
  first.begin(1);
  first.append(1, "mic", signal(6, 440));
  first.finish(1);
  const file = path.join(f.root, "1", first.status(1).tracks.mic.chunks[0].file);
  const before = fs.readFileSync(file);
  const manifestBefore = fs.readFileSync(path.join(f.root, "1", "manifest.json"));
  const wrongKey = {
    encryptBytes(bytes) { return Buffer.from(bytes); },
    decryptBytes() { throw new Error("Authentication failed"); },
  };
  const reopened = new MeetingAudioStore(f.root, { encryption: wrongKey, now: () => f.clock });
  assert.equal(reopened.status(1).state, "key_unavailable");
  assert.throws(() => reopened.begin(1), /key is unavailable/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "1", "manifest.json")), manifestBefore);
});
