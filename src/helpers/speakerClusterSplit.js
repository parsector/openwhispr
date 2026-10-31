const { spawnSync } = require("child_process");
const { getFFmpegPath } = require("./ffmpegUtils");

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

function centroid(vectors) {
  const result = new Float32Array(vectors[0].length);
  for (const vector of vectors) for (let i = 0; i < result.length; i += 1) result[i] += vector[i];
  for (let i = 0; i < result.length; i += 1) result[i] /= vectors.length;
  return result;
}

function partitionClusterByVoice(clusterIds, selectedIds, embeddings) {
  const selected = new Set(selectedIds);
  const moved = new Set(selectedIds);
  const bVectors = selectedIds.map((id) => embeddings.get(id)).filter(Boolean);
  const b = bVectors.length ? centroid(bVectors) : null;
  const possibleA = clusterIds.filter((id) => !selected.has(id) && embeddings.has(id));
  const aId = b && possibleA.length ? possibleA.sort((left, right) =>
    cosine(embeddings.get(left), b) - cosine(embeddings.get(right), b))[0] : null;
  if (aId) {
    const a = embeddings.get(aId);
    const seedSimilarity = cosine(a, b);
    for (const id of clusterIds) {
      if (selected.has(id) || id === aId || !embeddings.has(id)) continue;
      const vector = embeddings.get(id);
      // Relative evidence only. No uncalibrated probability or fixed score cutoff.
      if (cosine(vector, b) > cosine(vector, a) && cosine(vector, b) > seedSimilarity)
        moved.add(id);
    }
  }
  return { movedIds: clusterIds.filter((id) => moved.has(id)),
    retainedIds: clusterIds.filter((id) => !moved.has(id)),
    acousticRows: [...moved].filter((id) => !selected.has(id)).length };
}

function wavTo16kSamples(wav) {
  const result = spawnSync(getFFmpegPath(), ["-hide_banner", "-loglevel", "error",
    "-f", "wav", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
  { input: wav, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || !result.stdout?.length) return null;
  const samples = new Float32Array(result.stdout.length / 4);
  for (let i = 0; i < samples.length; i += 1) samples[i] = result.stdout.readFloatLE(i * 4);
  return samples;
}

async function proposeClusterSplit(rows, selectedIds, noteId, audioStore, extractor) {
  const ids = rows.map((row) => row.id);
  const selected = new Set(selectedIds);
  const track = rows.find((row) => selected.has(row.id))?.audioSpan?.trackId;
  const embeddings = new Map();
  if (track && extractor?.isAvailable?.()) {
    for (const row of rows) {
      const span = row.audioSpan;
      if (!span || span.recordingId !== (audioStore.status(noteId).recordingId ?? noteId) || span.trackId !== track ||
        row.uncertainty?.reason === "overlapping_speech") continue;
      const end = span.endSample / 24000;
      const start = Math.max(span.startSample / 24000, end - 8);
      if (end - start < 1.5) continue;
      const audio = audioStore.span(noteId, track, start, end);
      if (audio.state !== "available" || audio.partial) continue;
      const samples = wavTo16kSamples(audio.wav);
      if (!samples) continue;
      try {
        const embedding = await extractor.extractEmbeddingFromSamples(samples);
        if (embedding) embeddings.set(row.id, embedding);
      } catch {
        // A missing model or unreadable window leaves this row unassessed.
      }
    }
  }
  return partitionClusterByVoice(ids, selectedIds, embeddings);
}

module.exports = { partitionClusterByVoice, proposeClusterSplit };
