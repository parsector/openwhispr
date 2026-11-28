const stopStream = (stream) => {
  for (const track of stream?.getTracks?.() ?? []) {
    try {
      if (track.readyState !== "ended") track.stop();
    } catch {
      // Continue releasing the other tracks even if one has already gone away.
    }
  }
};

// One reservation spans preparation, capture and device recovery. Release stops
// tracks synchronously and keeps admission reserved until pending opens settle,
// so a permission dialog resolving after Close cannot resurrect the mic.
export class MicrophoneCapture {
  constructor({ releaseOnHide = false } = {}) {
    this.current = null;
    this.releasing = Promise.resolve();
    this.releaseOnHide = releaseOnHide;
  }

  async open(acquire) {
    let session = this.current;
    if (!session) {
      const id = crypto.randomUUID();
      const target = window;
      const api = target.electronAPI;
      session = { id, api, target, streams: new Set(), pending: new Set(), closed: false };
      // Register the opening synchronously: a Close in this same turn must
      // cancel it too. A new session still waits for the old release's IPC.
      session.admission = this.releasing.then(() =>
        session.closed ? true : (api?.acquireMicrophoneCapture?.(id) ?? true)
      );
      this.current = session;
      session.onUnload = () => {
        void this.release();
      };
      target.addEventListener("beforeunload", session.onUnload);
      if (this.releaseOnHide)
        session.unsubscribeHide = api?.onReleaseIdleMicrophone?.(session.onUnload);
    }
    const remember = (stream) => {
      if (session.closed) {
        stopStream(stream);
        throw new Error("Microphone capture cancelled");
      }
      if (stream) session.streams.add(stream);
      return stream;
    };
    const opening = (async () => {
      if (!(await session.admission))
        throw new Error("Microphone is already in use by another capture");
      if (session.closed) throw new Error("Microphone capture cancelled");
      // Health checks may await a muted track and retry. Register each raw
      // input immediately, and prevent retries from reopening a closed take.
      const openInput = async (constraints) => {
        if (session.closed) throw new Error("Microphone capture cancelled");
        return remember(await navigator.mediaDevices.getUserMedia(constraints));
      };
      const stream = remember(await acquire(openInput));
      session.hasSuccessfulOpen = true;
      return stream;
    })();
    session.pending.add(opening);
    try {
      return await opening;
    } catch (error) {
      if (!session.hasSuccessfulOpen && this.current === session) void this.release();
      throw error;
    } finally {
      session.pending.delete(opening);
    }
  }

  owns(stream) {
    return this.current?.streams.has(stream) ?? false;
  }

  releaseStream(stream) {
    const session = this.current;
    if (!session?.streams.delete(stream)) return;
    stopStream(stream);
    // A stale preparation can finish inside a newer take's session. Disposing
    // its stream must leave every other stream and pending acquisition alone.
    for (const owned of session.streams) {
      if (owned.getTracks().every((track) => track.readyState === "ended"))
        session.streams.delete(owned);
    }
    if (!session.streams.size && !session.pending.size) void this.release();
  }

  release() {
    const session = this.current;
    if (!session) return this.releasing;
    this.current = null;
    session.closed = true;
    for (const stream of session.streams) stopStream(stream);
    session.streams.clear();
    try {
      session.target.removeEventListener("beforeunload", session.onUnload);
      session.unsubscribeHide?.();
    } catch {
      // A disappearing window must not prevent releasing tracks or admission.
    }
    this.releasing = Promise.allSettled([...session.pending])
      .then(() => session.api?.releaseMicrophoneCapture?.(session.id))
      .catch(() => {});
    return this.releasing;
  }
}
