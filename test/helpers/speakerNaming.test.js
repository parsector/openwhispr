const test = require("node:test");
const assert = require("node:assert/strict");
const { setSpeakerNameMapping } = require("../../src/helpers/speakerNaming");

test("naming a speaker only writes a mapping, never a profile embedding", () => {
  const writes = [];
  const database = {
    setSpeakerMapping: (...args) => writes.push(["mapping", ...args]),
    upsertSpeakerProfile: () => {
      throw new Error("naming enrolled a voice");
    },
  };
  const live = { mapSpeaker: (...args) => writes.push(["live", ...args]) };
  setSpeakerNameMapping(database, live, {
    noteId: 7,
    speakerId: "speaker_2",
    displayName: "Alice",
    profileId: 5,
  });
  assert.deepEqual(writes, [
    ["mapping", 7, "speaker_2", 5, "Alice"],
    ["live", "speaker_2", 5, "Alice", 7],
  ]);
});

test("naming reuses an existing contact by email without changing its voice", () => {
  const writes = [];
  const database = {
    getSpeakerProfiles: () => [
      { id: 9, display_name: "Alice", email: "alice@example.com", embedding: Buffer.from([1]) },
    ],
    setSpeakerMapping: (...args) => writes.push(args),
    upsertSpeakerProfile: () => assert.fail("an embedding write was attempted"),
  };
  const live = { mapSpeaker() {} };
  const id = setSpeakerNameMapping(database, live, {
    noteId: 7,
    speakerId: "speaker_2",
    displayName: "Alice",
    email: "ALICE@example.com",
  });
  assert.equal(id, 9);
  assert.deepEqual(writes, [[7, "speaker_2", 9, "Alice"]]);
});
