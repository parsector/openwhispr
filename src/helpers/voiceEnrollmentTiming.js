const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const debugLogger = require("./debugLogger");

const context = new AsyncLocalStorage();
const pendingRefresh = new Map();
const fields = [
  "candidate_scan_ms",
  "echo_decode_ms",
  "span_read_ms",
  "ffmpeg_decode_ms",
  "embed_ms",
  "renderer_refresh_ms",
];

function current() {
  return context.getStore();
}
function measure(field, work) {
  const metrics = current();
  if (!metrics) return work();
  const start = performance.now();
  try {
    return work();
  } finally {
    metrics[field] += performance.now() - start;
  }
}
async function measureAsync(field, work) {
  const metrics = current();
  if (!metrics) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    metrics[field] += performance.now() - start;
  }
}
function decoded(ms) {
  const metrics = current();
  if (metrics) {
    metrics.ffmpeg_decode_ms += ms;
    metrics.decode_count++;
  }
}
function span(ms) {
  const metrics = current();
  if (metrics) metrics.span_read_ms += ms;
}
function candidateCount(count) {
  const metrics = current();
  if (metrics) metrics.candidate_count = count;
}
function emit(metrics) {
  const line = { ...metrics };
  for (const field of fields) line[field] = Math.round(line[field] * 10) / 10;
  line.total_ms = Math.round(line.total_ms * 10) / 10;
  debugLogger.debug(
    JSON.stringify({ event: "voice_enrollment_ipc_timing", ...line }),
    undefined,
    "voice-enrollment"
  );
}
async function run(action, work, deferRefresh = false) {
  const metrics = Object.fromEntries(fields.map((field) => [field, 0]));
  Object.assign(metrics, { action, total_ms: 0, candidate_count: 0, decode_count: 0 });
  const start = performance.now();
  try {
    const result = await context.run(metrics, work);
    metrics.total_ms = performance.now() - start;
    if (deferRefresh && result?.success) {
      const timingId = randomUUID();
      const timer = setTimeout(() => {
        if (!pendingRefresh.delete(timingId)) return;
        emit(metrics);
      }, 10000);
      timer.unref?.();
      pendingRefresh.set(timingId, { metrics, timer });
      return { ...result, timingId };
    }
    emit(metrics);
    return result;
  } catch (error) {
    metrics.total_ms = performance.now() - start;
    emit(metrics);
    throw error;
  }
}
function rendererRefresh(timingId, milliseconds) {
  const pending = pendingRefresh.get(timingId);
  if (!pending) return;
  pendingRefresh.delete(timingId);
  clearTimeout(pending.timer);
  if (Number.isFinite(milliseconds) && milliseconds >= 0)
    pending.metrics.renderer_refresh_ms = milliseconds;
  emit(pending.metrics);
}
module.exports = {
  run,
  measure,
  measureAsync,
  decoded,
  span,
  candidateCount,
  current,
  rendererRefresh,
  now: () => performance.now(),
};
