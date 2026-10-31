const { deflateSync, inflateSync } = require("node:zlib");

// Retained-audio tests exercise the store without requiring an installed
// ffmpeg/libopus binary. Compression keeps budget tests representative.
module.exports = {
  encode(pcm) {
    const compressed = deflateSync(pcm);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(compressed.length);
    // Approximate the 32 kb/s store budget so eviction tests still exercise
    // the production retention policy with realistic ciphertext sizes.
    return Buffer.concat([length, compressed, Buffer.alloc(Math.ceil(pcm.length / 12))]);
  },
  decode(bytes) {
    return inflateSync(bytes.subarray(4, 4 + bytes.readUInt32LE(0)));
  },
};
