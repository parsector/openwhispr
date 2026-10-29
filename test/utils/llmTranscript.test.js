const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/llmTranscript.ts");

const t = (key, options) => {
  if (key === "notes.speaker.unknownNumber") return `Unknown speaker ${options.n}`;
  if (key === "notes.speaker.you") return "You";
  return key;
};

const attendee = (email, displayName, self = false) => ({
  email,
  displayName,
  responseStatus: null,
  self,
});

test("mic source alone does not name the note owner", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  assert.equal(
    resolveLlmSpeakerLabel({ source: "mic", text: "hi" }, {}, "Gabriel Stein", t),
    "Unknown speaker 1"
  );
  assert.equal(
    resolveLlmSpeakerLabel(
      { source: "system", speaker: "you", text: "hi" },
      {},
      "Gabriel Stein",
      t
    ),
    "Gabriel Stein"
  );
});

test("manual speaker corrections override the microphone's assumed note owner", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  for (const speaker of ["speaker_0", "you"]) {
    const segment = {
      source: "mic",
      speaker,
      speakerName: "Ravi Patel",
      speakerLocked: true,
      speakerStatus: "locked",
      speakerLockSource: "user",
      speakerIsPlaceholder: false,
      text: "I will send the proposal.",
    };
    assert.equal(
      resolveLlmSpeakerLabel(segment, { [speaker]: "Old name" }, "Casey", t),
      "Ravi Patel"
    );
  }
  assert.equal(
    resolveLlmSpeakerLabel({ source: "mic", speaker: "speaker_0", speakerLocked: true,
      speakerLockSource: "user", unknownNumber: 7, text: "hi" },
    { speaker_0: "Old name" }, "Casey", t),
    "Unknown speaker 7"
  );
});

test("a renamed microphone cluster reaches note generation without per-segment names", async () => {
  const { buildLlmTranscript } = await load();
  const segment = {
    source: "mic",
    speaker: "speaker_0",
    timestamp: 123,
    speakerStatus: "confirmed",
    speakerIsPlaceholder: false,
    speakerLocked: false,
    text: "I will send the proposal.",
  };
  assert.equal(
    buildLlmTranscript([segment], { speaker_0: "Ravi Patel" }, "Casey", t),
    "Ravi Patel: I will send the proposal."
  );
  assert.equal(
    buildLlmTranscript([segment], {}, "Casey", t),
    "Unknown speaker 1: I will send the proposal."
  );
  assert.equal(
    buildLlmTranscript([segment], { speaker_0: " you " }, "Casey", t),
    "Casey: I will send the proposal."
  );
});

test("an in-person meeting's diarized mic clusters keep their speaker numbers", async () => {
  const { buildLlmTranscript, resolveLlmSpeakerLabel } = await load();
  const segments = [
    { id: "a", source: "mic", speaker: "speaker_0", speakerName: "Speaker 1",
      speakerIsPlaceholder: true, text: "Can you send the proposal?" },
    { id: "b", source: "mic", speaker: "speaker_1", uncertainty: { reason: "close_match" }, text: "I will send it today." },
    { id: "c", source: "mic", speaker: "you", text: "Thanks." },
    { id: "d", source: "mic", text: "Before diarization." },
  ];
  assert.equal(
    buildLlmTranscript(segments, {}, "Casey", t),
    [
      "Unknown speaker 1: Can you send the proposal?",
      "Unknown speaker 2: I will send it today.",
      "Casey: Thanks.",
      "Unknown speaker 4: Before diarization.",
    ].join("\n")
  );
  assert.equal(
    resolveLlmSpeakerLabel(segments[1], { speaker_1: "Ravi Patel" }, "Casey", t),
    "Ravi Patel"
  );
});

