const crypto = require("node:crypto");
// A process-local test key; never access the host keychain or safeStorage.
const key = crypto.randomBytes(32);
module.exports = {
  encryptBytes(bytes) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  },
  decryptBytes(bytes) {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
  },
};
