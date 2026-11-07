const { createHash, randomUUID } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");
const { buildCalibrationLabels } = require("./speakerCalibrationExport");
const { classifyEvidence } = require("./voiceRecordingIdentity");
const {
  admitRecommendation,
  RECOMMENDATION_POLICY,
  evidenceFingerprintKey,
  fingerprintIntegrity,
  validRowEvidence,
} = require("./speakerCalibrationPolicy");
const { completionDiagnostic } = require("./speakerCompletionDiagnostic");
const { windowExclusion, measurementInterval, pcm16Samples } = require("./calibrationEvidenceWindow");

const rowExclusion = (row, reason, extra = {}) => ({
  noteId: row.noteId,
  rowId: row.rowId,
  ...(row.exemplarId ? { exemplarId: row.exemplarId } : {}),
  evidenceKey: evidenceFingerprintKey(row),
  reason,
  ...extra,
});

const sha = (value) => createHash("sha256").update(value).digest("hex");
const clusterKey = (row) => JSON.stringify([row.noteId, row.clusterId]);
function reviewedClusterMembership(rows) {
  const clusters = new Map();
  for (const row of rows) {
    if (row.exemplarId) continue;
    const key = clusterKey(row);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push([row.rowId, row.truePerson]);
  }
  return Object.fromEntries(
    [...clusters]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, members]) => [
        key,
        members.sort(([a], [b]) => String(a).localeCompare(String(b))),
      ])
  );
}
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
  generatedAt = new Date().toISOString(),
  synthetic = false,
  validationEvidence = null,
  policy = RECOMMENDATION_POLICY,
}) {
  // Expand legacy row-wide/cluster exclusions into explicit evidence records.
  // An evidence-keyed failure affects only that clip or reconstructed interval.
  exclusions = exclusions.flatMap((item) =>
    rows
      .filter((row) =>
        item.evidenceKey
          ? evidenceFingerprintKey(row) === item.evidenceKey
          : item.rowId != null
            ? row.noteId === item.noteId &&
              row.rowId === item.rowId &&
              (item.exemplarId == null || row.exemplarId === item.exemplarId)
            : item.cluster === JSON.stringify([row.noteId, row.clusterId]) ||
              item.cluster === `${row.noteId}:${row.clusterId}`
      )
      .map((row) => rowExclusion(row, item.reason, item.cluster ? { cluster: item.cluster } : {}))
  );
  const savedExemplars = rows.filter((row) => row.exemplarId).length;
  const timingProvenanceCounts = {};
  const excludedRows = new Set(
    exclusions.filter((item) => item.rowId != null).map((item) => item.evidenceKey)
  );
  for (const row of rows) {
    const provenance = row.timingProvenance || "unavailable";
    timingProvenanceCounts[provenance] = (timingProvenanceCounts[provenance] || 0) + 1;
    const reason =
      windowExclusion(row) ||
      (row.vectorSource === "stored-centroid-current-profiles"
        ? "bounded_vector_unavailable"
        : null);
    const key = evidenceFingerprintKey(row);
    if (reason && !excludedRows.has(key)) {
      exclusions.push(rowExclusion(row, reason));
      excludedRows.add(key);
    }
  }
  rows = rows.filter((row) => row.vector && !excludedRows.has(evidenceFingerprintKey(row)));
  // Conflicts remove every member before counts, hashes or admission are built.
  const byCluster = new Map();
  for (const row of rows.filter((item) => !item.exemplarId)) {
    const key = clusterKey(row);
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(row);
  }
  const conflicting = new Set();
  for (const [cluster, members] of byCluster) {
    if (new Set(members.map((row) => row.truePerson)).size <= 1) continue;
    for (const row of members) {
      conflicting.add(row);
      exclusions.push(rowExclusion(row, "conflicting_reviewed_labels", { cluster }));
    }
  }
  rows = rows.filter((row) => !conflicting.has(row));
  byCluster.clear();
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
  for (const members of byCluster.values()) clusters.push(members[0]);
  const calibration = sweep([...clusters, ...reconstructedRows], profiles, "vector");
  const people = new Set(rows.map((row) => row.truePerson).filter(Boolean));
  const notes = new Set(rows.map((row) => row.noteId));
  const claims = rows.filter((row) => row.machineLabel).length;
  const profileFingerprint = sha(
    JSON.stringify(profiles.map((profile) => [profile.id, profile.name, profile.vector]))
  );
  const audioFingerprints = Object.fromEntries(
    rows
      .filter((row) => row.verifiedAudioFingerprint)
      .map((row) => [evidenceFingerprintKey(row), row.verifiedAudioFingerprint])
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
    evidenceKey: evidenceFingerprintKey(row),
    audioFingerprint: row.audioFingerprint,
    track: row.track ?? null,
    start: row.start,
    end: row.end,
    from: row.from,
    to: row.to,
    timingProvenance: row.timingProvenance,
    vectorSource: row.vectorSource ?? null,
    ...(row.exemplarId ? { exemplarId: row.exemplarId, contentHash: row.contentHash } : {}),
  }));
  const admission = admitRecommendation({
    rows,
    profiles,
    synthetic,
    modelFingerprint,
    profileFingerprint,
    audioFingerprints,
    analysis: calibration,
    validationEvidence,
    policy,
  });
  const resultType = admission.failedCriteria.length
    ? "diagnostic_only"
    : "supported_recommendation";
  const calibrationStatus =
    resultType === "supported_recommendation" ? "calibrated" : "uncalibrated";
  const calibrationReason = admission.failedCriteria.join("; ");
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
  const unavailableInVersion =
    validationEvidence == null
      ? admission.failedCriteria.filter((key) =>
          [
            "production_parity",
            "independent_sessions",
            "positive_coverage",
            "negative_coverage",
            "nonempty_accepted_set",
            "correct_name_coverage",
            "precision",
          ].includes(key)
        )
      : [];
  return {
    version: 3,
    resultType,
    ...admission,
    criteriaGroups: {
      unavailableInVersion,
      evidenceLimits: admission.failedCriteria.filter((key) => !unavailableInVersion.includes(key)),
    },
    nextAction: null,
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
      exactClusters: clusters.length,
      calibrationRows: calibration.rows,
      storedRows: storedRows.length,
      savedExemplars,
      exemplarRows,
      reconstructedRows: reconstructedRows.length,
      reviewedCandidates: reviewedCount,
      consideredRows: consideredCount,
      rowBudget,
      noteBudget,
      selectedNotes,
      truncatedByRowBudget: consideredCount < reviewedCount,
      audioFingerprintScope: "row",
      fingerprintIntegrity: [
        ...fingerprintIntegrity(rows, audioFingerprints),
        ...exclusions.filter((item) => item.reason === "exemplar_integrity_failed"),
      ],
      timingProvenanceCounts,
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
      bytesRead,
      revisions,
      // A serialized snapshot avoids rebuilding another row-sized object graph
      // on the main thread when the worker delivers a large report.
      reviewedClusterMembership: JSON.stringify(reviewedClusterMembership(rows)),
      exclusions: allExclusions,
    },
    fingerprints: {
      model: modelFingerprint,
      profiles: profileFingerprint,
      audio: audioFingerprints,
      recordings,
      audioManifests,
      // The bounded sweep never consumes note-cluster centroids.
      noteEmbeddings: {},
    },
    analyses: {
      calibration: {
        label: "people.calibrationDiagnosticSweep",
        ...calibration,
      },
    },
    support,
    recommended,
  };
}
function collectRows(database, audioStore, scope, budget, onProgress = () => {}) {
  const db = database.db;
  const selectedOrigins = new Set();
  const selectOrigin = (key) => {
    if (selectedOrigins.has(key)) return true;
    if (selectedOrigins.size >= budget.notes) return false;
    selectedOrigins.add(key);
    return true;
  };
  // Every existing approval suppresses its transcript fallback, including an
  // ineligible approval. Otherwise an excluded vector can re-enter as a centroid.
  const approvedEvidence = database.getVoiceExemplarAudio
    ? require("./voiceEnrollment").samples(db)
    : [];
  const provenanceBySample = new Map();
  const classifySample = (sample) => {
    if (!provenanceBySample.has(sample.id))
      provenanceBySample.set(sample.id, classifyEvidence(db, sample));
    return provenanceBySample.get(sample.id);
  };
  const suppresses = require("./calibrationEvidenceIndex").evidenceIndex(
    approvedEvidence,
    classifySample
  );
  const provenanceByNote = new Map();
  const classifyNote = (note) => {
    if (!provenanceByNote.has(note.id))
      provenanceByNote.set(
        note.id,
        classifyEvidence(
          db,
          { note_id: note.id, note_identity: note.client_note_id },
          { store: audioStore }
        )
      );
    return provenanceByNote.get(note.id);
  };
  const exemplars = approvedEvidence.filter(
    (sample) =>
      sample.durable_audio &&
      classifySample(sample).state === "resolved" &&
      sample.valid !== 0 &&
      (scope.kind !== "range" ||
        (sample.meeting_date?.slice(0, 10) >= scope.from &&
          sample.meeting_date?.slice(0, 10) <= scope.to)) &&
      selectOrigin(classifySample(sample).recordingId)
  );
  const where = scope.kind === "range" ? " AND date(created_at) BETWEEN date(?) AND date(?)" : "";
  const chosen = db
    .prepare(
      `SELECT id, client_note_id, transcript, speaker_action_log, created_at FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL AND transcript IS NOT NULL${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...(scope.kind === "range" ? [scope.from, scope.to] : []), budget.notes)
    .filter((note) => selectOrigin(classifyNote(note).recordingId ?? null));
  const rows = [],
    exclusions = [],
    missingVectorDiagnostics = [],
    noteCentroidCompletions = [];
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
      track: sample.track,
      start: sample.start_sample / 24000,
      end: sample.end_sample / 24000,
      contentHash: sample.content_hash,
      truePerson: person.display_name,
      recordingId: classifySample(sample).recordingId,
      clusterId: `exemplar:${sample.id}`,
      vector: vectorOf(sample.embedding),
      vectorSource: "approved-exemplar",
      audioFingerprint: sample.content_hash,
      playbackPlaceable: true,
      audioAvailable: true,
      audioState: "available",
      approximate: false,
      timingProvenance: "retained_exemplar_clip",
    });
  }
  for (const note of chosen) {
    const status = audioStore.status(note.id);
    const provenance = classifyNote(note);
    if (status.state === "recording") continue;
    const labels = buildCalibrationLabels(note, {}, status).rows;
    const noteEmbeddings = database.getNoteSpeakerEmbeddings(note.id);
    const vectors = new Map(
      noteEmbeddings.map((item) => [String(item.speaker_id), vectorOf(item.embedding)])
    );
    const completion = database.getNoteSpeakerCompletion?.(note.id);
    const completionDisplay = completionDiagnostic(note.id, completion);
    if (completion)
      noteCentroidCompletions.push({
        noteId: note.id,
        clusters: completionDisplay.clusters,
        vectorsWritten: completionDisplay.vectorsWritten,
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
      if (suppresses(note, provenance, label)) continue;
      if (
        !row ||
        row.deleted ||
        !row.speakerName ||
        !(row.speakerLockSource === "user" || reviewedIds.has(row.id))
      )
        continue;
      reviewedCount++;
      if (rows.length >= budget.rows) continue;
      const vector = provenance.state === "resolved" ? vectors.get(String(row.speaker)) : null;
      if (!vector) {
        const diagnostic = completionDiagnostic(note.id, completion, vectors.size > 0);
        if (
          !missingVectorDiagnostics.some(
            (item) => item.noteId === note.id && item.reason === diagnostic.reason
          )
        ) {
          missingVectorDiagnostics.push(diagnostic);
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
        retainedTrack: status.tracks?.[label.track],
        playbackUnavailableReason: label.unavailableReason,
        playbackPlaceable: !label.unavailableReason,
        approximate: label.approximate,
        timingProvenance: label.timingProvenance,
        audioFingerprint: null,
        recordingId: provenance.recordingId,
        audioManifestFingerprint: sha(JSON.stringify(status.tracks || {})),
        audioAvailable:
          provenance.state === "resolved" && ["complete", "incomplete"].includes(status.state),
        audioState: status.state,
      });
    }
    if (
      rows.length > rowsBeforeNote &&
      completion?.cause &&
      !missingVectorDiagnostics.some((item) => item.noteId === note.id)
    )
      missingVectorDiagnostics.push(completionDisplay);
    onProgress(rows.length);
  }
  return {
    rows,
    exclusions,
    reviewedCount,
    consideredCount: rows.length,
    selectedNotes: selectedOrigins.size,
    missingVectorDiagnostics,
    noteCentroidCompletions,
  };
}
function pcm16FromWav(wav) {
  const data = wav.indexOf(Buffer.from("data"));
  if (data < 0) throw Error("Missing WAV data");
  const sampleRate = wav.readUInt32LE(24);
  const count = Math.floor(wav.readUInt32LE(data + 4) / 2);
  return pcm16Samples(wav.subarray(data + 8, data + 8 + count * 2), sampleRate);
}
// Freshness measures newly selected siblings with exactly the same eligibility
// rules as report generation. Failed/unbounded evidence cannot decide conflicts.
async function measureBoundedRow(row, audioStore, model, modelFingerprint, signal) {
  const windowReason = windowExclusion(row);
  if (windowReason) return { reason: windowReason };
  if (!row.audioAvailable) return { reason: `audio_${row.audioState}` };
  if (!modelFingerprint) return { reason: "speaker_model_unavailable" };
  const { from, to } = measurementInterval(row);
  const args = [row.noteId, row.track, from, to];
  const span = audioStore.spanAsync
    ? await audioStore.spanAsync(...args, { signal })
    : audioStore.span(...args);
  if (!span.wav) return { reason: `audio_${span.state}` };
  const bytesRead = span.bytesRead ?? span.wav.length;
  if (span.partial) return { reason: "audio_partial", bytesRead };
  // Hash precisely these WAV bytes, never an aggregate of other rows.
  row.audioFingerprint = sha(span.wav);
  row.verifiedAudioFingerprint = row.audioFingerprint;
  let reconstructedVector = [];
  try {
    reconstructedVector = Array.from(
      (await model.extractEmbeddingFromSamples(pcm16FromWav(span.wav))) || []
    );
  } catch {
    // An extraction failure cannot make the old centroid eligible.
  }
  if (!reconstructedVector.length || !reconstructedVector.every(Number.isFinite))
    return { reason: "embedding_unavailable", bytesRead };
  row.vector = reconstructedVector;
  row.vectorSource = "reconstructed-row-audio";
  return { bytesRead };
}
async function runJobLocal(
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
  } = collectRows(database, audioStore, scope, budget, (totalRows) => {
    job.progress.totalRows = totalRows;
    job.onProgress?.();
  });
  job.progress.totalRows = rows.length;
  let modelFingerprint = null;
  if (model.isAvailable()) {
    const hash = createHash("sha256");
    for await (const chunk of require("node:fs").createReadStream(model.getModelPath()))
      hash.update(chunk);
    modelFingerprint = hash.digest("hex");
  }
  // Group spans by source so the session can discard each recording's cache
  // after its last row. Admission still sees the original evidence order.
  const work = [...rows].sort(
    (a, b) =>
      a.noteId - b.noteId || String(a.track).localeCompare(String(b.track)) || a.from - b.from
  );
  for (const row of work) {
    if (job.cancelled) {
      job.state = "cancelled";
      return;
    }
    if (row.exemplarId) {
      const audio = require("./voiceExemplarAudio").play(database.db, audioStore, row.exemplarId);
      if (
        audio?.state !== "available" ||
        classifyEvidence(database.db, { id: row.exemplarId }).state !== "resolved"
      ) {
        row.vector = null;
        exclusions.push(rowExclusion(row, audio?.error || "audio_unavailable"));
      } else {
        row.verifiedAudioFingerprint = sha(audio.wav);
        job.progress.bytesRead += audio.wav.length;
      }
    } else {
      const measured = await measureBoundedRow(
        row,
        audioStore,
        model,
        modelFingerprint,
        job.abortController?.signal
      );
      job.progress.bytesRead += measured.bytesRead || 0;
      if (measured.reason) exclusions.push(rowExclusion(row, measured.reason));
      else job.progress.reembeddedRows++;
    }
    job.progress.processedRows++;
    job.progress.elapsedMs = Date.now() - started;
    job.onProgress?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (job.cancelled) {
    job.state = "cancelled";
    return;
  }
  const profiles = database
    .getSpeakerProfiles(true, { includeProvisional: true })
    .filter((p) => p.embedding?.length)
    .map((p) => ({ id: p.id, name: p.display_name, vector: vectorOf(p.embedding) }))
    .sort((a, b) => a.id - b.id);
  job.report = buildReport({
    rows,
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
  });
  job.progress.elapsedMs = Date.now() - started;
  job.state = "complete";
}
async function reportStillCurrentLocal(
  report,
  database,
  audioStore,
  model = require("./speakerEmbeddings")
) {
  if (report?.version !== 3 || !validRowEvidence(report.evidence, report.fingerprints))
    return false;
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
  const exemplars = new Map(
    (database.getVoiceExemplarAudio?.() || []).map((item) => [item.id, item])
  );
  for (const evidence of report.evidence.revisions) {
    const { noteId, rowId, revision, exemplarId, contentHash } = evidence;
    if (exemplarId) {
      const sample = exemplars.get(exemplarId);
      const playback =
        sample && require("./voiceExemplarAudio").play(database.db, audioStore, exemplarId);
      if (
        !sample ||
        classifyEvidence(database.db, sample).state !== "resolved" ||
        sample.revision !== revision ||
        sample.content_hash !== contentHash ||
        playback?.state !== "available" ||
        !playback.wav ||
        sha(playback.wav) !== evidence.audioFingerprint
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
          classifyEvidence(
            database.db,
            { note_id: noteId, note_identity: note.client_note_id },
            { store: audioStore }
          ).recordingId !== report.fingerprints.recordings[noteId] ||
          sha(JSON.stringify(status.tracks || {})) !== report.fingerprints.audioManifests?.[noteId]
        )
          return false;
      }
    }
    const row = notes.get(noteId).get(rowId);
    if (!row || sha(JSON.stringify(row)) !== revision) return false;
    const { from, to } = measurementInterval(evidence);
    const args = [noteId, evidence.track, from, to];
    const span = audioStore.spanAsync
      ? await audioStore.spanAsync(...args)
      : audioStore.span(...args);
    if (!span?.wav || span.partial || sha(span.wav) !== evidence.audioFingerprint) return false;
  }
  if (typeof report.evidence.reviewedClusterMembership !== "string") return false;
  // Bind every included transcript row exactly once without duplicating its
  // cluster/label in the already large revision list sent back by the worker.
  let savedMembership, membershipRows;
  try {
    savedMembership = JSON.parse(report.evidence.reviewedClusterMembership);
    membershipRows = Object.entries(savedMembership).flatMap(([cluster, members]) => {
      const [noteId] = JSON.parse(cluster);
      return members.map(([rowId]) => JSON.stringify([noteId, rowId]));
    }).sort();
  } catch {
    return false;
  }
  const includedRows = report.evidence.revisions
    .filter((row) => !row.exemplarId)
    .map((row) => JSON.stringify([row.noteId, row.rowId]))
    .sort();
  if (JSON.stringify(membershipRows) !== JSON.stringify(includedRows)) return false;
  if (savedMembership && Object.keys(savedMembership).length) {
    // Replay scope, budgets, review selection and exemplar suppression. Only
    // clusters that contributed evidence can make this report stale.
    const selected = collectRows(database, audioStore, report.scope, {
      rows: report.evidence.rowBudget,
      notes: report.evidence.noteBudget,
    }).rows;
    const members = [];
    const included = new Map(
      report.evidence.revisions
        .filter((row) => !row.exemplarId)
        .map((row) => [JSON.stringify([row.noteId, row.rowId]), row])
    );
    for (const row of selected) {
      if (row.exemplarId || !Object.hasOwn(savedMembership, clusterKey(row))) continue;
      const saved = included.get(JSON.stringify([row.noteId, row.rowId]));
      if (saved) {
        // The bytes/model/revision were verified above. Re-resolving can still
        // change the measurement window when an adjacent transcript row changes.
        if (
          windowExclusion(row) ||
          !row.audioAvailable ||
          ["revision", "track", "start", "end", "from", "to", "timingProvenance"].some(
            (key) => row[key] !== saved[key]
          )
        )
          return false;
        members.push(row);
        continue;
      }
      const measured = await measureBoundedRow(row, audioStore, model, report.fingerprints.model);
      if (!measured.reason) members.push(row);
    }
    // A new conflicting label cannot equal the saved uniform membership; the
    // same pre-conflict eligibility filter is used by buildReport above.
    if (
      JSON.stringify(reviewedClusterMembership(members)) !== report.evidence.reviewedClusterMembership
    )
      return false;
  }
  return true;
}
async function runJob(job, database, audioStore, scope, budget, model, options) {
  // Small in-memory unit fixtures can use the local engine. The app always
  // supplies a file-backed database and runs every phase outside the main thread.
  if (database.db?.name && database.db.name !== ":memory:" && audioStore.root)
    return require("./calibrationWorkerClient").run(
      job,
      database,
      audioStore,
      scope,
      budget,
      model,
      options
    );
  return runJobLocal(job, database, audioStore, scope, budget, model);
}
async function reportStillCurrent(report, database, audioStore, model, options = {}) {
  if (database.db?.name && database.db.name !== ":memory:" && audioStore.root) {
    const marker = () =>
      `${database.db.prepare("SELECT total_changes() AS n").get().n}:${database.db.pragma("data_version", { simple: true })}`;
    const before = marker();
    const job = { state: "running", progress: {} };
    await require("./calibrationWorkerClient").run(job, database, audioStore, null, null, model, {
      ...options,
      validateReport: report,
    });
    return job.validationCurrent && before === marker();
  }
  return reportStillCurrentLocal(report, database, audioStore, model);
}
module.exports = {
  buildReport,
  collectRows,
  runJob,
  runJobLocal,
  reportStillCurrent,
  reportStillCurrentLocal,
};
