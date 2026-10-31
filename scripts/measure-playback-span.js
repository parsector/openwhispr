#!/usr/bin/env node
// Fixed labelled fixture. The before formula is copied from master
// MeetingTranscriptChat.tsx:1074-1075, including its 6 s lead and 2 s tail.
const { playbackRange } = require('../src/utils/meetingAudioPlayback.ts');
const aligned = [
  { id: 'a', source: 'system', timestamp: 1, text: 'hello there',
    wordTimings: [{ start: 1, end: 1.25 }, { start: 1.3, end: 1.6 }],
    audioSpan: { recordingId: 'meeting', trackId: 'system', startSample: 24000, endSample: 38400 } },
  { id: 'b', source: 'system', timestamp: 1.65, text: 'yes',
    wordTimings: [{ start: 1.65, end: 1.9 }],
    audioSpan: { recordingId: 'meeting', trackId: 'system', startSample: 39600, endSample: 45600 } },
];
const cases = [...aligned.map(row => [row, aligned, 'aligned']),
  [{ ...aligned[0], wordTimings: undefined, audioSpan: undefined }, aligned, 'unaligned']];
console.log('row mode label_ms next_start_ms before_ms after_ms');
for (const [row, rows, mode] of cases) {
  const precise = !!row.audioSpan && !!row.wordTimings?.length;
  const position = row.timestamp ?? row.audioSpan.startSample / 24000;
  const beforeFrom = Math.max(0, precise ? row.audioSpan.startSample / 24000 : position - 6);
  const beforeTo = precise ? row.audioSpan.endSample / 24000 : Math.max(beforeFrom + .25, position + 2);
  const after = playbackRange(row, rows, 'meeting');
  const labelled = aligned.find(candidate => candidate.id === row.id).audioSpan;
  console.log(`${row.id} ${mode} ${labelled.startSample / 24}-${labelled.endSample / 24} ${row.id === 'a' ? 1650 : 'none'} ${Math.round(beforeFrom * 1000)}-${Math.round(beforeTo * 1000)} ${Math.round(after.from * 1000)}-${Math.round(after.to * 1000)}`);
}
