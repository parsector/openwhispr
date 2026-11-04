function resolveExtractionModel(routineChoice, chatChoice) {
  if (routineChoice?.routineOverride !== false && routineChoice?.model) {
    return { model: routineChoice, source: "routine-choice" };
  }
  if (chatChoice?.model) return { model: chatChoice, source: "chat-model" };
  return { model: null, source: null };
}

module.exports = { resolveExtractionModel };
