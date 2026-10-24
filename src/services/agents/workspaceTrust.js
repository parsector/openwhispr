const TRUST_REFUSAL = /workspace trust required|do you trust the contents of this directory/i;

function isWorkspaceTrustRefusal(...outputs) {
  return outputs.some((output) => TRUST_REFUSAL.test(String(output || "")));
}

function trustRefusalLine(...outputs) {
  return outputs
    .flatMap((output) => String(output || "").split(/\r?\n/))
    .find((line) => TRUST_REFUSAL.test(line));
}

module.exports = { isWorkspaceTrustRefusal, trustRefusalLine };
