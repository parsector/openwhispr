const { createHash, randomUUID } = require("node:crypto");
const { readTranscriptDocument } = require("./transcriptDocument");
const { readSpeakerActionLog } = require("./speakerActionLog");
const { buildCalibrationLabels } = require("./speakerCalibrationExport");

const sha = (value) => createHash("sha256").update(value).digest("hex");
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
  generatedAt = new Date().toISOString(),
  synthetic = false,
}) {
  const byCluster = new Map();
  for (const row of rows.filter((item) => item.vector)) {
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
  if (exact.rows < 12) missing.push("Need twelve consistent stored clusters");
  if (Object.keys(audioFingerprints).length !== notes.size)
    missing.push("Need retained-audio fingerprints for every included note");
  if (!/^[a-f0-9]{64}$/.test(modelFingerprint || ""))
    missing.push("Speaker model fingerprint unavailable");
  const exactStatus = gate && exact.rows >= 12 ? "calibrated" : "uncalibrated";
  const exactReason = exactStatus === "calibrated" ? undefined : missing.join("; ");
  const support = {
    similarityFloor: {
      status: exactStatus,
      method: "exact",
      rows: exact.rows,
      machineClaims: claims,
      ...(exactReason ? { reason: exactReason } : {}),
    },
    runnerUpMargin: {
      status: exactStatus,
      method: "exact",
      rows: exact.rows,
      machineClaims: claims,
      ...(exactReason ? { reason: exactReason } : {}),
    },
    minimumVoicedSeconds: {
      status: "uncalibrated",
      reason:
        "The production gate used matched diarization-turn duration, which was not stored. Need those original turns and durations.",
    },
    overlapToleranceSeconds: {
      status: "uncalibrated",
      reason:
        "The stored overlap flag is one outcome at one tolerance. Need original overlap intervals or exactly reproducible diarization evidence.",
    },
  };
  const recommended = Object.fromEntries(
    ["similarityFloor", "runnerUpMargin"]
      .filter((key) => support[key].status === "calibrated")
      .map((key) => [key, exact.winner[key]])
  );
  return {
    version: 2,
    id: randomUUID(),
    synthetic,
    method: "stored-centroid-current-profiles",
    generatedAt,
    scope,
    evidence: {
      notes: notes.size,
      reviewedRows: rows.length,
      distinctPeople: people.size,
      machineClaims: claims,
      exactClusters: exact.rows,
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
    },
    analyses: {
      exact: { label: "Measured against your profiles as they are today", ...exact },
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
  const where = scope.kind === "range" ? " AND date(created_at) BETWEEN date(?) AND date(?)" : "";
  const chosen = db
    .prepare(
      `SELECT id, transcript, speaker_action_log, created_at FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL AND transcript IS NOT NULL${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...(scope.kind === "range" ? [scope.from, scope.to] : []), budget.notes);
  const rows = [],
    exclusions = [];
  for (const note of chosen) {
    const status = audioStore.status(note.id);
    if (status.state === "recording") continue;
    const labels = buildCalibrationLabels(note, {}, status).rows;
    const vectors = new Map(
      database
        .getNoteSpeakerEmbeddings(note.id)
        .map((item) => [String(item.speaker_id), vectorOf(item.embedding)])
    );
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
    for (const label of labels) {
      if (rows.length >= budget.rows) break;
      const row = transcriptRows.get(label.rowId);
      if (
        !row ||
        row.deleted ||
        !row.speakerName ||
        !(row.speakerLockSource === "user" || reviewedIds.has(row.id))
      )
        continue;
      const vector = vectors.get(String(row.speaker));
      if (!vector) {
        exclusions.push({ noteId: note.id, rowId: row.id, reason: "stored_centroid_missing" });
        continue;
      }
      rows.push({
        noteId: note.id,
        rowId: row.id,
        revision: sha(JSON.stringify(row)),
        truePerson: row.speakerName,
        machineLabel: label.machineLabel,
        clusterId: String(row.speaker),
        vector,
        track: label.track,
        start: label.start,
        end: label.end,
        approximate: label.approximate,
        audioFingerprint: null,
        recordingId: status.recordingId,
        audioManifestFingerprint: sha(JSON.stringify(status.tracks || {})),
        audioAvailable: ["complete", "incomplete"].includes(status.state),
      });
    }
    if (rows.length >= budget.rows) break;
  }
  return { rows, exclusions };
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
  const { rows, exclusions } = collectRows(database, audioStore, scope, budget);
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
    if (
      !row.audioAvailable ||
      row.approximate ||
      !Number.isFinite(row.end) ||
      row.end - row.start < 1.5
    ) {
      exclusions.push({
        noteId: row.noteId,
        rowId: row.rowId,
        reason: "audio_or_exact_span_unavailable",
      });
    } else if (!modelFingerprint) {
      exclusions.push({
        noteId: row.noteId,
        rowId: row.rowId,
        reason: "speaker_model_unavailable",
      });
    } else {
      const span = audioStore.span(
        row.noteId,
        row.track,
        Math.max(row.start, row.end - 8),
        row.end
      );
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
          if (row.liveVector.length) job.progress.reembeddedRows++;
          else
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
    if (audioHashes.has(row.noteId))
      row.audioFingerprint = audioHashes.get(row.noteId).copy().digest("hex");
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
  const notes = new Map();
  for (const { noteId, rowId, revision } of report.evidence.revisions) {
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
