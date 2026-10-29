function deleteCommitment({ store, debugLogger, broadcast }, id) {
  if (!debugLogger.isDebugEnabled()) {
    debugLogger.warn("Refused todo deletion outside debug mode", { id }, "commitments");
    return { success: false, error: "debug_only" };
  }
  if (typeof id !== "string" || !id) return { success: false, error: "invalid_id" };
  if (!store.remove(id)) return { success: false, error: "not_found" };
  broadcast("commitments-updated");
  return { success: true };
}

module.exports = { deleteCommitment };
