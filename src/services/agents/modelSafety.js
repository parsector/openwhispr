function safeModel(value) {
  if (typeof value !== "string") return false;
  const model = value.trim();
  return (
    Boolean(model) &&
    model.length <= 80 &&
    !model.startsWith("-") &&
    !/\p{Cc}/u.test(model) &&
    !/[;&|`$<>\\(){}*?!~'"#^%]/.test(model) &&
    !model.includes("[") &&
    !model.includes("]")
  );
}
module.exports = { safeModel };
