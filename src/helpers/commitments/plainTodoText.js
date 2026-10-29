// The stored markdown link is kept in the database; tool results are plain text.
const MENTION = /\[@([^\]\n]+)\]\(mention:[^)\s]+\)/g;
function plainTodoText(text) {
  return String(text || "").replace(MENTION, (_all, name) => `@${name}`);
}
module.exports = { plainTodoText };
