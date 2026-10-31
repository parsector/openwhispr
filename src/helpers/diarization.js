const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { runSystemTar } = require("./systemTar");
const { downloadFile, createDownloadSignal, checkDiskSpace } = require("./downloadUtils");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const { convertToWav } = require("./ffmpegUtils");
const { getFFmpegPath } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { applyConfirmedSpeaker } = require("./speakerAssignmentPolicy");
const { shortSpanReason } = require("./speakerUncertainty");
const { buildSpeakerRenumber } = require("./speakerIndexBase");
const sidecarPidFile = require("./sidecarPidFile");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  computeTranscriptionTimeoutMs,
  PCM16_MONO_16K_BYTES_PER_SECOND,
} = require("./transcriptionTimeout");

const DIARIZATION_TIMEOUT_MS = 3600000; // 60 minutes
// splitMicEchoDuplicates runs on timestamps already normalized to seconds from
// the start of the recording, so this window is in seconds too, though
// buildMergedCandidates calls it windowMs.
const ECHO_DUPLICATE_WINDOW_S = 6;
const ECHO_DUPLICATE_MERGE_LIMIT = 3;

const SEGMENTATION_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const EMBEDDING_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SILERO_VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

const SEGMENTATION_DIR = "sherpa-onnx-pyannote-segmentation-3-0";
const SEGMENTATION_ONNX = path.join(SEGMENTATION_DIR, "model.onnx");
const EMBEDDING_ONNX = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const SILERO_VAD_ONNX = "silero_vad.onnx";

