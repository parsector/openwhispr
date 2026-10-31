const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('recommendation is never applied until explicit settings save and synthetic data stays uncalibrated', () => {
  const config = require('../../src/helpers/speakerDecisionThresholds');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-threshold-test-'));
  try {
    config.configure(path.join(dir, 'thresholds.json'));
    const { matchReason } = require('../../src/helpers/speakerUncertainty');
    assert.equal(config.current().status, 'uncalibrated');
    const proposed = { similarityFloor: .6, runnerUpMargin: .05,
      minimumVoicedSeconds: 2, overlapToleranceSeconds: .1 };
    assert.equal(config.current().values.similarityFloor, .65);
    assert.equal(matchReason({ score: .7, name: 'A' }, { score: .66, name: 'B' }), null);
    config.apply(proposed, { synthetic: true, audioSha256: { system: 'fixture' } });
    assert.equal(config.current().status, 'uncalibrated');
    assert.equal(config.current().values.similarityFloor, .6);
    assert.equal(matchReason({ score: .7, name: 'A' }, { score: .66, name: 'B' }).reason, 'close_match');
    config.apply(proposed, { version: 1, synthetic: false, audioSha256: { system: 'a'.repeat(64) },
      evidence: { rowCount: 20 } });
    assert.equal(config.current().status, 'calibrated');
    config.configure(path.join(dir, 'thresholds.json'));
    assert.equal(config.current().values.runnerUpMargin, .05);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); config.configure(null); }
});
