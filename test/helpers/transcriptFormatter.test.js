const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatTxt,
  formatSrt,
  formatJson,
  formatMd,
} = require("../../src/helpers/transcriptFormatter");
const { changeLanguage } = require("../../src/helpers/i18nMain");

test("TXT and Markdown exports include participant display names", () => {
  const note = {
    title: "Planning",
    created_at: "2026-01-01T00:00:00Z",
    participants: JSON.stringify([
      { displayName: "Ada Lovelace", email: "ada@example.com" },
      { displayName: "Grace Hopper", email: "grace@example.com" },
    ]),
  };

  assert.match(formatTxt(note, [], {}), /Participants: Ada Lovelace, Grace Hopper/);
  assert.match(formatMd(note, [], {}), /\*\*Participants:\*\* Ada Lovelace, Grace Hopper/);
});

test("participants without a display name fall back to their email", () => {
  const note = {
    title: "Planning",
    created_at: "2026-01-01T00:00:00Z",
    participants: JSON.stringify([
      { displayName: null, email: "guest@example.com" },
      { displayName: "Ada Lovelace", email: "ada@example.com" },
    ]),
  };

  assert.match(formatTxt(note, [], {}), /Participants: guest@example.com, Ada Lovelace/);
});

test("merged same-speaker SRT cues keep the first segment's start time", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0.25, text: "Opening sentence." },
      { speaker: "speaker_0", timestamp: 1.75, text: "Continuation." },
      { speaker: "speaker_1", timestamp: 4, text: "Reply." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,250 --> 00:00:04,000\n/);
});

test("same-speaker merging still uses the latest segment for the rolling gap", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
      { speaker: "speaker_1", timestamp: 6, text: "Reply." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:06,000\nUnknown speaker 1: One\. Two\. Three\./);
});

test("same-speaker segments at the merge threshold remain separate cues", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "First." },
      { speaker: "speaker_0", timestamp: 2, text: "Second." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:02,000\nUnknown speaker 1: First\./);
  assert.match(output, /\n2\n00:00:02,000 --> 00:00:05,000\nUnknown speaker 1: Second\./);
});

test("the final merged SRT cue ends relative to its last segment, not its first", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:06,000\nUnknown speaker 1: One\. Two\. Three\./);
});

test("SRT timestamps roll sub-second rounding into the next second", () => {
  const output = formatSrt(
    [{ speaker: "speaker_0", timestamp: 0.9995, text: "Near boundary." }],
    {}
  );

  assert.match(output, /^1\n00:00:01,000 --> 00:00:04,000\nUnknown speaker 1: Near boundary\./);
});

test("every cue in a multi-cue SRT rolls its own sub-second rounding", () => {
  const output = formatSrt(
    [
      { speaker: "speaker_0", timestamp: 0.9995, text: "Opening." },
      { speaker: "speaker_1", timestamp: 1.9995, text: "Reply." },
    ],
    {}
  );

  assert.doesNotMatch(output, /,\d{4}/);
  assert.match(output, /^1\n00:00:01,000 --> 00:00:02,000\nUnknown speaker 1: Opening\./);
  assert.match(output, /\n2\n00:00:02,000 --> 00:00:05,000\nUnknown speaker 2: Reply\./);
});

test("JSON duration reflects the last merged segment's timestamp", () => {
  const output = formatJson(
    { title: "Note", created_at: "2026-01-01T00:00:00Z" },
    [
      { speaker: "speaker_0", timestamp: 0, text: "One." },
      { speaker: "speaker_0", timestamp: 1.5, text: "Two." },
      { speaker: "speaker_0", timestamp: 3, text: "Three." },
    ],
    {}
  );

  assert.equal(JSON.parse(output).metadata.duration_seconds, 3);
});