test("system segments resolve name → mapping → numbered unknown", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  const locked = {
    source: "system",
    speaker: "speaker_0",
    speakerName: "Michael",
    speakerLocked: true,
    text: "hi",
  };
  assert.equal(resolveLlmSpeakerLabel(locked, { speaker_0: "Wrong" }, "You", t), "Michael");
  assert.equal(resolveLlmSpeakerLabel({ source: "system", speaker: "Alex", text: "hi" }, {}, "You", t), "Alex");
  assert.equal(
    resolveLlmSpeakerLabel(
      { source: "system", speaker: "speaker_1", text: "hi" },
      { speaker_1: "Sean" },
      "You",
      t
    ),
    "Sean"
  );
  assert.equal(
    resolveLlmSpeakerLabel({ source: "system", speaker: "speaker_2", text: "hi" }, {}, "You", t),
    "Unknown speaker 3"
  );
  assert.equal(resolveLlmSpeakerLabel({ source: "system", text: "hi" }, {}, "You", t), "Unknown speaker 1");
});

test("buildLlmTranscript prefixes every line with the resolved label", async () => {
  const { buildLlmTranscript } = await load();
  const segments = [
    { source: "mic", text: "Morning everyone" },
    { source: "system", speaker: "speaker_0", text: "Morning" },
  ];
  assert.equal(
    buildLlmTranscript(segments, { speaker_0: "Michael" }, "Gabriel", t),
    "Unknown speaker 1: Morning everyone\nMichael: Morning"
  );
});

test("speakerless rows stay unprefixed and do not consume a note's unknown numbers", async () => {
  const { buildLlmTranscript } = await load();
  assert.equal(
    buildLlmTranscript([
      { id: "plain", text: "Plain dictation." },
      { id: "voice", source: "mic", text: "Meeting voice.", unknownNumberHighWater: 4 },
    ], {}, "Casey", t),
    "Plain dictation.\nUnknown speaker 5: Meeting voice."
  );
});

test("source-only and placeholder-named rows each receive stable per-note numbers", async () => {
  const { buildLlmTranscript } = await load();
  assert.equal(
    buildLlmTranscript([
      { source: "mic", text: "First." },
      { text: "Metadata." },
      { source: "system", text: "Second." },
      { speakerName: "Speaker", speakerIsPlaceholder: true, text: "Third." },
    ], {}, "Casey", t),
    "Unknown speaker 1: First.\nMetadata.\nUnknown speaker 2: Second.\nUnknown speaker 3: Third."
  );
});

test("buildMeetingContext names the owner and invited participants", async () => {
  const { buildMeetingContext } = await load();
  const identity = {
    selfName: "Gabriel Stein",
    selfEmail: "gabe@openwhispr.com",
    participants: [
      attendee("gabe@openwhispr.com", "Gabriel Stein", true),
      attendee("michael@acme.com", "Michael Chen"),
      attendee("sean@acme.com", null),
    ],
  };
  assert.equal(
    buildMeetingContext(identity, "Gabriel Stein"),
    [
      "## Meeting Context",
      'The user taking these notes ("Gabriel Stein" in the transcript) is Gabriel Stein <gabe@openwhispr.com>.',
      "Invited participants: Michael Chen <michael@acme.com>, sean@acme.com.",
    ].join("\n")
  );
  assert.equal(
    buildMeetingContext(identity, "Gabriel Stein", false),
    "## Meeting Context\nThe user taking these notes is Gabriel Stein <gabe@openwhispr.com>.\nInvited participants: Michael Chen <michael@acme.com>, sean@acme.com."
  );
});

test("buildMeetingContext omits what it does not know", async () => {
  const { buildMeetingContext } = await load();
  assert.equal(
    buildMeetingContext({ selfName: null, selfEmail: null, participants: [] }, "You"),
    ""
  );
  assert.equal(
    buildMeetingContext(
      { selfName: null, selfEmail: null, participants: [attendee("a@b.com", "Ada")] },
      "You"
    ),
    "## Meeting Context\nInvited participants: Ada <a@b.com>."
  );
});

