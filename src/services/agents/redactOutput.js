function redactOutput(value) {
  return String(value || "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(
      /("(?:api_?key|access_?token|refresh_?token|auth_?token|secret|password|authorization)"\s*:\s*")[^"]*(")/gi,
      "$1<REDACTED>$2"
    )
    .replace(
      /\b((?:api_?key|access_?token|refresh_?token|auth_?token|secret|password|authorization)\s*[=:]\s*)[^\s,"'}]+/gi,
      "$1<REDACTED>"
    )
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer <REDACTED>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<REDACTED_EMAIL>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|owk_[A-Za-z0-9_-]+)/gi, "<REDACTED>");
}

module.exports = { redactOutput };
