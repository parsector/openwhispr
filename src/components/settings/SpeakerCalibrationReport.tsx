import { useTranslation } from "react-i18next";
import type { SpeakerCalibrationReport as Report } from "../../types/speakerCalibration";
import { Button } from "../ui/button";

export function SpeakerCalibrationReport({
  report,
  onApply,
}: {
  report: Report;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const { evidence, analyses } = report;
  const supported = report.resultType === "supported_recommendation";
  const unavailable = report.criteriaGroups?.unavailableInVersion || [];
  const evidenceLimits = report.criteriaGroups?.evidenceLimits || report.failedCriteria;
  const sweepAvailable = analyses.calibration.rows >= (report.policy.minimumAnalysisRows || 12);
  const provenanceKinds = [
    "exact_stored_span",
    "capture_bounds",
    "onset_only",
    "completion_timestamp_fallback",
    "unavailable",
    "retained_exemplar_clip",
  ];
  const exclusionLabel = (reason: string) =>
    reason.startsWith("window_") ? t(`people.calibrationTiming.${reason.slice(7)}`) : reason;
  return (
    <div className="mt-4 space-y-2 text-xs">
      <p className="font-medium" role="status">
        {t(supported ? "people.calibrationSupported" : "people.calibrationUnavailable")}
      </p>
      <p>
        {t(supported ? "people.calibrationReconstructionNotice" : "people.calibrationVersionLimit")}
      </p>
      <p>{t("people.calibrationDurationOverlapNotice")}</p>
      {!supported && (
        <>
          {unavailable.length > 0 && (
            <section className="space-y-1">
              <h3 className="font-medium">{t("people.calibrationUnavailableGroup")}</h3>
              <ul className="list-disc ps-5">
                {unavailable.map((criterion) => (
                  <li key={criterion}>{t(`people.calibrationUnavailableCriteria.${criterion}`)}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="space-y-1">
            <h3 className="font-medium">{t("people.calibrationEvidenceGroup")}</h3>
            <ul className="list-disc ps-5">
              {evidenceLimits.map((criterion) => (
                <li key={criterion}>{t(`people.calibrationAdmission.${criterion}`)}</li>
              ))}
              {Object.entries(evidence.exclusionCounts).map(([reason, count]) => (
                <li key={reason}>
                  {exclusionLabel(reason)}: {count}
                </li>
              ))}
            </ul>
          </section>
          <p>{t("people.calibrationManualAvailable")}</p>
        </>
      )}
      <p>{t("people.calibrationScoredSummary", { rows: analyses.calibration.rows })}</p>
      <p>
        {t("people.calibrationClaimsSummary", {
          machineClaims: evidence.machineClaims,
          minimum: report.policy.minimumMachineClaims,
        })}
      </p>
      <p>
        {t("people.calibrationSourceSummary", {
          savedExemplars: evidence.savedExemplars || 0,
          exemplarRows: evidence.exemplarRows || 0,
          reconstructedRows: evidence.reconstructedRows,
        })}
      </p>
      <section className="space-y-1">
        <h3 className="font-medium">{t("people.calibrationTimingTitle")}</h3>
        <ul className="list-disc ps-5">
          {provenanceKinds.map((kind) => (
            <li key={kind}>
              {t(`people.calibrationTiming.${kind}`)}:{" "}
              {evidence.timingProvenanceCounts?.[kind] || 0}
            </li>
          ))}
        </ul>
      </section>
      {!!evidence.fingerprintIntegrity?.length && (
        <section className="space-y-1">
          <h3 className="font-medium">{t("people.calibrationIntegrityTitle")}</h3>
          {evidence.fingerprintIntegrity.map((item) => (
            <p key={`${item.noteId}:${item.rowId}`}>
              {t("people.calibrationIntegrityItem", {
                noteId: item.noteId,
                rowId: item.rowId,
                reason: t(`people.calibrationIntegrity.${item.reason}`),
              })}
            </p>
          ))}
        </section>
      )}
      <p>{t("people.calibrationEvidenceSummary", evidence)}</p>
      {!!evidence.exemplarRows && (
        <p>{t("people.calibrationExemplars", { samples: evidence.exemplarRows })}</p>
      )}
      <p>{t("people.calibrationCoverageSummary", evidence)}</p>
      {evidence.truncatedByRowBudget && <p>{t("people.calibrationRowCap")}</p>}
      <p>
        {t("people.calibrationProcessingSummary", {
          ...evidence.placementCounts,
          embedded: evidence.embeddingCounts.embedded,
          excluded: evidence.exclusions.length,
        })}
      </p>
      {evidence.missingVectorDiagnostics.map((diagnostic) => (
        <p key={`${diagnostic.noteId}:${diagnostic.reason}`}>
          {t("people.calibrationCompletionMessage", {
            noteId: diagnostic.noteId,
            reason: t(diagnostic.messageKey),
            counters:
              diagnostic.clusters === null || diagnostic.vectorsWritten === null
                ? t("people.calibrationCountersNotRecorded")
                : t("people.calibrationVectorCounts", diagnostic),
            cause: diagnostic.cause || "",
          })}
        </p>
      ))}
      <p>
        {report.scope.kind === "range"
          ? `${report.scope.from} – ${report.scope.to}`
          : t("people.calibrationAll")}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer">{t("people.calibrationDeveloperSweep")}</summary>
        {!supported && <p className="mt-1">{t("people.calibrationDiagnosticOnly")}</p>}
        <p className="mt-1">{t("people.calibrationReconstructionNotice")}</p>
        <p className="mt-1">
          {sweepAvailable
            ? t("people.calibrationAnalysisRows", { rows: analyses.calibration.rows })
            : t("people.calibrationSweepUnavailable", {
                rows: analyses.calibration.rows,
                minimum: report.policy.minimumAnalysisRows,
              })}
        </p>
        {sweepAvailable && (
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full text-start tabular-nums">
              <caption className="sr-only">{t("people.calibrationDiagnosticSweep")}</caption>
              <thead>
                <tr>
                  <th scope="col" className="text-start">
                    {t("people.calibrationFields.similarityFloor")}
                  </th>
                  <th scope="col" className="text-start">
                    {t("people.calibrationFields.runnerUpMargin")}
                  </th>
                  <th scope="col" className="text-start">
                    {t("people.calibrationRight")}
                  </th>
                  <th scope="col" className="text-start">
                    {t("people.calibrationWrong")}
                  </th>
                  <th scope="col" className="text-start">
                    {t("people.calibrationRefused")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {analyses.calibration.table.map((candidate) => (
                  <tr key={`${candidate.similarityFloor}:${candidate.runnerUpMargin}`}>
                    <td>{candidate.similarityFloor}</td>
                    <td>{candidate.runnerUpMargin}</td>
                    <td>{candidate.right}</td>
                    <td>{candidate.wrong}</td>
                    <td>{candidate.refused}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      {supported && (
        <div className="space-y-2">
          {(["similarityFloor", "runnerUpMargin"] as const).map((key) => (
            <p key={key}>
              {t(`people.calibrationFields.${key}`)}: {report.recommended[key]}
            </p>
          ))}
          <p>{t("people.calibrationValidationSummary", report.validation)}</p>
          <p>{t("people.calibrationUncertainty")}</p>
          <Button type="button" variant="outline" onClick={onApply}>
            {t("people.calibrationApply")}
          </Button>
        </div>
      )}
      <details>
        <summary className="cursor-pointer">
          {evidence.exclusions.length} {t("people.calibrationExclusions")}
        </summary>
        <ul className="mt-1 list-disc ps-5">
          {Object.entries(evidence.exclusionCounts).map(([reason, count]) => (
            <li key={reason}>
              {exclusionLabel(reason)}: {count}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
