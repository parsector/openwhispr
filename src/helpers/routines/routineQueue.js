class RoutineQueue {
  constructor({ run, isRecording = () => false, now = () => Date.now(), maxConcurrent = 2 }) {
    this.run = run;
    this.isRecording = isRecording;
    this.now = now;
    this.maxConcurrent = maxConcurrent;
    this.pending = [];
    this.active = new Set();
    this.claimed = new Map();
  }

  enqueue(job) {
    const key = `${job.routineId}:${job.slotKey}`;
    if (job.catchUp && this.claimed.has(key)) return this.claimed.get(key);
    const promise = new Promise((resolve, reject) => {
      this.pending.push({ ...job, resolve, reject, queuedAt: this.now() });
      this.drain();
    });
    if (job.catchUp) this.claimed.set(key, promise);
    promise.finally(() => this.claimed.delete(key)).catch(() => {});
    return promise;
  }

  recordingStopped() {
    this.drain();
  }

  cancelScheduled(routineId) {
    const keep = [];
    for (const job of this.pending) {
      if (job.routineId === routineId && job.catchUp)
        job.resolve({ status: "skipped", reason: "paused" });
      else keep.push(job);
    }
    this.pending = keep;
  }

  drain() {
    while (this.active.size < this.maxConcurrent) {
      const index = this.pending.findIndex((job) => {
        if (this.active.has(job.routineId)) return false;
        if (!this.isRecording()) return true;
        return !job.localModel && this.now() - job.queuedAt >= 3600000;
      });
      if (index < 0) break;
      const [job] = this.pending.splice(index, 1);
      if (job.localModel && job.catchUp && this.now() > job.expiresAt) {
        job.resolve({ status: "skipped", reason: "recording" });
        continue;
      }
      this.active.add(job.routineId);
      Promise.resolve()
        .then(() => this.run(job))
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active.delete(job.routineId);
          this.drain();
        });
    }
  }
}

module.exports = { RoutineQueue };
