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
  return (
    <div className="mt-4 space-y-2 text-xs">
      <p className="font-medium" role="status">
        {t(supported ? "people.calibrationSupported" : "people.calibrationDiagnosticOnly")}
      </p>
      <p>{t("people.calibrationReconstructionNotice")}</p>
      <p>{t("people.calibrationDurationOverlapNotice")}</p>
      {!supported && (
        <>
          <p>{t("people.calibrationNoApply")}</p>
          <ul className="list-disc ps-5">
            {report.failedCriteria.map((criterion) => (
              <li key={criterion}>{t(`people.calibrationAdmission.${criterion}`)}</li>
            ))}
          </ul>
          <p>{t("people.calibrationNextAction")}</p>
        </>
      )}
      <p>{t("people.calibrationEvidenceSummary", evidence)}</p>
      {!!evidence.exemplarRows && (
        <p>{t("people.calibrationExemplars", { samples: evidence.exemplarRows })}</p>
      )}
      <p>{t("people.calibrationCoverageSummary", evidence)}</p>
      {evidence.truncatedByRowBudget && <p>{t("people.calibrationRowCap")}</p>}
      <p>
        {t("people.calibrationPlacementSummary", {
          ...evidence.placementCounts,
          embedded: evidence.embeddingCounts.embedded,
          refused: evidence.embeddingCounts.refused,
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
        <summary className="cursor-pointer">{t("people.calibrationDiagnosticSweep")}</summary>
        <p className="mt-1">
          {t("people.calibrationAnalysisRows", { rows: analyses.calibration.rows })}
        </p>
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
              {reason}: {count}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
