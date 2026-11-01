// Whether live speaker identification can run for the meeting's capture mode.
//
// "native" (macOS Core Audio tap) and Windows "loopback" (WASAPI helper or
// renderer display-media fallback) all deliver 24 kHz mono s16le PCM through
// the same sendMeetingAudio("system") path, so the identifier works unchanged.
// Linux reports "loopback" too (PipeWire helper) and feeds the same stream;
// the identifier regroups buffers of any size for its resampler. Every mode also
// has a microphone path, including devices with unsupported system capture.
export function supportsLiveSpeakerIdentification(systemAudioMode, platform = process.platform) {
  // Mic capture is available even when this device cannot capture system audio.
  if (systemAudioMode === "unsupported") return true;
  if (systemAudioMode === "native") return true;
  return systemAudioMode === "loopback" && (platform === "win32" || platform === "linux");
}
