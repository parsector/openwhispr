const test = require("node:test");
const assert = require("node:assert/strict");
const { textLength, byteLength } = require("../../src/helpers/logRedaction");

test("log redaction helpers expose structure without user text", () => {
  const secret = "PRIVATE_NOTE_85eebed659";
  const metadata = { textLength: textLength(secret), byteLength: byteLength(secret) };
  assert.equal(metadata.textLength, secret.length);
  assert.equal(metadata.byteLength, Buffer.byteLength(secret));
  assert.equal(JSON.stringify(metadata).includes(secret), false);
});
