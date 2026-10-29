const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "../../src/components/SettingsPage.tsx"),
  "utf8"
);
const file = ts.createSourceFile(
  "SettingsPage.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function vadGate(tab) {
  let gate;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.text === tab) {
      const expression = node.initializer?.expression;
      function findGate(child) {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          ts.isCallExpression(child.right) &&
          child.right.expression.getText(file) === "renderWhisperVadSettings"
        ) {
          gate = child.getText(file);
        }
        ts.forEachChild(child, findGate);
      }
      if (expression) findGate(expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(gate, `${tab} renders the VAD panel`);
  return (settings) =>
    vm.runInNewContext(gate, {
      ...settings,
      renderWhisperVadSettings: () => "VAD panel",
    }) === "VAD panel";
}

test("each Speech-to-Text tab shows VAD only for its own local Whisper engine", () => {
  const dictation = vadGate("renderDictation");
  const noteRecording = vadGate("renderNoteRecording");

  const noteOnly = {
    transcriptionMode: "cloud",
    localTranscriptionProvider: "whisper",
    meetingTranscriptionMode: "local",
    meetingLocalTranscriptionProvider: "whisper",
  };
  assert.equal(dictation(noteOnly), false);
  assert.equal(noteRecording(noteOnly), true);

  const dictationOnly = {
    transcriptionMode: "local",
    localTranscriptionProvider: "whisper",
    meetingTranscriptionMode: "cloud",
    meetingLocalTranscriptionProvider: "whisper",
  };
  assert.equal(dictation(dictationOnly), true);
  assert.equal(noteRecording(dictationOnly), false);

  assert.equal(noteRecording({ ...noteOnly, meetingLocalTranscriptionProvider: "nvidia" }), false);
  assert.equal(dictation({ ...dictationOnly, localTranscriptionProvider: "nvidia" }), false);
});
