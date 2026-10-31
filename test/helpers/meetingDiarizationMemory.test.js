const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const DiarizationManager = require("../../src/helpers/diarization");

test("meeting PCM converts in memory and reaches diarization through a secure FIFO", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX descriptor path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-diarize-pipe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mock = path.join(root, "diarizer");
  fs.writeFileSync(mock, `#!/usr/bin/env node
const fs = require('fs');
const fd = fs.openSync(process.argv.at(-1), 'r');
function read(length) { const out = Buffer.alloc(length); let offset = 0;
  while (offset < length) offset += fs.readSync(fd, out, offset, length - offset, null);
  return out; }
const header = read(44);
const input = Buffer.concat([header, read(header.readUInt32LE(40))]);
fs.closeSync(fd);
if (input.subarray(0, 4).toString() !== 'RIFF' || input.readUInt32LE(40) !== input.length - 44) process.exit(2);
process.stdout.write('0 -- 1 speaker_0\\n');
`, { mode: 0o700 });
  const manager = new DiarizationManager();
  manager.getBinaryPath = () => mock;
  manager.isModelDownloaded = () => true;
  manager._resolveModelPath = () => mock;
  const pcm = Buffer.alloc(24000 * 2 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 10)), i * 2);
  const wav = await manager.convertRawPcmToWavBuffer(pcm, 24000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.deepEqual(await manager.diarize(wav, { pipeRoot: root }), [{ start: 0, end: 1, speaker: "speaker_0" }]);
  assert.deepEqual(fs.readdirSync(root), ["diarizer"]);
});
