// Voice evidence is local and opt-in. Only this module promotes approved audio
// to a usable profile; naming a row never calls it.
const { randomUUID, createHash } = require('node:crypto');
const { readTranscriptDocument } = require('./transcriptDocument');
const history = require('./speakerGlobalHistory');

const RATE = 24000;
const MODEL_RATE = 16000;
const MIN_SPANS = 3;
const MIN_MEETINGS = 2;
const MAX_SAMPLES = 20;
// These are uncalibrated guards, not thresholds measured on owner-labelled audio.
const calibration = Object.freeze({
  ownSimilarity: { value: 0.65, status: 'uncalibrated' },
  minRms: { value: 0.01, status: 'uncalibrated' },
  clippingFraction: { value: 0.01, status: 'uncalibrated' },
  echoCorrelation: { value: 0.88, status: 'uncalibrated' },
});
const MIN_OWN_SIMILARITY = calibration.ownSimilarity.value;
const played = new Map();
function stopObserving(session) {
  if (session?.sender && session.audioListener) {
    session.sender.off('audio-state-changed', session.audioListener);
    session.audioListener = null;
  }
}
function forgetPlayback(id) {
  stopObserving(played.get(id));
  played.delete(id);
}

const vector = bytes => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const packed = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
function unit(values) {
  const norm = Math.hypot(...values);
  return norm ? Float32Array.from(values, value => value / norm) : null;
}
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
function rowsFor(db, noteId) {
  const note = db.prepare('SELECT transcript FROM notes WHERE id = ?').get(noteId);
  return note ? readTranscriptDocument(note.transcript).rows : [];
}
function attributed(db, noteId, row, profileId) {
  if (row.suggestedProfileId === profileId) return true;
  if (row.speakerLockSource === 'user' && row.suggestedProfileId == null) return false;
  if (row.diarizationRunId && db.prepare(`SELECT 1 FROM speaker_run_mappings
    WHERE note_id = ? AND run_id = ? AND cluster_id = ? AND profile_id = ?`).get(
      noteId, row.diarizationRunId, row.speaker, profileId)) return true;
  return !!db.prepare(`SELECT 1 FROM speaker_mappings
    WHERE note_id = ? AND speaker_id = ? AND profile_id = ?`).get(noteId, row.speaker, profileId);
}
function clean(db, sample) {
  const rows = rowsFor(db, sample.note_id);
  const ids = JSON.parse(sample.row_ids || '[]');
  return ids.length > 0 && ids.every(id => {
    const row = rows.find(item => item.id === id);
    return row && !row.deleted && !(row.corrections || []).some(item => !item.initialAttribution) &&
      !Number(row.correctionRevision) && attributed(db, sample.note_id, row, sample.profile_id);
  });
}
function samples(db, profileId) {
  return db.prepare('SELECT * FROM voice_exemplars WHERE profile_id = ? AND approved_at IS NOT NULL ORDER BY approved_at, id')
    .all(profileId);
}
function state(db, profileId) {
  const all = samples(db, profileId);
  const good = all.filter(sample => sample.embedding?.length === 2048 && clean(db, sample));
  const vectors = good.map(sample => unit(vector(sample.embedding)));
  const conflict = vectors.some((left, i) => !left || vectors.some((right, j) => j > i && (!right || cosine(left, right) < MIN_OWN_SIMILARITY)));
  const meetings = new Set(good.map(sample => sample.note_id)).size;
  // Graduation rule: three uncorrected, internally consistent approved spans
  // from at least two recordings. A correction to any contributing row demotes.
  const requiresReview = !!db.prepare('SELECT voice_needs_reapproval FROM speaker_profiles WHERE id = ?')
    .get(profileId)?.voice_needs_reapproval;
  const usable = good.length >= MIN_SPANS && meetings >= MIN_MEETINGS && !conflict &&
    good.length === all.length && !requiresReview;
  return { cleanSpans: good.length, meetings, approvedSpans: all.length, conflict, usable,
    requiresReview, vectors: conflict ? [] : vectors, good };
}
function progress(database, profileId) {
  const { cleanSpans, meetings, approvedSpans, conflict, usable } = state(database.db, profileId);
  return { cleanSpans, meetings, approvedSpans, conflict, usable,
    requiredSpans: MIN_SPANS, requiredMeetings: MIN_MEETINGS };
}
function listSamples(database, profileId) {
  const db = database.db;
  const all = samples(db, profileId);
  const vectors = all.map(sample => sample.embedding?.length === 2048 ? unit(vector(sample.embedding)) : null);
  const averages = vectors.map((value, i) => value && vectors.length > 1
    ? vectors.reduce((sum, other, j) => sum + (i !== j && other ? cosine(value, other) : 0), 0) / (vectors.length - 1)
    : 1);
  const worst = Math.min(...averages.filter(value => value != null));
  const conflict = state(db, profileId).conflict;
  return all.map((sample, i) => ({ id: sample.id, profileId, noteId: sample.note_id,
    noteTitle: db.prepare('SELECT title FROM notes WHERE id = ?').get(sample.note_id)?.title || '',
    rowIds: JSON.parse(sample.row_ids || '[]'), meetingDate: sample.meeting_date,
    durationSeconds: (sample.end_sample - sample.start_sample) / RATE,
    odd: !clean(db, sample) || conflict && (vectors.length <= 2 || averages[i] === worst) }));
}
function rebuild(db, profileId) {
  const result = state(db, profileId);
  let embedding = Buffer.alloc(0);
  if (result.vectors.length && result.good.length === result.approvedSpans) {
    // One vote per meeting, then equal weight for each meeting. Duration has
    // no weight; an eight second span cannot drown out a short one.
    const grouped = new Map();
    result.good.forEach((sample, i) => {
      if (!grouped.has(sample.note_id)) grouped.set(sample.note_id, []);
      grouped.get(sample.note_id).push(result.vectors[i]);
    });
    const meetingVectors = [...grouped.values()].map(items => unit(Float32Array.from(
      { length: 512 }, (_, i) => items.reduce((sum, item) => sum + item[i], 0) / items.length)));
    const centroid = unit(Float32Array.from({ length: 512 }, (_, i) =>
      meetingVectors.reduce((sum, item) => sum + item[i], 0) / meetingVectors.length));
    if (centroid) embedding = packed(centroid);
  }
  db.prepare('UPDATE speaker_profiles SET embedding = ?, sample_count = ?, voice_usable = ?, voice_needs_reapproval = ? WHERE id = ?')
    .run(embedding, result.cleanSpans, Number(result.usable),
      Number(result.requiresReview || result.conflict || result.good.length !== result.approvedSpans), profileId);
  return result;
}
function candidateId(profileId, noteId, rowId, span) {
  return createHash('sha256').update(JSON.stringify([profileId, noteId, rowId, span.trackId,
    span.startSample, span.endSample])).digest('hex');
}
function listCandidates(database, store, profileId) {
  const db = database.db;
  if (!db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(profileId)) return [];
  if (samples(db, profileId).length >= MAX_SAMPLES) return [];
  const offered = [];
  for (const note of db.prepare("SELECT id, title, created_at, transcript FROM notes WHERE note_type = 'meeting' AND deleted_at IS NULL").all()) {
    const audioState = store.status(note.id);
    if (!['complete', 'incomplete'].includes(audioState.state) || audioState.bytes === 0) continue;
    const rows = readTranscriptDocument(note.transcript).rows;
    for (const row of rows) {
      const span = row.audioSpan;
      if (row.deleted || (row.corrections || []).some(item => !item.initialAttribution) || Number(row.correctionRevision) ||
        row.uncertainty || row.overlap || row.speakerStatus === 'provisional' ||
        row.speakerStatus === 'suggested' ||
        !attributed(db, note.id, row, profileId) ||
        !span || span.recordingId !== (audioState.recordingId ?? note.id) ||
        !['mic', 'system'].includes(span.trackId)) continue;
      const overlapsOtherVoice = rows.some(other => other !== row && !other.deleted &&
        other.speaker !== row.speaker && other.audioSpan?.trackId === span.trackId &&
        other.audioSpan?.startSample < span.endSample && other.audioSpan?.endSample > span.startSample);
      if (overlapsOtherVoice) continue;
      // Exclude the first and last 250 ms around a transcript boundary.
      const startSample = span.startSample + RATE / 4;
      const endSample = span.endSample - RATE / 4;
      const duration = (endSample - startSample) / RATE;
      if (duration < 3 || duration > 8) continue;
      const trimmed = { ...span, startSample, endSample };
      const id = candidateId(profileId, note.id, row.id, trimmed);
      const overlapsApproved = db.prepare(`SELECT 1 FROM voice_exemplars
        WHERE profile_id = ? AND note_id = ? AND track = ?
          AND start_sample < ? AND end_sample > ?`).get(
            profileId, note.id, span.trackId, endSample, startSample);
      if (overlapsApproved) continue;
      const spanKey = [profileId, note.id, span.trackId, startSample, endSample];
      if (db.prepare(`SELECT 1 FROM voice_exemplars WHERE profile_id = ? AND note_id = ?
        AND track = ? AND start_sample = ? AND end_sample = ?`).get(...spanKey) ||
          db.prepare(`SELECT 1 FROM voice_enrollment_candidates WHERE profile_id = ? AND note_id = ?
        AND track = ? AND start_sample = ? AND end_sample = ?`).get(...spanKey)) continue;
      offered.push({ id, profileId, noteId: note.id, noteTitle: note.title,
        meetingDate: note.created_at, rowIds: [row.id], track: span.trackId,
        startSample, endSample, durationSeconds: duration,
        revision: createHash('sha256').update(JSON.stringify([row.text, row.speaker,
          row.speakerName, row.speakerLockSource, row.speakerStatus, row.suggestedProfileId,
          row.correctionRevision, row.corrections, row.audioSpan])).digest('hex'),
        everCorrected: false });
    }
  }
  return offered;
}
function locate(database, store, id) {
  const db = database.db;
  const existing = db.prepare('SELECT * FROM voice_enrollment_candidates WHERE id = ?').get(id);
  if (existing) return null;
  // A fresh scan rechecks attribution, correction and retention at action time.
  for (const { id: profileId } of db.prepare('SELECT id FROM speaker_profiles').all()) {
    const found = listCandidates(database, store, profileId).find(candidate => candidate.id === id);
    if (found) return found;
  }
  return null;
}
function play(database, store, id, sender = null) {
  forgetPlayback(id);
  const candidate = locate(database, store, id);
  if (!candidate) return { state: 'unavailable' };
  const audio = store.span(candidate.noteId, candidate.track,
    candidate.startSample / RATE, candidate.endSample / RATE);
  if (audio.state !== 'available' || audio.partial) return { state: 'unavailable' };
  const token = randomUUID();
  const now = (store.now || Date.now)();
  const durationMs = Math.ceil(candidate.durationSeconds * 1000);
  const session = { token, revision: candidate.revision, durationMs,
    completeAfter: now + durationMs,
    expires: now + 10 * 60 * 1000, completed: false, sender,
    audibleMs: 0, audibleSince: null, audioListener: null };
  if (sender) {
    // Chromium reports actual audio output from this WebContents. The renderer
    // can request completion, but cannot make a silent WebContents audible via IPC.
    session.audioListener = (event) => {
      const at = (store.now || Date.now)();
      if (session.audibleSince != null) session.audibleMs += Math.max(0, at - session.audibleSince);
      session.audibleSince = event.audible ? at : null;
    };
    sender.on('audio-state-changed', session.audioListener);
  }
  played.set(id, session);
  return { state: 'available', wav: audio.wav, token, candidate };
}
function complete(database, store, id, token, sender = null) {
  const session = played.get(id);
  const now = (store.now || Date.now)();
  if (!session || session.token !== token || session.expires < now || now < session.completeAfter ||
      session.sender !== sender)
    return { success: false, error: 'playback_required' };
  if (sender) {
    const audibleMs = session.audibleMs + (session.audibleSince == null ? 0 :
      Math.max(0, now - session.audibleSince));
    if (audibleMs < session.durationMs * 0.75)
      return { success: false, error: 'playback_required' };
  }
  const candidate = locate(database, store, id);
  if (!candidate || candidate.revision !== session.revision) {
    forgetPlayback(id);
    return { success: false, error: 'candidate_unavailable' };
  }
  session.completed = true;
  stopObserving(session);
  return { success: true };
}
async function embed(wav, extractor) {
  if (wav.subarray(0, 4).toString() !== 'RIFF') return null;
  const samples = (wav.length - 44) / 2;
  if (samples < RATE * 3) return null;
  let power = 0, clipped = 0;
  for (let i = 0; i < samples; i++) {
    const amplitude = wav.readInt16LE(44 + i * 2);
    power += amplitude * amplitude;
    if (Math.abs(amplitude) >= 32750) clipped++;
  }
  if (Math.sqrt(power / samples) / 32768 < calibration.minRms.value ||
      clipped / samples > calibration.clippingFraction.value) return null;
  const windows = [];
  const windowLength = Math.min(samples, RATE * 3);
  for (let k = 0; k < 3; k++) {
    const start = Math.round((samples - windowLength) * k / 2);
    const mono = new Float32Array(Math.round(windowLength * MODEL_RATE / RATE));
    for (let i = 0; i < mono.length; i++) {
      const source = start + i * RATE / MODEL_RATE;
      const lo = Math.floor(source), hi = Math.min(samples - 1, lo + 1);
      const a = wav.readInt16LE(44 + lo * 2) / 32768;
      const b = wav.readInt16LE(44 + hi * 2) / 32768;
      mono[i] = a + (b - a) * (source - lo);
    }
    const output = await extractor.extractEmbeddingFromSamples(mono);
    if (!output || output.length !== 512) return null;
    const normalized = unit(output);
    if (!normalized) return null;
    windows.push(normalized);
  }
  if (windows.some((left, i) => windows.some((right, j) => j > i && cosine(left, right) < MIN_OWN_SIMILARITY))) return null;
  return unit(Float32Array.from({ length: 512 }, (_, i) =>
    windows.reduce((sum, item) => sum + item[i], 0) / windows.length));
}
function echoLike(wav, other) {
  if (!other || other.length < wav.length / 2) return false;
  const count = Math.min((wav.length - 44) / 2, (other.length - 44) / 2);
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < count; i += 24) {
    const a = wav.readInt16LE(44 + i * 2), b = other.readInt16LE(44 + i * 2);
    dot += a * b; left += a * a; right += b * b;
  }
  return left > 0 && right > 0 && dot / Math.sqrt(left * right) > calibration.echoCorrelation.value;
}
async function decide(database, store, extractor, id, choice, token, sender = null) {
  const playback = played.get(id);
  if (!['approve', 'reject'].includes(choice) || !playback || playback.token !== token ||
      !playback.completed || playback.expires < (store.now || Date.now)() || playback.sender !== sender)
    return { success: false, error: 'playback_required' };
  const candidate = locate(database, store, id);
  forgetPlayback(id);
  if (!candidate || candidate.revision !== playback.revision) return { success: false, error: 'candidate_unavailable' };
  const audio = store.span(candidate.noteId, candidate.track,
    candidate.startSample / RATE, candidate.endSample / RATE);
  if (audio.state !== 'available' || audio.partial) return { success: false, error: 'audio_unavailable' };
  if (choice === 'approve') {
    const otherTrack = candidate.track === 'mic' ? 'system' : 'mic';
    const hasOther = store.status(candidate.noteId).tracks?.[otherTrack]?.chunks?.length;
    if (hasOther) {
      const other = store.span(candidate.noteId, otherTrack,
        candidate.startSample / RATE, candidate.endSample / RATE);
      if (other.state === 'available' && echoLike(audio.wav, other.wav))
        return { success: false, error: 'echo_audio' };
    }
  }
  const embedding = choice === 'approve' ? await embed(audio.wav, extractor) : null;
  if (choice === 'approve' && !embedding) return { success: false, error: 'poor_audio' };
  return database.db.transaction(() => {
    if (!locate(database, store, id)) return { success: false, error: 'candidate_unavailable' };
    const db = database.db;
    const actionId = randomUUID();
    if (choice === 'approve') {
      db.prepare(`INSERT INTO voice_exemplars (id, profile_id, note_id, track, start_sample, end_sample,
        embedding, approved_at, row_ids, meeting_date) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
        .run(id, candidate.profileId, candidate.noteId, candidate.track, candidate.startSample,
          candidate.endSample, packed(embedding), JSON.stringify(candidate.rowIds), candidate.meetingDate);
      db.prepare('UPDATE speaker_profiles SET voice_needs_reapproval = 0 WHERE id = ?').run(candidate.profileId);
      rebuild(db, candidate.profileId);
    } else {
      db.prepare(`INSERT INTO voice_enrollment_candidates (id, profile_id, note_id, track, start_sample,
        end_sample, row_ids, meeting_date, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .run(id, candidate.profileId, candidate.noteId, candidate.track, candidate.startSample,
          candidate.endSample, JSON.stringify(candidate.rowIds), candidate.meetingDate);
    }
    db.prepare('INSERT INTO voice_enrollment_actions (id, candidate_id, profile_id, note_id, choice) VALUES (?, ?, ?, ?, ?)')
      .run(actionId, id, candidate.profileId, candidate.noteId, choice);
    history.add(db, { id: actionId, kind: 'enrollment', profileId: candidate.profileId,
      noteId: candidate.noteId, label: `${choice}: ${candidate.rowIds.join(', ')}` });
    return { success: true, id: actionId, progress: progress(database, candidate.profileId) };
  })();
}
function undo(database, id) {
  return database.db.transaction(() => {
    const db = database.db;
    if (!history.canUndo(db, id, db.prepare('SELECT note_id FROM voice_enrollment_actions WHERE id = ?').get(id)?.note_id ?? null))
      return { success: false, error: 'later_change' };
    const action = db.prepare('SELECT * FROM voice_enrollment_actions WHERE id = ?').get(id);
    if (!action) return { success: false, error: 'action_missing' };
    if (action.choice === 'approve') db.prepare('DELETE FROM voice_exemplars WHERE id = ?').run(action.candidate_id);
    else if (action.choice === 'remove') {
      const sample = JSON.parse(action.before_sample);
      const columns = Object.keys(sample);
      db.prepare(`INSERT INTO voice_exemplars (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => column === 'embedding' ? Buffer.from(sample[column], 'base64') : sample[column]));
      db.prepare('DELETE FROM voice_enrollment_candidates WHERE id = ?').run(action.candidate_id);
    } else db.prepare('DELETE FROM voice_enrollment_candidates WHERE id = ?').run(action.candidate_id);
    db.prepare('DELETE FROM voice_enrollment_actions WHERE id = ?').run(id);
    history.remove(db, id, action.note_id);
    if (db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(action.profile_id)) rebuild(db, action.profile_id);
    return { success: true };
  })();
}
function removeSample(database, sampleId) {
  return database.db.transaction(() => {
    const db = database.db;
    const sample = db.prepare('SELECT * FROM voice_exemplars WHERE id = ?').get(sampleId);
    if (!sample) return { success: false, error: 'sample_missing' };
    const actionId = randomUUID();
    db.prepare(`INSERT OR IGNORE INTO voice_enrollment_candidates
      (id, profile_id, note_id, track, start_sample, end_sample, row_ids, meeting_date, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(sample.id, sample.profile_id,
        sample.note_id, sample.track, sample.start_sample, sample.end_sample, sample.row_ids, sample.meeting_date);
    db.prepare('DELETE FROM voice_exemplars WHERE id = ?').run(sampleId);
    db.prepare(`INSERT INTO voice_enrollment_actions
      (id, candidate_id, profile_id, note_id, choice, before_sample) VALUES (?, ?, ?, ?, 'remove', ?)`)
      .run(actionId, sampleId, sample.profile_id, sample.note_id,
        JSON.stringify({ ...sample, embedding: sample.embedding.toString('base64') }));
    rebuild(db, sample.profile_id);
    history.add(db, { id: actionId, kind: 'enrollment', profileId: sample.profile_id,
      noteId: sample.note_id, label: `removed: ${JSON.parse(sample.row_ids || '[]').join(', ')}` });
    return { success: true, id: actionId };
  })();
}
function rowCorrected(db, noteId, rowIds) {
  if (!rowIds.length || typeof db?.prepare !== 'function' ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_exemplars'").get()) return;
  const affected = db.prepare(`SELECT DISTINCT profile_id FROM voice_exemplars WHERE note_id = ?`).all(noteId);
  for (const { profile_id } of affected) {
    const touched = samples(db, profile_id).filter(sample => sample.note_id === noteId &&
      JSON.parse(sample.row_ids || '[]').some(id => rowIds.includes(id)));
    if (touched.length) {
      for (const sample of touched) db.prepare('DELETE FROM voice_exemplars WHERE id = ?').run(sample.id);
      db.prepare('UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 1 WHERE id = ?').run(profile_id);
      rebuild(db, profile_id);
    }
  }
}
function attributionChangedRows(beforeRaw, afterRaw) {
  const before = new Map(readTranscriptDocument(beforeRaw).rows.map(row => [row.id, row]));
  const after = readTranscriptDocument(afterRaw).rows;
  const fields = ['speaker', 'speakerName', 'speakerIsPlaceholder', 'suggestedProfileId',
    'speakerLockSource', 'speakerStatus', 'diarizationRunId', 'correctionRevision',
    'audioSpan', 'deleted'];
  return after.filter(row => {
    const prior = before.get(row.id);
    return !prior || fields.some(field => JSON.stringify(prior[field]) !== JSON.stringify(row[field]));
  }).map(row => row.id).concat([...before.keys()].filter(id =>
    !after.some(row => row.id === id)));
}
function snapshotEvidence(db, actionId, profileId = null, mergedInto = null) {
  db.exec('CREATE TABLE IF NOT EXISTS voice_sample_action_snapshots (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
  const where = profileId == null ? '' : ' WHERE profile_id = ?';
  const args = profileId == null ? [] : [profileId];
  const exemplars = db.prepare(`SELECT * FROM voice_exemplars${where}`).all(...args)
    .map(row => ({ ...row, embedding: row.embedding?.toString('base64') || null }));
  const candidates = db.prepare(`SELECT * FROM voice_enrollment_candidates${where}`).all(...args)
    .map(row => ({ ...row, embedding: row.embedding?.toString('base64') || null }));
  const survivorHasSamples = mergedInto != null && !!db.prepare(
    'SELECT 1 FROM voice_exemplars WHERE profile_id = ? LIMIT 1').get(mergedInto);
  const survivor = mergedInto == null || survivorHasSamples ? null : db.prepare(`SELECT embedding, sample_count,
    voice_usable, voice_needs_reapproval FROM speaker_profiles WHERE id = ?`).get(mergedInto);
  db.prepare('INSERT INTO voice_sample_action_snapshots (id, snapshot) VALUES (?, ?)')
    .run(actionId, JSON.stringify({ exemplars, candidates,
      derivedProfiles: [...new Set(exemplars.map(row => row.profile_id))], mergedInto,
      survivorBefore: survivor && { ...survivor, embedding: survivor.embedding.toString('base64') } }));
  return { exemplars: exemplars.length, candidates: candidates.length };
}
function removeEvidence(db, profileId = null, preserveRejections = false) {
  for (const table of ['voice_exemplars', 'voice_enrollment_candidates']) {
    if (table === 'voice_enrollment_candidates' && preserveRejections) continue;
    const where = profileId == null ? '' : ' WHERE profile_id = ?';
    db.prepare(`DELETE FROM ${table}${where}`).run(...(profileId == null ? [] : [profileId]));
  }
  if (profileId == null) db.prepare('UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 0').run();
  else db.prepare('UPDATE speaker_profiles SET voice_usable = 0, voice_needs_reapproval = 0 WHERE id = ?').run(profileId);
}
function restoreEvidence(db, actionId) {
  const found = db.prepare('SELECT snapshot FROM voice_sample_action_snapshots WHERE id = ?').get(actionId);
  if (!found) return [];
  const { exemplars, candidates, derivedProfiles = [], mergedInto, survivorBefore } = JSON.parse(found.snapshot);
  const profiles = new Set(derivedProfiles);
  const sourceDeleted = noteId => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_audio_tombstones'").get() &&
    !!db.prepare('SELECT 1 FROM meeting_audio_tombstones WHERE note_id = ?').get(noteId);
  for (const row of exemplars) {
    if (sourceDeleted(row.note_id) || !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(row.note_id) ||
        !db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(row.profile_id)) continue;
    const columns = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO voice_exemplars (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => column === 'embedding' && row[column] ? Buffer.from(row[column], 'base64') : row[column]));
    profiles.add(row.profile_id);
  }
  for (const row of candidates) {
    if (sourceDeleted(row.note_id) || !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(row.note_id) ||
        !db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(row.profile_id)) continue;
    const columns = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO voice_enrollment_candidates (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => column === 'embedding' && row[column] ? Buffer.from(row[column], 'base64') : row[column]));
  }
  db.prepare('DELETE FROM voice_sample_action_snapshots WHERE id = ?').run(actionId);
  for (const id of profiles) if (db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(id)) rebuild(db, id);
  if (mergedInto != null && db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(mergedInto)) {
    if (!survivorBefore) rebuild(db, mergedInto);
    else db.prepare(`UPDATE speaker_profiles SET embedding = ?, sample_count = ?,
      voice_usable = ?, voice_needs_reapproval = ? WHERE id = ?`).run(
        Buffer.from(survivorBefore.embedding, 'base64'), survivorBefore.sample_count,
        survivorBefore.voice_usable, survivorBefore.voice_needs_reapproval, mergedInto);
  }
  return [...profiles];
}
function pruneSnapshots(db, field, id) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_sample_action_snapshots'").get()) return;
  for (const saved of db.prepare('SELECT id, snapshot FROM voice_sample_action_snapshots').all()) {
    const snapshot = JSON.parse(saved.snapshot);
    let changed = false;
    for (const table of ['exemplars', 'candidates']) {
      const before = snapshot[table].length;
      snapshot[table] = snapshot[table].filter(row => row[field] !== id);
      changed ||= snapshot[table].length !== before;
    }
    if (field === 'note_id' && changed && snapshot.survivorBefore) {
      snapshot.survivorBefore = null;
    }
    if (field === 'profile_id' && snapshot.derivedProfiles?.includes(id)) {
      snapshot.derivedProfiles = snapshot.derivedProfiles.filter(profileId => profileId !== id);
      changed = true;
    }
    if (field === 'profile_id' && snapshot.mergedInto === id) {
      snapshot.exemplars = [];
      snapshot.candidates = [];
      snapshot.derivedProfiles = [];
      snapshot.survivorBefore = null;
      changed = true;
    }
    if (changed) db.prepare('UPDATE voice_sample_action_snapshots SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), saved.id);
  }
}
function removeNoteEvidence(db, noteId) {
  const affected = new Set(db.prepare('SELECT DISTINCT profile_id FROM voice_exemplars WHERE note_id = ?')
    .all(noteId).map(row => row.profile_id));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_sample_action_snapshots'").get())
    for (const saved of db.prepare('SELECT snapshot FROM voice_sample_action_snapshots').all())
      for (const row of JSON.parse(saved.snapshot).exemplars || [])
        if (row.note_id === noteId) affected.add(row.profile_id);
  db.exec('CREATE TABLE IF NOT EXISTS meeting_audio_tombstones (note_id INTEGER PRIMARY KEY)');
  db.prepare('INSERT OR IGNORE INTO meeting_audio_tombstones (note_id) VALUES (?)').run(noteId);
  require('./peopleActions').scrubDeletedRecordingSnapshots(db, noteId, [...affected]);
  pruneSnapshots(db, 'note_id', noteId);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speaker_global_actions'").get())
    db.prepare(`UPDATE speaker_global_actions SET unavailable_reason = 'audio_deleted'
      WHERE id IN (SELECT id FROM voice_enrollment_actions WHERE note_id = ?)`)
      .run(noteId);
  db.prepare('DELETE FROM voice_enrollment_actions WHERE note_id = ?').run(noteId);
  db.prepare('DELETE FROM voice_enrollment_candidates WHERE note_id = ?').run(noteId);
  db.prepare('DELETE FROM voice_exemplars WHERE note_id = ?').run(noteId);
  for (const profileId of affected) {
    rebuild(db, profileId);
    db.prepare('UPDATE speaker_profiles SET voice_needs_reapproval = 1 WHERE id = ?').run(profileId);
  }
}
module.exports = { listCandidates, listSamples, play, complete, decide, progress, rebuild, undo, removeSample, rowCorrected,
  snapshotEvidence, removeEvidence, restoreEvidence, pruneSnapshots, removeNoteEvidence, calibration,
  attributionChangedRows };