test("collectKnownPeople merges owner, participants, mappings, and named segments", async () => {
  const { collectKnownPeople } = await load();
  const people = collectKnownPeople(
    {
      selfName: "Gabriel Stein",
      selfEmail: "gabe@openwhispr.com",
      participants: [
        attendee("gabe@openwhispr.com", "Gabriel Stein", true),
        attendee("michael@acme.com", "Michael Chen"),
        attendee("sean@acme.com", null),
      ],
    },
    { speaker_0: "Michael Chen", speaker_1: "Priya" },
    [
      { source: "system", speaker: "speaker_2", speakerName: "Ada", text: "hi" },
      { source: "mic", speaker: "speaker_3", speakerName: "Speaker 4",
        speakerIsPlaceholder: true, text: "hello" },
    ]
  );
  assert.deepEqual(people, [
    { name: "Gabriel Stein", email: "gabe@openwhispr.com" },
    { name: "Michael Chen", email: "michael@acme.com" },
    { name: "sean", email: "sean@acme.com" },
    { name: "Priya", email: null },
    { name: "Ada", email: null },
  ]);
});

test("collectKnownPeople keeps same-name attendees with different email identities", async () => {
  const { collectKnownPeople } = await load();
  const participants = [
    attendee("alex.design@example.test", "Alex Morgan"),
    attendee("alex.engineering@example.test", "Alex Morgan"),
    attendee("ALEX.DESIGN@example.test", "Alex Morgan"),
  ];
  const people = collectKnownPeople(
    { selfName: "Casey", selfEmail: "casey@example.test", participants },
    { speaker_0: "Alex Morgan" },
    [{ source: "system", speakerName: "Alex Morgan", text: "I will send the proposal." }]
  );
  assert.deepEqual(people, [
    { name: "Casey", email: "casey@example.test" },
    { name: "Alex Morgan", email: "alex.design@example.test" },
    { name: "Alex Morgan", email: "alex.engineering@example.test" },
  ]);
});

test("first-name owners resolve to a unique attendee while explicit short labels retain their identity", async () => {
  const { collectKnownPeople } = await load();
  const { tagActionItemOwners } = await import("../../src/utils/mentionMarkdown.ts");
  const identity = {
    selfName: null,
    selfEmail: null,
    participants: [attendee("ravi@example.test", "Ravi Patel")],
  };
  const line = "- [ ] Send the proposal — Ravi";
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: "Ravi Patel" }, [])),
    "- [ ] Send the proposal — [@Ravi Patel](mention:ravi%40example.test)"
  );
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: " Ravi  Patel " }, [])),
    "- [ ] Send the proposal — [@Ravi Patel](mention:ravi%40example.test)"
  );
  // A name-only label is not evidence that it belongs to the similarly named invitee.
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: "Ravi" }, [])),
    "- [ ] Send the proposal — [@Ravi](mention:Ravi)"
  );
});

test("an owner without an email stays distinct from a same-name invitee", async () => {
  const { collectKnownPeople } = await load();
  const { tagActionItemOwners } = await import("../../src/utils/mentionMarkdown.ts");
  const people = collectKnownPeople(
    {
      selfName: "Alex Morgan",
      selfEmail: null,
      participants: [attendee("alex.other@example.test", "Alex Morgan")],
    },
    {},
    []
  );
  assert.deepEqual(people, [
    { name: "Alex Morgan", email: null },
    { name: "Alex Morgan", email: "alex.other@example.test" },
  ]);
  const line = "- [ ] Send the proposal — Alex Morgan";
  assert.equal(tagActionItemOwners(line, people), line);
});

test("a You saved in another UI language still labels the note owner", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  const german = (key, options) => (key === "notes.speaker.you" ? "Du" : t(key, options));
  const segment = { source: "mic", speaker: "speaker_0", text: "hi" };
  assert.equal(resolveLlmSpeakerLabel(segment, { speaker_0: "You" }, "Casey", german), "Casey");
  assert.equal(resolveLlmSpeakerLabel(segment, { speaker_0: "Du" }, "Casey", german), "Casey");
});
