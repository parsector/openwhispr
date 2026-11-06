const path = require('node:path');
const { MeetingAudioStore, RATE } = require('../../src/helpers/meetingAudioStore');
const encryption = require('./fakeAudioEncryption');
const codec = require('./fakeAudioCodec');

// Exercise approval with encrypted source audio, canonical span lengths and
// recording UUIDs from real manifests, just as the application supplies them.
module.exports = function retainedSpeakerAudio(database, root, now) {
  const audio = new MeetingAudioStore(path.join(root, 'recordings'), {
    database, now, encryption, codec,
  });
  audio.cancelRecovery();
  return {
    audio,
    record(noteId, count) {
      const pcm = Buffer.alloc(RATE * 2 * count * 5);
      for (let i = 0; i < pcm.length / 2; i++)
        pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i * 2);
      const { recordingId } = audio.begin(noteId);
      audio.append(noteId, 'system', pcm);
      audio.finish(noteId);
      return recordingId;
    },
  };
};
