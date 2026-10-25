import { stripThinkingTags } from "../stripThinking.js";

function isMarkerOnly(reply, marker) {
  const lines = stripThinkingTags(reply)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  const last = lines.pop()?.replace(/^[*_`]+|[*_`.!]+$/g, "");
  if (last !== marker) return false;
  const lead = lines.join("\n");
  return lead.length <= 200 && !/^(?:#|[-*+]\s|\d+[.)]\s)/m.test(lead);
}

function completion({ text, finishRun, toolsAvailable }) {
  const output = stripThinkingTags(text || "").trim();
  if (finishRun?.empty === true) return { status: "empty", text: "", headline: "" };
  if (!toolsAvailable && isMarkerOnly(output, "NOTHING_TO_REPORT")) {
    return { status: "empty", text: "", headline: "" };
  }
  if (!output) return { status: "failed", text: "", headline: "" };
  return {
    status: toolsAvailable && !finishRun ? "partial" : "done",
    text: output,
    headline:
      typeof finishRun?.headline === "string" ? finishRun.headline.trim().slice(0, 180) : "",
  };
}

export { isMarkerOnly, completion };
