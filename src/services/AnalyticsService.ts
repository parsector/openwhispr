// Insights is backed by the device's analytics database. Refresh only when its
// local counters change; there is no account analytics request in this fork.
export function subscribeToAnalyticsRefresh(refresh: () => void | Promise<void>): () => void {
  let disposed = false;
  let running = false;
  let trailing = false;
  const run = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      trailing = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch (error) {
      console.error("Refreshing analytics failed:", error);
    } finally {
      running = false;
      if (trailing && !disposed) {
        trailing = false;
        void run();
      }
    }
  };
  const dispose = window.electronAPI.onAnalyticsChanged?.(() => void run());
  void run();
  return () => {
    disposed = true;
    dispose?.();
  };
}
