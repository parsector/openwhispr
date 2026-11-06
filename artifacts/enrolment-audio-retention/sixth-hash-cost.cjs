const { performance } = require("node:perf_hooks");
const { pcmIdentity } = require("../../src/helpers/voiceRecordingIdentity");
for (const seconds of [4, 120]) {
  const wav = Buffer.alloc(44 + seconds * 48000, 37);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 5; i++) pcmIdentity(wav);
  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) pcmIdentity(wav);
  console.log(
    JSON.stringify({
      seconds,
      pcmBytes: wav.length - 44,
      iterations,
      averageMs: Number(((performance.now() - start) / iterations).toFixed(4)),
    })
  );
}
