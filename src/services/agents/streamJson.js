const MAX_LINE = 1024 * 1024;
function describeTool(block) {
  const input = block.input || {};
  if (block.name === "Read") return `Read ${input.file_path || input.path || "file"}`;
  if (block.name === "Bash") return `Ran ${input.command || "command"}`;
  return `${block.name || "Tool"} ${input.file_path || input.path || ""}`.trim();
}
function parseEvent(value) {
  if (value.type === "system" && value.subtype === "init")
    return [{ kind: "init", session_id: value.session_id || null, model: value.model || null }];
  if (value.type === "result")
    return [
      {
        kind: "result",
        answer: value.result || "",
        duration_ms: value.duration_ms ?? null,
        total_cost_usd: value.total_cost_usd ?? null,
        is_error: Boolean(value.is_error),
        session_id: value.session_id || null,
      },
    ];
  if (value.type === "assistant") {
    const blocks = value.message?.content || [];
    return blocks.flatMap((block) =>
      block.type === "text"
        ? [{ kind: "text", text: block.text || "" }]
        : block.type === "tool_use"
          ? [{ kind: "tool", name: block.name || "", summary: describeTool(block) }]
          : []
    );
  }
  if (
    value.type === "stream_event" &&
    value.event?.type === "content_block_delta" &&
    value.event.delta?.type === "text_delta"
  )
    return [{ kind: "text", text: value.event.delta.text || "" }];
  if (value.type === "user")
    return (value.message?.content || [])
      .filter((block) => block.type === "tool_result")
      .map((block) => ({ kind: "tool_result", ok: !block.is_error }));
  return [{ kind: "unknown", type: value.type || null }];
}
function createLineParser(parse, onEvent = () => {}) {
  let buffer = "";
  let truncated = false;
  const steps = [];
  function emit(event) {
    steps.push(event);
    if (steps.length > 200) steps.shift();
    onEvent(event);
  }
  function line(raw) {
    if (truncated) {
      emit({ kind: "unknown", truncated: true });
      truncated = false;
      return;
    }
    if (!raw.trim()) return;
    try {
      for (const event of parse(JSON.parse(raw))) emit(event);
    } catch {
      emit({ kind: "unknown", type: "invalid_json" });
    }
  }
  function feed(chunk) {
    for (const char of String(chunk)) {
      if (char === "\n") {
        line(buffer);
        buffer = "";
        continue;
      }
      if (buffer.length < MAX_LINE) buffer += char;
      else truncated = true;
    }
  }
  function end() {
    if (buffer || truncated) line(buffer);
    buffer = "";
  }
  return { feed, end, steps };
}
function createStreamJson(onEvent) {
  return createLineParser(parseEvent, onEvent);
}
function createCursorStreamJson(onEvent) {
  const streamed = new Map();
  function parseCursor(value) {
    if (value.type === "system" && value.subtype === "init")
      return [{ kind: "init", session_id: value.session_id || null, model: value.model || null }];
    if (value.type === "result")
      return [
        {
          kind: "result",
          answer: value.result || "",
          duration_ms: value.duration_ms ?? null,
          total_cost_usd: null,
          is_error: Boolean(value.is_error),
          session_id: value.session_id || null,
        },
      ];
    if (value.type === "assistant") {
      const content = value.message?.content || [];
      const text = content
        .filter((block) => typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (!text) return [];
      // Buffered flushes repeat the streamed text and carry a model call id.
      if (value.model_call_id) return [];
      const key = value.message?.id || "assistant";
      const previous = streamed.get(key) || "";
      // Cursor partial output normally contains deltas. Some versions emit cumulative text.
      const next =
        value.timestamp_ms && text.startsWith(previous) && previous
          ? text.slice(previous.length)
          : text;
      streamed.set(key, (previous + next).slice(-MAX_LINE));
      return next ? [{ kind: "text", text: next }] : [];
    }
    if (value.type === "tool_call") {
      const variant = ["readToolCall", "writeToolCall", "shellToolCall"].find(
        (key) => value.tool_call?.[key] || value[key]
      );
      const call = value.tool_call || value;
      const detail = call[variant]?.args || call[variant]?.input || call[variant] || {};
      if (value.subtype === "started") {
        const rawTarget =
          detail.path ||
          detail.file_path ||
          detail.filePath ||
          detail.targetPath ||
          detail.command ||
          detail.commandLine ||
          detail.cmd ||
          "";
        const target = typeof rawTarget === "string" ? rawTarget : "";
        const action =
          variant === "readToolCall"
            ? "Read"
            : variant === "writeToolCall"
              ? "Wrote"
              : variant === "shellToolCall"
                ? "Ran"
                : "Tool";
        return [{ kind: "tool", name: variant || "", summary: `${action} ${target}`.trim() }];
      }
      if (["completed", "finished", "error", "failed"].includes(value.subtype))
        return [
          {
            kind: "tool_result",
            ok: !value.is_error && !["error", "failed"].includes(value.subtype),
          },
        ];
    }
    return [{ kind: "unknown", type: value.type || null }];
  }
  return createLineParser(parseCursor, onEvent);
}
function createStreamParser(harness, onEvent) {
  if (harness === "claude") return createStreamJson(onEvent);
  if (harness === "cursor-agent" || harness === "cursor") return createCursorStreamJson(onEvent);
  throw new Error("Invalid harness");
}
module.exports = {
  MAX_LINE,
  parseEvent,
  createStreamJson,
  createCursorStreamJson,
  createStreamParser,
};
