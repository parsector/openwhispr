export function extractPlaceholders(prompt) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000)
    throw new Error("Invalid preset prompt");
  const names = [];
  const pattern = /{{([a-zA-Z][a-zA-Z0-9_]*)}}/g;
  const withoutValid = prompt.replace(pattern, (match, name, offset) => {
    if (prompt[offset - 1] === "{" || prompt[offset + match.length] === "}")
      throw new Error("Unclosed or invalid placeholder");
    if (names.includes(name)) throw new Error(`Duplicate placeholder: ${name}`);
    names.push(name);
    return "";
  });
  if (withoutValid.includes("{{") || withoutValid.includes("}}"))
    throw new Error("Unclosed or invalid placeholder");
  return names;
}

export function resolvePresetPrompt(prompt, values = {}) {
  const names = extractPlaceholders(prompt);
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !names.includes(key))
  )
    throw new Error("Invalid placeholder values");
  for (const name of names)
    if (typeof values[name] !== "string" || !values[name].trim())
      throw new Error(`Missing value for ${name}`);
  return prompt.replace(/{{([a-zA-Z][a-zA-Z0-9_]*)}}/g, (_match, name) => values[name].trim());
}