test("consecutive speaker-less segments within 2s merge across SRT, TXT and Markdown exports", () => {
  const segments = [
    { timestamp: 0, text: "Hello world," },
    { timestamp: 1, text: "this is a test." },
    { timestamp: 5, text: "Later sentence." },
  ];

  // SRT cues from a fully speaker-less transcript (a timestamped upload)
  // carry bare text — a speaker prefix on every subtitle would
  // defeat the format's purpose.
  const srtOutput = formatSrt(segments, {});
  assert.match(srtOutput, /^1\n00:00:00,000 --> 00:00:05,000\nHello world, this is a test\./);
  assert.match(srtOutput, /\n2\n00:00:05,000 --> 00:00:08,000\nLater sentence\./);
  assert.doesNotMatch(srtOutput, /Unknown speaker/);

  const txtOutput = formatTxt(
    { title: "Test Note", created_at: "2026-01-01T00:00:00Z" },
    segments,
    {}
  );
  assert.ok(txtOutput.includes("[00:00:00]\nHello world, this is a test."));
  assert.ok(txtOutput.includes("[00:00:05]\nLater sentence."));

  const mdOutput = formatMd(
    { title: "Test Note", created_at: "2026-01-01T00:00:00Z" },
    segments,
    {}
  );
  assert.ok(mdOutput.includes("`00:00:00`\nHello world, this is a test."));
  assert.ok(mdOutput.includes("`00:00:05`\nLater sentence."));
});

