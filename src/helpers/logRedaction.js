function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ""));
}

module.exports = { textLength, byteLength };
