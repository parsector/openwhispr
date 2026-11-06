const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const { completionDiagnostic } = require("../../src/helpers/speakerCompletionDiagnostic");
const { i18nMain } = require("../../src/helpers/i18nMain");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");

async function renderer(t) {
  const previous = globalThis.__calibrationTranslate;
  globalThis.__calibrationTranslate = i18nMain.t.bind(i18nMain);
  t.after(() => {
    globalThis.__calibrationTranslate = previous;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "speaker-calibration-report-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next":
        "export const useTranslation = () => ({ t: globalThis.__calibrationTranslate });",
    },
  });
  const { SpeakerCalibrationReport } = await vite.ssrLoadModule(
    "/components/settings/SpeakerCalibrationReport.tsx"
  );
  return (report) =>
    renderToStaticMarkup(React.createElement(SpeakerCalibrationReport, { report, onApply() {} }));
}

test("People calibration all-refusal UI shows diagnostics, one sweep, and no apply action or recommendation panel", async (t) => {
  const render = await renderer(t);
  const input = recommendationFixture();
  input.rows = input.rows.map((row) => ({ ...row, vector: [-1, -1] }));
  const report = buildReport(input);
  assert.equal(report.resultType, "diagnostic_only");
  const html = render(report);
  assert.match(html, /Diagnostics only/);
  assert.match(html, /does not replay production decisions/);
  assert.match(html, /Duration and overlap thresholds were not evaluated/);
  assert.match(html, /Diagnostic threshold sweep/);
  assert.match(html, /use manual settings/);
  assert.match(html, /universal refusal cannot qualify/);
  assert.doesNotMatch(html, /Apply these values|Supported recommendation|Independent holdout/);
  assert.equal((html.match(/<table/g) || []).length, 1);
  assert.doesNotMatch(html, /0 right|0 wrong|live decisions|Estimate:/);
});

test("People calibration shows the apply action only for an independently supported recommendation", async (t) => {
  const render = await renderer(t);
  const report = buildReport(recommendationFixture());
  const html = render(report);
  assert.match(html, /Supported recommendation/);
  assert.match(html, /Apply these values/);
  assert.match(html, /Independent holdout/);
  assert.match(html, /finite holdout/);
  assert.match(html, /Duration and overlap thresholds were not evaluated/);
  const diagnostic = {
    ...report,
    resultType: "diagnostic_only",
    failedCriteria: ["machine_claims"],
  };
  assert.doesNotMatch(render(diagnostic), /Apply these values|Supported recommendation/);
});

test("People calibration renders each completion cause and migrated counts as not recorded", async (t) => {
  const render = await renderer(t);
  const report = buildReport(recommendationFixture());
  const cases = [
    ["diarization_skipped", /Diarization was skipped/],
    ["diarization_failed", /Diarization failed/],
    ["embedding_extraction_failed", /Speaker-vector extraction failed/],
    ["write_rejected:row_count_mismatch", /persistence was rejected/],
    ["speaker_id_vs_speaker_key_mismatch", /keys do not match/],
    ["model_unavailable", /model unavailable/],
    ["no_eligible_segments", /No eligible segments/],
    ["audio_state:expired", /Audio state prevented/],
  ];
  for (const [cause, message] of cases) {
    report.evidence.missingVectorDiagnostics = [
      completionDiagnostic(62, { cause, clusters: 2, vectorsWritten: 0 }),
    ];
    assert.match(render(report), message);
  }
  report.evidence.missingVectorDiagnostics = [completionDiagnostic(62, null)];
  assert.match(render(report), /No completion event recorded/);
  report.evidence.missingVectorDiagnostics = [
    completionDiagnostic(62, {
      cause: null,
      clusters: 0,
      vectorsWritten: 0,
      hadSpeakerEmbeddings: true,
    }),
  ];
  const migrated = render(report);
  assert.match(migrated, /Completion cause unknown/);
  assert.match(migrated, /not recorded/);
  assert.doesNotMatch(migrated, /0 of 0/);
});

test("People settings delegates its report rendering and guards the apply handler by result type", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/components/settings/PeoplePage.tsx"),
    "utf8"
  );
  assert.match(source, /<SpeakerCalibrationReport\s+report=\{calibrationReport\}/);
  assert.match(
    source,
    /if \(calibrationReport\?\.resultType !== "supported_recommendation"\) return/
  );
  assert.doesNotMatch(source, /analysis\.winner|analyses\.estimated/);
});