test("a single segment with speaker identity keeps the prefix on every SRT cue", () => {
  const output = formatSrt(
    [
      { timestamp: 0, text: "No identity here." },
      { speakerName: "Ada", timestamp: 5, text: "Named reply." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:05,000\nNo identity here\./);
  assert.match(output, /\n2\n00:00:05,000 --> 00:00:08,000\nAda: Named reply\./);
});

test("mic source alone does not name the owner in SRT", () => {
  const output = formatSrt(
    [
      { source: "mic", timestamp: 0, text: "Me talking." },
      { source: "system", timestamp: 5, text: "Them talking." },
    ],
    {}
  );

  assert.match(output, /^1\n00:00:00,000 --> 00:00:05,000\nUnknown speaker 1: Me talking\./);
  assert.match(output, /\n2\n00:00:05,000 --> 00:00:08,000\nUnknown speaker 2: Them talking\./);
});

test("a manually named segment does not absorb the adjacent un-named one", () => {
  const segments = [
    {
      source: "mic",
      timestamp: 0,
      text: "Alice said this.",
      speakerName: "Alice",
      speakerIsPlaceholder: false,
    },
    { source: "mic", timestamp: 1, text: "And this is me talking." },
  ];

  const txtOutput = formatTxt(
    { title: "Test Note", created_at: "2026-01-01T00:00:00Z" },
    segments,
    {}
  );

  assert.ok(txtOutput.includes("[00:00:00] Alice:\nAlice said this."));
  assert.ok(txtOutput.includes("[00:00:01] Unknown speaker 2:\nAnd this is me talking."));
});

test("only an explicit legacy you id names the owner", (t) => {
  changeLanguage("de");
  t.after(() => changeLanguage("en"));

  const note = { title: "Standup", created_at: "2026-01-01T00:00:00Z" };
  const segments = [
    { source: "mic", speaker: "you", timestamp: 0, text: "Guten Morgen." },
    { source: "mic", timestamp: 3, text: "Noch etwas." },
    { source: "system", speaker: "speaker_0", timestamp: 8, text: "Hallo." },
  ];

  const txtOutput = formatTxt(note, segments, {});
  assert.ok(txtOutput.includes("[00:00:00] Du:\nGuten Morgen."));
  assert.ok(txtOutput.includes("[00:00:03] Unbekannte Person 2:\nNoch etwas."));
  assert.ok(!txtOutput.includes("You:"));
});

test("the JSON export keeps unassigned mic rows separate from the owner", (t) => {
  changeLanguage("de");
  t.after(() => changeLanguage("en"));

  const parsed = JSON.parse(
    formatJson(
      { title: "Standup", created_at: "2026-01-01T00:00:00Z" },
      [
        { source: "mic", speaker: "you", timestamp: 0, text: "Guten Morgen." },
        { source: "mic", timestamp: 3, text: "Noch etwas." },
        { source: "system", speaker: "speaker_0", timestamp: 8, text: "Hallo." },
      ],
      {}
    )
  );

  assert.deepEqual(parsed.speakers, ["Du", "Unbekannte Person 2", "Unbekannte Person 3"]);
  assert.equal(parsed.metadata.speaker_count, 3);
});

test("diarized speaker numbers render in the UI language", (t) => {
  changeLanguage("de");
  t.after(() => changeLanguage("en"));

  const txtOutput = formatTxt(
    { title: "Standup", created_at: "2026-01-01T00:00:00Z" },
    [{ source: "system", speaker: "speaker_0", timestamp: 0, text: "Hallo." }],
    {}
  );

  assert.ok(txtOutput.includes("[00:00:00] Unbekannte Person 1:\nHallo."));
  assert.ok(!txtOutput.includes("Unknown speaker 1"));
});

test("a user-pinned unknown prints the same numbered placeholder in plain and Markdown exports", () => {
  const note = { title: "Standup", created_at: "2026-01-01T00:00:00Z" };
  const rows = [{ id: "pinned", source: "system", speaker: "speaker_mic",
    speakerName: "Speaker 1", speakerIsPlaceholder: true,
    speakerLocked: true, speakerLockSource: "user", unknownNumber: 7,
    timestamp: 0, text: "Unidentified voice." }];
  const mappings = { speaker_mic: "Wrong name" };
  for (const output of [formatTxt(note, rows, mappings), formatMd(note, rows, mappings)]) {
    assert.ok(output.includes("Unknown speaker 7"));
    assert.ok(!output.includes("Wrong name"));
  }
});

test("a legacy speaker stored as a name remains named in plain and Markdown exports", () => {
  const note = { title: "Standup", created_at: "2026-01-01T00:00:00Z" };
  const rows = [{ id: "legacy", speaker: "Alex", timestamp: 0, text: "I will send the poll." }];
  for (const output of [formatTxt(note, rows, {}), formatMd(note, rows, {})]) {
    assert.ok(output.includes("Alex"));
    assert.ok(!output.includes("Unknown speaker"));
  }
});

test("segments with no speaker information have no label in localized exports", (t) => {
  changeLanguage("de");
  t.after(() => changeLanguage("en"));

  const txtOutput = formatTxt(
    { title: "Standup", created_at: "2026-01-01T00:00:00Z" },
    [{ timestamp: 0, text: "Hallo." }],
    {}
  );

  assert.ok(txtOutput.includes("[00:00:00]\nHallo."));
  assert.ok(!txtOutput.includes("Unknown speaker"));
});

test("speakerless rows do not consume export numbers and a note's high-water mark is respected", () => {
  const rows = [
    { id: "plain", timestamp: 0, text: "Metadata." },
    { id: "voice", source: "mic", unknownNumberHighWater: 6, timestamp: 2, text: "Hello." },
  ];
  const note = { title: "Meeting", created_at: "2026-01-01T00:00:00Z" };
  const txt = formatTxt(note, rows, {});
  const md = formatMd(note, rows, {});
  const srt = formatSrt(rows, {});
  const json = JSON.parse(formatJson(note, rows, {}));
  assert.match(txt, /\[00:00:00\]\nMetadata\./);
  assert.match(txt, /\[00:00:02\] Unknown speaker 7:\nHello\./);
  assert.match(md, /`00:00:00`\nMetadata\./);
  assert.match(md, /\*\*Unknown speaker 7\*\* `00:00:02`/);
  assert.match(srt, /00:00:02,000\nMetadata\./);
  assert.match(srt, /Unknown speaker 7: Hello\./);
  assert.deepEqual(json.speakers, ["Unknown speaker 7"]);
  assert.equal(json.segments[0].speaker, null);
});

test("a placeholder-named row without a channel uses the numbered label in every export", () => {
  const rows = [{ speakerName: "Speaker", speakerIsPlaceholder: true, text: "Hello.", timestamp: 0 }];
  const note = { title: "Meeting", created_at: "2026-01-01T00:00:00Z" };
  assert.match(formatTxt(note, rows, {}), /Unknown speaker 1:\nHello\./);
  assert.match(formatMd(note, rows, {}), /\*\*Unknown speaker 1\*\*/);
  assert.match(formatSrt(rows, {}), /Unknown speaker 1: Hello\./);
});

test("an explicit speaker mapping still overrides the own-voice label", () => {
  const txtOutput = formatTxt(
    { title: "Standup", created_at: "2026-01-01T00:00:00Z" },
    [{ source: "mic", speaker: "you", timestamp: 0, text: "Morning." }],
    { you: "Ada" }
  );

  assert.ok(txtOutput.includes("[00:00:00] Ada:\nMorning."));
});

test("epoch-millisecond segment timestamps export relative to the recording start", () => {
  const recordingStartMs = 1_754_310_000_000;
  const segments = [
    { speaker: "speaker_0", timestamp: recordingStartMs, text: "Opening." },
    { speaker: "speaker_1", timestamp: recordingStartMs + 477_000, text: "Closing." },
  ];
  const note = {
    title: "Meeting",
    created_at: "2026-08-04 13:02:00",
  };

  const mdOutput = formatMd(note, segments, {});
  assert.match(mdOutput, /`00:00:00`/);
  assert.match(mdOutput, /`00:07:57`/);
});

test("SQLite UTC note timestamps are parsed as UTC before local formatting", () => {
  const { parseNoteDate } = require("../../src/helpers/transcriptFormatter");
  const parsed = parseNoteDate("2026-08-04 13:02:00");

  assert.equal(parsed.toISOString(), "2026-08-04T13:02:00.000Z");
});

// An upload whose provider returned no segments stores its text untimed; a
// "[00:00:00] Unknown speaker" heading or a 3-second cue would be invented.
test("untimed upload text exports without invented times or speakers", () => {
  const note = {
    title: "Lecture",
    created_at: "2026-01-01T00:00:00Z",
    audio_duration_seconds: 125.4,
  };
  const segments = [{ text: "The whole lecture." }];

  const txt = formatTxt(note, segments, {});
  assert.ok(txt.endsWith("──────────────────────────────────\n\nThe whole lecture.\n"));
  assert.doesNotMatch(txt, /\[00:00:00\]/);

  const md = formatMd(note, segments, {});
  assert.ok(md.endsWith("---\n\nThe whole lecture.\n"));
  assert.doesNotMatch(md, /00:00:00|Unknown/);

  assert.equal(
    formatSrt(segments, {}, note),
    "1\n00:00:00,000 --> 00:02:05,400\nThe whole lecture.\n"
  );
  const json = JSON.parse(formatJson(note, segments, {}));
  assert.equal(json.metadata.duration_seconds, 125);
  assert.deepEqual(json.speakers, []);
  assert.equal(json.segments[0].speaker, null);
});

test('JSON export preserves durable transcript row identities', () => {
  const rows = [
    { id: 'row-a', source: 'system', speaker: 'speaker_0', timestamp: 0, text: 'One' },
    { id: 'row-b', source: 'system', speaker: 'speaker_0', timestamp: 1, text: 'Two' },
  ];
  const exported = JSON.parse(formatJson({ title: 'Meeting', created_at: '2026-01-01T00:00:00Z' }, rows, {}));
  assert.deepEqual(exported.transcriptRows.map((row) => row.id), ['row-a', 'row-b']);
});
