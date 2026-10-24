// Claude Code model configuration docs, CLI 2.1.300. Refresh this snapshot when the CLI changes.
const aliases = [
  { id: "opus", label: "Opus (alias, latest)" },
  { id: "sonnet", label: "Sonnet (alias, latest)" },
  { id: "haiku", label: "Haiku (alias, latest)" },
  { id: "fable", label: "Fable (alias, latest)" },
];
const fullNames = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export function claudeModels() {
  return {
    aliases: aliases.map((model) => ({ ...model })),
    fullNames: fullNames.map((model) => ({ ...model })),
  };
}

export function validateModel(harness, value) {
  if (typeof value !== "string") return { ok: false, reason: "malformed" };
  const model = value.trim();
  if (!model || harness === "cursor-agent") return { ok: true, reason: null };
  if (harness !== "claude") return { ok: false, reason: "unsupported" };
  if (aliases.some((alias) => alias.id === model)) return { ok: true, reason: null };
  if (/^claude-[a-z0-9]+(?:-[a-z0-9.]+)+$/.test(model)) return { ok: true, reason: null };
  if (aliases.some((alias) => model.startsWith(`${alias.id}-`)))
    return { ok: false, reason: "unknown_alias" };
  return { ok: false, reason: "malformed" };
}