class DiarizationManager {
  constructor() {
    // Meeting post-processing and upload/batch diarization can overlap, so
    // track every live process, not a single slot.
    this._processes = new Set();
    this.currentDownloadProcess = null;
    this.cachedBinaryPath = null;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32"
        ? `sherpa-onnx-diarize-${platformArch}.exe`
        : `sherpa-onnx-diarize-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getBinaryPath() !== null && this.isModelDownloaded();
  }

  getModelsDir() {
    return getModelsDirForService("diarization");
  }

  getBundledModelsDir() {
    if (!process.resourcesPath) {
      return null;
    }

    return path.join(process.resourcesPath, "bin", "diarization-models");
  }

  _resolveModelPath(relativePath) {
    const bundledModelsDir = this.getBundledModelsDir();
    if (bundledModelsDir) {
      const bundledPath = path.join(bundledModelsDir, relativePath);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(this.getModelsDir(), relativePath);
  }

  isModelDownloaded() {
    const segPath = this._resolveModelPath(SEGMENTATION_ONNX);
    const embPath = this._resolveModelPath(EMBEDDING_ONNX);
    return fs.existsSync(segPath) && fs.existsSync(embPath);
  }

  getVadModelPath() {
    return this._resolveModelPath(SILERO_VAD_ONNX);
  }

  isVadModelDownloaded() {
    return fs.existsSync(this.getVadModelPath());
  }

  async downloadModels(progressCallback = null) {
    const modelsDir = this.getModelsDir();
    await fsPromises.mkdir(modelsDir, { recursive: true });

    const modelsReady = this.isModelDownloaded();
    const vadReady = this.isVadModelDownloaded();

    if (modelsReady && vadReady) {
      return { success: true, path: modelsDir };
    }

    const requiredBytes = modelsReady ? 2 * 1_000_000 : 37 * 1_000_000;
    const spaceCheck = await checkDiskSpace(modelsDir, requiredBytes * 2.5);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space. Need ~${Math.round((requiredBytes * 2.5) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    try {
      // Download segmentation model (tar.bz2)
      const segArchivePath = path.join(modelsDir, `${SEGMENTATION_DIR}.tar.bz2`);
      const segModelPath = path.join(modelsDir, SEGMENTATION_ONNX);

      if (!fs.existsSync(segModelPath)) {
        await downloadFile(SEGMENTATION_MODEL_URL, segArchivePath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            if (progressCallback) {
              progressCallback({
                type: "progress",
                stage: "segmentation",
                downloaded_bytes: downloadedBytes,
                total_bytes: totalBytes,
                percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              });
            }
          },
        });

        // Extract tar.bz2
        if (progressCallback) {
          progressCallback({ type: "progress", stage: "extracting", percentage: 100 });
        }

        await this._extractTarBz2(segArchivePath, modelsDir);
        await fsPromises.unlink(segArchivePath).catch(() => {});

        if (!fs.existsSync(segModelPath)) {
          throw new Error("Segmentation model extraction failed: model.onnx not found");
        }
      }

      // Download embedding model (.onnx directly)
      const embModelPath = path.join(modelsDir, EMBEDDING_ONNX);

      if (!fs.existsSync(embModelPath)) {
        await downloadFile(EMBEDDING_MODEL_URL, embModelPath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            if (progressCallback) {
              progressCallback({
                type: "progress",
                stage: "embedding",
                downloaded_bytes: downloadedBytes,
                total_bytes: totalBytes,
                percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              });
            }
          },
        });
      }

      if (!this.isVadModelDownloaded()) {
        try {
          await downloadFile(SILERO_VAD_MODEL_URL, this.getVadModelPath(), {
            timeout: 600000,
            signal,
            onProgress: (downloadedBytes, totalBytes) => {
              if (progressCallback) {
                progressCallback({
                  type: "progress",
                  stage: "vad",
                  downloaded_bytes: downloadedBytes,
                  total_bytes: totalBytes,
                  percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                });
              }
            },
          });
        } catch (error) {
          if (error.isAbort) {
            throw new Error("Download interrupted by user");
          }
          debugLogger.warn("Silero VAD model download failed", {
            error: error.message,
            modelsDir,
          });
        }
      }

      if (progressCallback) {
        progressCallback({ type: "complete", percentage: 100 });
      }

      debugLogger.info("Diarization models downloaded", { modelsDir });
      return { success: true, path: modelsDir };
    } catch (error) {
      if (error.isAbort) {
        throw new Error("Download interrupted by user");
      }
      if (progressCallback) {
        progressCallback({ type: "error", error: error.message });
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async _extractTarBz2(archivePath, destDir) {
    try {
      await this._runSystemTar(archivePath, destDir);
      return;
    } catch (err) {
      debugLogger.debug("System tar failed, falling back to JS extraction", {
        error: err.message,
      });
    }

    const unbzip2 = require("unbzip2-stream");
    const tar = require("tar");
    const { pipeline } = require("stream/promises");
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: destDir }));
  }

  _runSystemTar(archivePath, destDir) {
    return runSystemTar(archivePath, destDir);
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async diarize(wavPath, options = {}) {
    const { threshold = 0.55, signal = null, pipeRoot = null } = options;

    if (signal?.aborted) return [];

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      debugLogger.warn("Diarization binary not found");
      return [];
    }

    if (!this.isModelDownloaded()) {
      debugLogger.warn("Diarization models not downloaded");
      return [];
    }

    if (!Buffer.isBuffer(wavPath) && !fs.existsSync(wavPath)) {
      debugLogger.warn("Diarization input file not found", { wavPath });
      return [];
    }

    const segPath = this._resolveModelPath(SEGMENTATION_ONNX);
    const embPath = this._resolveModelPath(EMBEDDING_ONNX);
    let pipePath = null;
    if (Buffer.isBuffer(wavPath)) {
      if (!pipeRoot || process.platform === "win32") throw new Error("Secure meeting diarization pipe is unavailable");
      fs.mkdirSync(pipeRoot, { recursive: true, mode: 0o700 });
      pipePath = path.join(pipeRoot, `diarization-${crypto.randomUUID()}.fifo`);
      const result = spawnSync("mkfifo", ["-m", "600", pipePath], { windowsHide: true });
      if (result.status !== 0) throw new Error("Could not create secure diarization pipe");
    }

    const args = [
      `--segmentation.pyannote-model=${segPath}`,
      `--embedding.model=${embPath}`,
      "--clustering.num-clusters=-1",
      `--clustering.cluster-threshold=${threshold}`,
      "--min-duration-on=0.2",
      "--min-duration-off=0.5",
      pipePath || wavPath,
    ];

    debugLogger.info("Starting diarization", {
      binaryPath,
      numSpeakers: "automatic",
      threshold,
      wavPath: Buffer.isBuffer(wavPath) ? "memory" : wavPath,
    });

    // Scale with the recording length, but never below the 60-minute floor.
    let timeoutMs = DIARIZATION_TIMEOUT_MS;
    try {
      timeoutMs = Math.max(
        DIARIZATION_TIMEOUT_MS,
        computeTranscriptionTimeoutMs((Buffer.isBuffer(wavPath) ? wavPath.length : fs.statSync(wavPath).size) / PCM16_MONO_16K_BYTES_PER_SECOND)
      );
    } catch {
      // Unreadable WAV: keep the flat cap.
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      // Opening the FIFO read/write avoids a race where both the child's read
      // and the parent's write block waiting for the other endpoint to open.
      const pipeKeeperFd = pipePath
        ? fs.openSync(pipePath, fs.constants.O_RDWR)
        : null;

      const proc = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      if (pipePath) {
        const writerFd = fs.openSync(pipePath, fs.constants.O_WRONLY);
        const writer = fs.createWriteStream(pipePath, { fd: writerFd, autoClose: true });
        writer.on("error", (error) => debugLogger.warn("Diarization pipe write failed", { error: error.message }));
        writer.end(wavPath);
      }

      this._processes.add(proc);
      sidecarPidFile.write("diarization", proc.pid);

      // The single pid-file slot tracks whichever process is still alive; only
      // the reaper consumes it, and the Set is the real shutdown source.
      const untrack = () => {
        if (pipeKeeperFd != null) { try { fs.closeSync(pipeKeeperFd); } catch {} }
        if (pipePath) { try { fs.unlinkSync(pipePath); } catch {} }
        this._processes.delete(proc);
        const survivor = this._processes.values().next().value;
        if (survivor) sidecarPidFile.write("diarization", survivor.pid);
        else sidecarPidFile.clear("diarization");
      };

      const timeout = setTimeout(() => {
        debugLogger.warn("Diarization timed out", { timeoutMs });
        gracefulStopProcess(proc);
        resolve([]);
      }, timeoutMs);

      // A cancelled upload kills the child immediately (same stop the timeout
      // path uses); the close handler below still fires and cleans up.
      const onAbort = () => {
        debugLogger.info("Diarization cancelled, stopping process");
        gracefulStopProcess(proc);
        resolve([]);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        untrack();

        if (code !== 0) {
          debugLogger.warn("Diarization process exited with error", {
            code,
            stderr: stderr.slice(-500).trim(),
          });
          resolve([]);
          return;
        }

        const segments = this._parseOutput(stdout);
        debugLogger.info("Diarization complete", { segmentCount: segments.length });
        resolve(segments);
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        untrack();
        debugLogger.warn("Diarization process error", { error: err.message });
        resolve([]);
      });
    });
  }

  _parseOutput(stdout) {
    const segments = [];
    const lineRegex = /^(\d+\.?\d*)\s+--\s+(\d+\.?\d*)\s+(speaker_\d+)$/;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(lineRegex);
      if (match) {
        segments.push({
          start: parseFloat(match[1]),
          end: parseFloat(match[2]),
          speaker: match[3],
        });
      }
    }

    return segments;
  }

  // Splits out echo-flagged mic segments whose text matches nearby system audio.
  // `removed` holds the same objects that were passed in, so callers can map
  // them back to their original rows.
  splitMicEchoDuplicates(segments) {
    const systemSegments = segments.filter((seg) => seg.source === "system" && seg.text);
    if (!systemSegments.length) return { kept: segments, removed: [] };

    const kept = [];
    const removed = [];
    for (const seg of segments) {
      if (
        seg.source !== "mic" ||
        !seg.text ||
        (!seg.likelyRenderBleed && !seg.hasBleedEvidence && seg.suppressionReason !== "double_talk")
      ) {
        kept.push(seg);
        continue;
      }

      const matcher =
        seg.suppressionReason === "double_talk" ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildMergedCandidates({
        segments: systemSegments,
        timestamp: seg.timestamp,
        windowMs: ECHO_DUPLICATE_WINDOW_S,
        mergeLimit: ECHO_DUPLICATE_MERGE_LIMIT,
      });
      const isEcho = candidates.some((candidateText) => matcher(seg.text, candidateText));
      (isEcho ? removed : kept).push(seg);
    }
    return { kept, removed };
  }

  // Expects echo duplicates already removed with splitMicEchoDuplicates, so
  // the caller can report them to the renderer.
  mergeWithTranscript(
    transcriptSegments,
    diarizationSegments,
    { diarizedSource = "system", speakerIndexBase = 0, recordingId = null,
      audioStartOffsetSeconds = 0, audioStartOffsets = {} } = {}
  ) {
    if (!transcriptSegments || transcriptSegments.length === 0) return [];
    if (!diarizationSegments || diarizationSegments.length === 0) {
      return recordingId != null
        ? require("./meetingWordAlignment").withAudioSpans(
          transcriptSegments, recordingId, audioStartOffsets)
        : transcriptSegments.map((seg) => ({ ...seg }));
    }

    // Renumber clusters (speaker_00 → speaker_0), offset past a resumed note's ids.
    const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
    const speakerMap = buildSpeakerRenumber(speakerSet, speakerIndexBase);

    const alignedBounds = (seg) => {
      const tokens = String(seg.text || "").trim().split(/\s+/u).filter(Boolean);
      const words = seg.wordTimings;
      if (!Array.isArray(words) || words.length !== tokens.length || !words.length) return null;
      const comparable = (value) => String(value).normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase();
      for (let i = 0; i < words.length; i += 1) {
        if (comparable(words[i].word) !== comparable(tokens[i]) ||
          !Number.isFinite(words[i].start) || !Number.isFinite(words[i].end) ||
          words[i].start < 0 || words[i].end <= words[i].start ||
          (i && words[i].start < words[i - 1].end)) return null;
      }
      return { start: words[0].start, end: words.at(-1).end };
    };

    const splitAtHandoffs = (seg) => {
      if (seg.source !== diarizedSource || seg.speakerLocked || seg.speakerLockSource === "user" ||
        seg.corrections?.length || !alignedBounds(seg) || seg.wordTimings.length < 2) return [seg];
      const speakers = seg.wordTimings.map((word) => {
        let best = null, bestDuration = 0;
        for (const turn of diarizationSegments) {
          const duration = Math.min(word.end, turn.end) - Math.max(word.start, turn.start);
          if (duration > bestDuration) { best = turn.speaker; bestDuration = duration; }
        }
        return best;
      });
      if (speakers.some((speaker) => !speaker)) return [seg];
      const boundaries = [0];
      for (let i = 1; i < speakers.length; i += 1)
        if (speakers[i] !== speakers[i - 1]) boundaries.push(i);
      if (boundaries.length === 1) return [seg];
      boundaries.push(speakers.length);
      const tokens = seg.text.trim().split(/\s+/u);
      return boundaries.slice(0, -1).map((start, i) => {
        const end = boundaries[i + 1];
        if (i === 0) return { ...seg, audioSpan: undefined,
          parentRowId: seg.id, splitStartWord: 0,
          text: tokens.slice(start, end).join(" "),
          wordTimings: seg.wordTimings.slice(start, end) };
        const hex = crypto.createHash("sha256").update(`${seg.id}\0${start}`).digest("hex");
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        return { ...seg, id, audioSpan: undefined, parentRowId: seg.id, splitStartWord: start,
          text: tokens.slice(start, end).join(" "),
          wordTimings: seg.wordTimings.slice(start, end),
          timestamp: seg.wordTimings[start].start,
          unknownNumber: undefined };
      });
    };
    const workingSegments = transcriptSegments.flatMap(splitAtHandoffs);
    const nextTimestampAt = (startIndex, source) => {
      for (let i = startIndex + 1; i < workingSegments.length; i += 1) {
        const candidate = workingSegments[i];
        if (candidate.source === source && candidate.timestamp != null) {
          return candidate.timestamp;
        }
      }
      return null;
    };

    return workingSegments.map((seg, index) => {
      const enriched = { ...seg };
      const bounds = alignedBounds(seg);
      if (!bounds) {
        // A diarization turn is not a transcript alignment. Keep the row honest.
        delete enriched.wordTimings;
        delete enriched.audioSpan;
      } else if (recordingId != null) {
        const offset = audioStartOffsets[seg.source] ?? audioStartOffsetSeconds;
        enriched.audioSpan = {
          recordingId, trackId: seg.source,
          startSample: Math.round((offset + bounds.start) * 24000),
          endSample: Math.round((offset + bounds.end) * 24000),
        };
      }

      // A mic track can contain several people. Preserve any user correction,
      // otherwise leave it unnamed when only system audio was diarized.
      if (seg.source === "mic" && diarizedSource !== "mic") {
        if (!enriched.speaker) {
          enriched.speaker = "speaker_mic";
          enriched.speakerIsPlaceholder = true;
          enriched.speakerStatus = "provisional";
        }
        return enriched;
      }

      if (seg.source === diarizedSource && seg.timestamp != null) {
        const segStart = bounds?.start ?? seg.timestamp;
        const segEnd = bounds?.end ?? (nextTimestampAt(index, diarizedSource) ?? segStart + 2.5);
        const midpoint = segStart + (segEnd - segStart) / 2;
        let overlapSpeaker = null;
        let nearestSpeaker = null;
        let bestOverlap = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        let overlapSpan = null;
        let nearestSpan = null;

        for (const dSeg of diarizationSegments) {
          const overlap = Math.min(segEnd, dSeg.end) - Math.max(segStart, dSeg.start);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            overlapSpeaker = dSeg.speaker;
            overlapSpan = dSeg;
          }

          const distance =
            midpoint < dSeg.start
              ? dSeg.start - midpoint
              : midpoint > dSeg.end
                ? midpoint - dSeg.end
                : 0;

          if (distance < bestDistance) {
            bestDistance = distance;
            nearestSpeaker = dSeg.speaker;
            nearestSpan = dSeg;
          }
        }

        // Tracked separately so the between-clusters fallback compares every
        // distance instead of latching onto the first cluster it sees.
        const bestSpeaker = overlapSpeaker ?? nearestSpeaker;
        const matchedSpan = overlapSpan ?? nearestSpan;
        // Only simultaneous, distinct diarization voices count as cross-talk.
        // A handoff with adjacent turns has zero intersection and stays assignable.
        const simultaneous = !!bounds && diarizationSegments.some((first, i) =>
          diarizationSegments.slice(i + 1).some((second) =>
            first.speaker !== second.speaker &&
            Math.min(segEnd, first.end, second.end) - Math.max(segStart, first.start, second.start) >= 0.1));
        enriched.uncertainty = simultaneous
          ? { reason: "overlapping_speech" }
          : shortSpanReason(matchedSpan) || enriched.uncertainty;
        if (enriched.uncertainty) enriched.speakerAssessmentAvailable = true;
        const abstained = ["too_short", "close_match", "not_sure", "overlapping_speech"].includes(enriched.uncertainty?.reason);
        if (abstained && !enriched.speakerLocked && enriched.speakerLockSource !== "user") {
          enriched.speakerName = undefined;
          enriched.speakerIsPlaceholder = true;
          enriched.speakerStatus = "provisional";
        }

        if (bestSpeaker && !seg.speakerLocked && seg.speakerLockSource !== "user") {
          const patch = {
            speaker: speakerMap.get(bestSpeaker) || bestSpeaker,
            speakerIsPlaceholder: abstained,
          };
          if (abstained) {
            if (!enriched.speakerLocked && enriched.speakerLockSource !== "user") Object.assign(enriched, patch);
          } else {
            applyConfirmedSpeaker(enriched, patch);
          }
        }
      }

      return enriched;
    });
  }

  async convertRawPcmToWav(rawPcmPath, inputSampleRate) {
    const stat = await fsPromises.stat(rawPcmPath);
    if (stat.size === 0) {
      throw new Error("Raw PCM file is empty");
    }

    const tempDir = getSafeTempDir();
    // Random suffix: concurrent conversions (meeting + upload) must never collide.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputWavPath = path.join(tempDir, `ow-diarize-${runId}-input.wav`);
    const wavPath = path.join(tempDir, `ow-diarize-${runId}.wav`);

    // Stream: write 44-byte WAV header, then pipe raw PCM — avoids loading entire file into memory
    const header = this._createWavHeader(stat.size, inputSampleRate, 1);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(inputWavPath);
      out.write(header);
      const pcmStream = fs.createReadStream(rawPcmPath);
      pcmStream.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      pcmStream.on("error", reject);
    });

    try {
      await convertToWav(inputWavPath, wavPath, { sampleRate: 16000, channels: 1 });
    } finally {
      await fsPromises.unlink(inputWavPath).catch(() => {});
    }

    debugLogger.debug("Raw PCM converted to WAV for diarization", {
      wavPath,
      rawPcmBytes: stat.size,
    });

    return wavPath;
  }

  async convertRawPcmToWavBuffer(rawPcm, inputSampleRate) {
    if (!Buffer.isBuffer(rawPcm) || !rawPcm.length) throw new Error("Raw PCM buffer is empty");
    const samples = await new Promise((resolve, reject) => {
      const proc = spawn(getFFmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "s16le",
        "-ar", String(inputSampleRate), "-ac", "1", "-i", "pipe:0", "-f", "s16le",
        "-ar", "16000", "-ac", "1", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const parts = [];
      let error = "";
      proc.stdout.on("data", (part) => parts.push(part));
      proc.stderr.on("data", (part) => { error += part.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`PCM conversion failed: ${error}`)));
      proc.stdin.end(rawPcm);
    });
    const header = this._createWavHeader(samples.length, 16000, 1);
    return Buffer.concat([header, samples]);
  }

  _createWavHeader(dataSize, sampleRate, channels) {
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bytesPerSample * 8, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }

  async deleteModels() {
    const modelsDir = this.getModelsDir();
    const segDir = path.join(modelsDir, SEGMENTATION_DIR);
    const embPath = path.join(modelsDir, EMBEDDING_ONNX);
    const vadPath = this.getVadModelPath();

    if (fs.existsSync(segDir)) {
      await fsPromises.rm(segDir, { recursive: true, force: true });
    }
    if (fs.existsSync(embPath)) {
      await fsPromises.unlink(embPath);
    }
    if (fs.existsSync(vadPath)) {
      await fsPromises.unlink(vadPath);
    }

    debugLogger.info("Diarization models deleted", { modelsDir });
    return { success: true };
  }

  async shutdown() {
    const procs = [...this._processes];
    this._processes.clear();
    await Promise.all(procs.map((p) => gracefulStopProcess(p)));
  }
}

module.exports = DiarizationManager;
