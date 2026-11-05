const { createHash, randomUUID } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");
const { buildCalibrationLabels } = require("./speakerCalibrationExport");
const { recordingIdentity, overlapsRecording } = require("./voiceRecordingIdentity");

const sha = (value) => createHash("sha256").update(value).digest("hex");
const noteEmbeddingsFingerprint = (items) =>
  sha(
    JSON.stringify(
      items
        .map((item) => [String(item.speaker_id), sha(item.embedding)])
        .sort(([a], [b]) => a.localeCompare(b))
    )
  );
const vectorOf = (blob) =>
  Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
const candidates = {
  similarityFloor: [0.55, 0.6, 0.65, 0.7, 0.75],
  runnerUpMargin: [0.03, 0.05, 0.08, 0.1],
};
function ranked(vector, profiles) {
  const cosine = (a, b) => {
    let dot = 0,
      aa = 0,
      bb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      aa += a[i] ** 2;
      bb += b[i] ** 2;
    }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  };
  return profiles
    .map((profile) => ({ name: profile.name, score: cosine(vector, profile.vector) }))
    .sort((a, b) => b.score - a.score);
}
function sweep(rows, profiles, key) {
  const examples = rows
    .filter((row) => Array.isArray(row[key]) && row[key].length && row.truePerson)
    .map((row) => ({ truePerson: row.truePerson, ranked: ranked(row[key], profiles) }));
  const table = [];
  for (const floor of candidates.similarityFloor)
    for (const margin of candidates.runnerUpMargin) {
      let right = 0,
        wrong = 0,
        refused = 0;
      for (const row of examples) {
        const [best, next] = row.ranked;
        if (!best || best.score <= floor || best.score - (next?.score || 0) < margin) refused++;
        else if (best.name === row.truePerson) right++;
        else wrong++;
      }
      table.push({
        similarityFloor: floor,
        runnerUpMargin: margin,
        right,
        wrong,
        refused,
        rightPersonRate: examples.length ? right / examples.length : null,
        refusalRate: examples.length ? refused / examples.length : null,
      });
    }
  const winner = [...table].sort(
    (a, b) =>
      b.right * 2 - b.wrong * 4 - b.refused - (a.right * 2 - a.wrong * 4 - a.refused) ||
      b.runnerUpMargin - a.runnerUpMargin ||
      b.similarityFloor - a.similarityFloor
  )[0];
  return { rows: examples.length, table, winner };
}
function buildReport({
  rows,
  profiles,
  scope,
  modelFingerprint,
  exclusions = [],
  bytesRead = 0,
  reviewedCount = rows.length,
  consideredCount = reviewedCount,
  rowBudget = consideredCount,
  noteBudget = new Set(rows.map((row) => row.noteId)).size,
  selectedNotes = new Set(rows.map((row) => row.noteId)).size,
  placementCounts = { exact: 0, approximate: 0, unavailable: 0 },
  embeddingCounts = { embedded: 0, refused: 0 },
  missingVectorDiagnostics = [],
  noteCentroidCompletions = [],
  noteEmbeddingFingerprints = {},
  generatedAt = new Date().toISOString(),
  synthetic = false,
}) {
  const byCluster = new Map();
  const storedRows = rows.filter(
    (item) => item.vector && item.vectorSource !== "reconstructed-row-audio"
  );
  const reconstructedRows = rows.filter(
    (item) => item.vector && item.vectorSource === "reconstructed-row-audio"
  );
  const exemplarRows = rows.filter((item) => item.vectorSource === "approved-exemplar").length;
  for (const row of storedRows) {
    const key = `${row.noteId}:${row.clusterId}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(row);
  }
  const clusters = [];
  const allExclusions = [...exclusions];
  for (const [key, members] of byCluster) {
    if (new Set(members.map((row) => row.truePerson)).size > 1) {
      allExclusions.push({ cluster: key, reason: "conflicting_reviewed_labels" });
    } else clusters.push(members[0]);
  }
  const exact = sweep(clusters, profiles, "vector");
  const calibration = sweep([...clusters, ...reconstructedRows], profiles, "vector");
  const estimated = sweep(rows, profiles, "liveVector");
  const people = new Set(rows.map((row) => row.truePerson).filter(Boolean));
  const notes = new Set(rows.map((row) => row.noteId));
  const claims = rows.filter((row) => row.machineLabel).length;
  const profileFingerprint = sha(
    JSON.stringify(profiles.map((profile) => [profile.id, profile.name, profile.vector]))
  );
  const audioFingerprints = Object.fromEntries(
    rows.filter((row) => row.audioFingerprint).map((row) => [row.noteId, row.audioFingerprint])
  );
  const recordings = Object.fromEntries(
    rows.filter((row) => row.recordingId != null).map((row) => [row.noteId, row.recordingId])
  );
  const audioManifests = Object.fromEntries(
    rows
      .filter((row) => row.audioManifestFingerprint)
      .map((row) => [row.noteId, row.audioManifestFingerprint])
  );
  const revisions = rows.map((row) => ({
    noteId: row.noteId,
    rowId: row.rowId,
    revision: row.revision,
    ...(row.exemplarId ? { exemplarId: row.exemplarId, contentHash: row.contentHash } : {}),
  }));
  const gate =
    !synthetic &&
    rows.length >= 30 &&
    notes.size >= 3 &&
    people.size >= 2 &&
    profiles.length >= 2 &&
    claims >= 10 &&
    /^[a-f0-9]{64}$/.test(modelFingerprint || "") &&
    /^[a-f0-9]{64}$/.test(profileFingerprint) &&
    Object.keys(audioFingerprints).length === notes.size &&
    Object.values(audioFingerprints).every((hash) => /^[a-f0-9]{64}$/.test(hash));
  const missing = [];
  if (synthetic) missing.push("Synthetic fixture cannot calibrate settings");
  if (rows.length < 30 || notes.size < 3 || people.size < 2)
    missing.push("Need 30 reviewed rows across three notes and two people");
  if (claims < 10) missing.push("Need ten recorded machine claims");
  if (profiles.length < 2) missing.push("Need two current voice profiles");
  if (calibration.rows < 12)
    missing.push("Need twelve consistent stored clusters or reconstructed rows");
  if (Object.keys(audioFingerprints).length !== notes.size)
    missing.push("Need retained-audio fingerprints for every included note");
  if (!/^[a-f0-9]{64}$/.test(modelFingerprint || ""))
    missing.push("Speaker model fingerprint unavailable");
  const calibrationStatus = gate && calibration.rows >= 12 ? "calibrated" : "uncalibrated";
  const calibrationReason = calibrationStatus === "calibrated" ? undefined : missing.join("; ");
  const method = exemplarRows
    ? "approved-exemplars-and-available-row-evidence"
    : reconstructedRows.length
      ? "reconstructed-row-audio"
      : "stored-centroid-current-profiles";
  const support = {
    similarityFloor: {
      status: calibrationStatus,
      method,
      rows: calibration.rows,
      machineClaims: claims,
      ...(calibrationReason ? { reason: calibrationReason } : {}),
    },
    runnerUpMargin: {
      status: calibrationStatus,
      method,
      rows: calibration.rows,
      machineClaims: claims,
      ...(calibrationReason ? { reason: calibrationReason } : {}),
    },
    minimumVoicedSeconds: {
      status: "uncalibrated",
      method: "insufficient-original-evidence",
      reason:
        "The production gate used matched diarization-turn duration, which was not stored. Need those original turns and durations.",
    },
    overlapToleranceSeconds: {
      status: "uncalibrated",
      method: "insufficient-original-evidence",
      reason:
        "The stored overlap flag is one outcome at one tolerance. Need original overlap intervals or exactly reproducible diarization evidence.",
    },
  };
  const recommended = Object.fromEntries(
    ["similarityFloor", "runnerUpMargin"]
      .filter((key) => support[key].status === "calibrated")
      .map((key) => [key, calibration.winner[key]])
  );
  return {
    version: 2,
    id: randomUUID(),
    synthetic,
    method,
    generatedAt,
    scope,
    evidence: {
      notes: notes.size,
      reviewedRows: rows.length,
      distinctPeople: people.size,
      machineClaims: claims,
      exactClusters: exact.rows,
      calibrationRows: calibration.rows,
      storedRows: storedRows.length,
      exemplarRows,
      reconstructedRows: reconstructedRows.length,
      reviewedCandidates: reviewedCount,
      consideredRows: consideredCount,
      rowBudget,
      noteBudget,
      selectedNotes,
      truncatedByRowBudget: consideredCount < reviewedCount,
      placementCounts,
      embeddingCounts,
      coverage: `considered ${consideredCount} of ${reviewedCount} reviewed rows in ${selectedNotes} selected ${selectedNotes === 1 ? "note" : "notes"} (row budget ${rowBudget}, note budget ${noteBudget}${consideredCount < reviewedCount ? "; row cap truncated the set" : ""}); ${reconstructedRows.length} reconstructed`,
      exclusionCounts: Object.fromEntries(
        [...new Set(allExclusions.map((item) => item.reason))].map((reason) => [
          reason,
          allExclusions.filter((item) => item.reason === reason).length,
        ])
      ),
      missingVectorDiagnostics,
      noteCentroidCompletions,
      estimatedRows: estimated.rows,
      bytesRead,
      revisions,
      exclusions: allExclusions,
    },
    fingerprints: {
      model: modelFingerprint,
      profiles: profileFingerprint,
      audio: audioFingerprints,
      recordings,
      audioManifests,
      noteEmbeddings: noteEmbeddingFingerprints,
    },
    analyses: {
      exact: { label: "Measured against your profiles as they are today", ...exact },
      calibration: {
        label: exemplarRows
          ? "Measured against your profiles as they are today"
          : reconstructedRows.length
            ? "Calibration using reconstructed row audio against current profiles"
            : "Calibration using stored centroids against current profiles",
        ...calibration,
      },
      estimated: {
        label: "Estimate: live decisions from re-embedded reviewed rows",
        reason:
          "Retained audio is 32 kb/s Opus. Original live speech windows were not saved; these are new row-window embeddings, not a live replay. A live query can differ from its running centroid by up to 2 in cosine.",
        ...estimated,
      },
    },
    support,
    recommended,
  };
}
function collectRows(database, audioStore, scope, budget) {
  const db = database.db;
  const selectedOrigins = new Set();
  const selectOrigin = (key) => {
    if (selectedOrigins.has(key)) return true;
    if (selectedOrigins.size >= budget.notes) return false;
    selectedOrigins.add(key);
    return true;
  };
  const exemplars = (database.getVoiceExemplarAudio?.() || []).filter(
    (sample) =>
      sample.valid !== 0 &&
      (scope.kind !== "range" ||
        (sample.meeting_date?.slice(0, 10) >= scope.from &&
          sample.meeting_date?.slice(0, 10) <= scope.to)) &&
      selectOrigin(recordingIdentity(db, sample))
  );
  const where = scope.kind === "range" ? " AND date(created_at) BETWEEN date(?) AND date(?)" : "";
  const chosen = db
    .prepare(
      `SELECT id, client_note_id, transcript, speaker_action_log, created_at FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL AND transcript IS NOT NULL${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...(scope.kind === "range" ? [scope.from, scope.to] : []), budget.notes)
    .filter((note) =>
      selectOrigin(
        recordingIdentity(
          db,
          { note_id: note.id, note_identity: note.client_note_id },
          audioStore.status(note.id),
          note
        )
      )
    );
  const rows = [],
    exclusions = [],
    missingVectorDiagnostics = [],
    noteCentroidCompletions = [];
  const noteEmbeddingFingerprints = {};
  let reviewedCount = 0;
  for (const sample of exemplars) {
    reviewedCount++;
    if (rows.length >= budget.rows) continue;
    const person = db
      .prepare("SELECT display_name FROM speaker_profiles WHERE id = ?")
      .get(sample.profile_id);
    rows.push({
      noteId: sample.note_id,
      rowId: JSON.parse(sample.row_ids)[0],
      revision: sample.revision,
      exemplarId: sample.id,
      contentHash: sample.content_hash,
      truePerson: person.display_name,
      clusterId: `exemplar:${sample.id}`,
      vector: vectorOf(sample.embedding),
      vectorSource: "approved-exemplar",
      audioFingerprint: sample.content_hash,
      playbackPlaceable: true,
      audioAvailable: true,
      audioState: "available",
      approximate: false,
    });
  }
  for (const note of chosen) {
    const status = audioStore.status(note.id);
    if (status.state === "recording") continue;
    const labels = buildCalibrationLabels(note, {}, status).rows;
    const noteEmbeddings = database.getNoteSpeakerEmbeddings(note.id);
    const vectors = new Map(
      noteEmbeddings.map((item) => [String(item.speaker_id), vectorOf(item.embedding)])
    );
    const completion = database.getNoteSpeakerCompletion?.(note.id);
    if (completion)
      noteCentroidCompletions.push({
        noteId: note.id,
        clusters: completion.clusters ?? 0,
        vectorsWritten: completion.vectorsWritten ?? 0,
        ...(completion.cause ? { cause: completion.cause } : {}),
      });
    const reviewedIds = new Set(
      readSpeakerActionLog(note)
        .actions.filter((a) => a.event?.actor !== "machine")
        .flatMap(
          (a) =>
            a.event?.affectedRowIds || a.event?.rowIds || (a.event?.rowId ? [a.event.rowId] : [])
        )
    );
    const transcriptRows = new Map(
      readTranscriptDocument(note.transcript).rows.map((row) => [row.id, row])
    );
    const rowsBeforeNote = rows.length;
    for (const label of labels) {
      const row = transcriptRows.get(label.rowId);
      if (
        exemplars.some(
          (sample) =>
            (sample.note_id === note.id &&
              sample.note_identity === note.client_note_id &&
              JSON.parse(sample.row_ids).includes(label.rowId)) ||
            overlapsRecording(
              db,
              sample,
              note,
              status,
              label.track,
              label.from * 24000,
              label.to * 24000
            )
        )
      )
        continue;
      if (
        !row ||
        row.deleted ||
        !row.speakerName ||
        !(row.speakerLockSource === "user" || reviewedIds.has(row.id))
      )
        continue;
      reviewedCount++;
      if (rows.length >= budget.rows) continue;
      const vector = vectors.get(String(row.speaker));
      if (!vector) {
        const reason =
          completion?.cause ||
          (vectors.size
            ? "speaker_id_vs_speaker_key_mismatch"
            : !completion
              ? "no_completion_event"
              : !completion.hadSpeakerEmbeddings
                ? "completion_without_speakerEmbeddings"
                : "completion_embeddings_not_saved");
        if (
          !missingVectorDiagnostics.some(
            (item) => item.noteId === note.id && item.reason === reason
          )
        ) {
          const explanations = {
            no_completion_event: "No diarization completion event was recorded",
            completion_without_speakerEmbeddings: "Diarization completed without speakerEmbeddings",
            speaker_id_vs_speaker_key_mismatch:
              "Stored speaker_id keys do not match the reviewed rows' speaker keys",
            completion_embeddings_not_saved:
              "Diarization supplied speakerEmbeddings, but none were saved",
          };
          missingVectorDiagnostics.push({
            noteId: note.id,
            reason,
            message: `Note ${note.id}: ${explanations[reason] || reason}; ${completion?.vectorsWritten ?? 0} of ${completion?.clusters ?? 0} cluster vectors written; reviewed rows need reconstructed audio.`,
          });
        }
      }
      rows.push({
        noteId: note.id,
        rowId: row.id,
        revision: sha(JSON.stringify(row)),
        truePerson: row.speakerName,
        machineLabel: label.machineLabel,
        clusterId: String(row.speaker),
        vector,
        vectorSource: vector ? "stored-centroid-current-profiles" : null,
        track: label.track,
        start: label.start,
        end: label.end,
        from: label.from,
        to: label.to,
        playbackUnavailableReason: label.unavailableReason,
        playbackPlaceable: !label.unavailableReason,
        approximate: label.approximate,
        audioFingerprint: null,
        recordingId: status.recordingId,
        audioManifestFingerprint: sha(JSON.stringify(status.tracks || {})),
        audioAvailable: ["complete", "incomplete"].includes(status.state),
        audioState: status.state,
      });
    }
    if (rows.length > rowsBeforeNote)
      noteEmbeddingFingerprints[note.id] = noteEmbeddingsFingerprint(noteEmbeddings);
  }
  return {
    rows,
    exclusions,
    reviewedCount,
    consideredCount: rows.length,
    selectedNotes: selectedOrigins.size,
    missingVectorDiagnostics,
    noteCentroidCompletions,
    noteEmbeddingFingerprints,
  };
}
function pcm16FromWav(wav) {
  const data = wav.indexOf(Buffer.from("data"));
  if (data < 0) throw Error("Missing WAV data");
  const sampleRate = wav.readUInt32LE(24);
  const count = Math.floor(wav.readUInt32LE(data + 4) / 2);
  const result = new Float32Array(Math.floor((count * 16000) / sampleRate));
  for (let i = 0; i < result.length; i++)
    result[i] = wav.readInt16LE(data + 8 + Math.floor((i * sampleRate) / 16000) * 2) / 32768;
  return result;
}
async function runJob(
  job,
  database,
  audioStore,
  scope,
  budget,
  model = require("./speakerEmbeddings")
) {
  const started = Date.now();
  const {
    rows,
    exclusions,
    reviewedCount,
    consideredCount,
    selectedNotes,
    missingVectorDiagnostics,
    noteCentroidCompletions,
    noteEmbeddingFingerprints,
  } = collectRows(database, audioStore, scope, budget);
  job.progress.totalRows = rows.length;
  let modelFingerprint = null;
  if (model.isAvailable()) {
    const hash = createHash("sha256");
    for await (const chunk of require("node:fs").createReadStream(model.getModelPath()))
      hash.update(chunk);
    modelFingerprint = hash.digest("hex");
  }
  const audioHashes = new Map();
  for (const row of rows) {
    if (job.cancelled) {
      job.state = "cancelled";
      return;
    }
    if (row.exemplarId) {
      const audio = require("./voiceExemplarAudio").play(database.db, audioStore, row.exemplarId);
      if (audio?.state !== "available") {
        row.vector = null;
        exclusions.push({
          noteId: row.noteId,
          rowId: row.rowId,
          reason: audio?.error || "audio_unavailable",
        });
      } else job.progress.bytesRead += audio.wav.length;
    } else if (
      !row.audioAvailable ||
      row.playbackUnavailableReason ||
      !Number.isFinite(row.from) ||
      !Number.isFinite(row.to) ||
      Math.min(row.end, row.to) - Math.max(row.start, row.from) < 1.5
    ) {
      exclusions.push({
        noteId: row.noteId,
        rowId: row.rowId,
        reason: !row.audioAvailable
          ? `audio_${row.audioState}`
          : row.playbackUnavailableReason
            ? `playback_${row.playbackUnavailableReason}`
            : "span_too_short",
      });
    } else if (!modelFingerprint) {
      exclusions.push({
        noteId: row.noteId,
        rowId: row.rowId,
        reason: "speaker_model_unavailable",
      });
    } else {
      const span = audioStore.span(row.noteId, row.track, Math.max(row.from, row.to - 8), row.to);
      if (span.wav) {
        job.progress.bytesRead += span.bytesRead || span.wav.length;
        if (span.partial)
          exclusions.push({ noteId: row.noteId, rowId: row.rowId, reason: "audio_partial" });
        else {
          if (!audioHashes.has(row.noteId)) audioHashes.set(row.noteId, createHash("sha256"));
          audioHashes.get(row.noteId).update(span.wav);
          row.liveVector = Array.from(
            (await model.extractEmbeddingFromSamples(pcm16FromWav(span.wav))) || []
          );
          if (row.liveVector.length) {
            job.progress.reembeddedRows++;
            if (!row.vector) {
              row.vector = row.liveVector;
              row.vectorSource = "reconstructed-row-audio";
            }
          } else
            exclusions.push({
              noteId: row.noteId,
              rowId: row.rowId,
              reason: "embedding_unavailable",
            });
        }
      } else
        exclusions.push({ noteId: row.noteId, rowId: row.rowId, reason: `audio_${span.state}` });
    }
    job.progress.processedRows++;
    job.progress.elapsedMs = Date.now() - started;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (job.cancelled) {
    job.state = "cancelled";
    return;
  }
  for (const row of rows)
    if (!row.exemplarId && audioHashes.has(row.noteId))
      row.audioFingerprint = audioHashes.get(row.noteId).copy().digest("hex");
  const profiles = database
    .getSpeakerProfiles(true, { includeProvisional: true })
    .filter((p) => p.embedding?.length)
    .map((p) => ({ id: p.id, name: p.display_name, vector: vectorOf(p.embedding) }))
    .sort((a, b) => a.id - b.id);
  job.report = buildReport({
    rows: rows.filter((row) => row.vector),
    profiles,
    scope,
    modelFingerprint,
    exclusions,
    bytesRead: job.progress.bytesRead,
    reviewedCount,
    consideredCount,
    rowBudget: budget.rows,
    noteBudget: budget.notes,
    selectedNotes,
    placementCounts: {
      exact: rows.filter((row) => row.playbackPlaceable && !row.approximate).length,
      approximate: rows.filter((row) => row.playbackPlaceable && row.approximate).length,
      unavailable: rows.filter((row) => !row.playbackPlaceable).length,
    },
    embeddingCounts: { embedded: job.progress.reembeddedRows, refused: exclusions.length },
    missingVectorDiagnostics,
    noteCentroidCompletions,
    noteEmbeddingFingerprints,
  });
  job.progress.elapsedMs = Date.now() - started;
  job.state = "complete";
}
async function reportStillCurrent(
  report,
  database,
  audioStore,
  model = require("./speakerEmbeddings")
) {
  if (!report?.evidence?.revisions || !report?.fingerprints) return false;
  if (!model.isAvailable()) return false;
  const modelHash = createHash("sha256");
  for await (const chunk of require("node:fs").createReadStream(model.getModelPath()))
    modelHash.update(chunk);
  if (modelHash.digest("hex") !== report.fingerprints.model) return false;
  const profiles = database
    .getSpeakerProfiles(true, { includeProvisional: true })
    .filter((p) => p.embedding?.length)
    .map((p) => ({ id: p.id, name: p.display_name, vector: vectorOf(p.embedding) }))
    .sort((a, b) => a.id - b.id);
  if (
    sha(JSON.stringify(profiles.map((profile) => [profile.id, profile.name, profile.vector]))) !==
    report.fingerprints.profiles
  )
    return false;
  for (const [noteId, fingerprint] of Object.entries(report.fingerprints.noteEmbeddings || {})) {
    if (
      noteEmbeddingsFingerprint(database.getNoteSpeakerEmbeddings(Number(noteId))) !== fingerprint
    )
      return false;
  }
  const notes = new Map();
  for (const { noteId, rowId, revision, exemplarId, contentHash } of report.evidence.revisions) {
    if (exemplarId) {
      const sample = database.getVoiceExemplarAudio?.().find((item) => item.id === exemplarId);
      if (
        !sample ||
        sample.revision !== revision ||
        sample.content_hash !== contentHash ||
        require("./voiceExemplarAudio").play(database.db, audioStore, exemplarId)?.state !==
          "available"
      )
        return false;
      continue;
    }
    if (!notes.has(noteId)) {
      const note = database.getNote(noteId);
      if (!note || note.deleted_at) return false;
      notes.set(
        noteId,
        new Map(readTranscriptDocument(note.transcript).rows.map((row) => [row.id, row]))
      );
      if (report.fingerprints.recordings?.[noteId] != null) {
        const status = audioStore.status(noteId);
        if (
          !["complete", "incomplete"].includes(status.state) ||
          status.recordingId !== report.fingerprints.recordings[noteId] ||
          sha(JSON.stringify(status.tracks || {})) !== report.fingerprints.audioManifests?.[noteId]
        )
          return false;
      }
    }
    const row = notes.get(noteId).get(rowId);
    if (!row || sha(JSON.stringify(row)) !== revision) return false;
  }
  return true;
}
module.exports = { buildReport, collectRows, runJob, reportStillCurrent };
