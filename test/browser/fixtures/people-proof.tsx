import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import PeoplePage from "./components/settings/PeoplePage";
import { ToastProvider } from "./components/ui/Toast";
import "./index.css";

const rows = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  displayName:
    i === 0
      ? "Alexandra Rivera"
      : i === 1
        ? "Alexndra Rivera"
        : i === 2
          ? "Maya Chen"
          : i === 3
            ? "Nikos Papadopoulos"
            : `Person ${i + 1}`,
  email:
    i === 0
      ? "alexandra@example.test"
      : i === 1
        ? "alexndra@example.test"
        : i === 2
          ? "maya@example.test"
          : `person${i + 1}@example.test`,
  noteCount: i === 0 ? 10 : i === 1 ? 1 : 2,
  segmentCount: i === 0 ? 895 : i === 1 ? 2 : 4,
  meetingCount: i === 0 ? 10 : 1,
  lastSeen: i === 0 ? "2026-10-30 12:00:00" : "2026-11-02 12:00:00",
  lastHeard: null,
  duplicates: i === 0 ? [{ id: 2, name: "Alexndra Rivera" }] : [],
  hasVoice: i === 2 || i === 3,
  needsReapproval: false,
  usedOnce: i === 2,
  legacyVoice: false,
  voiceProgress: {
    usable: i === 3,
    cleanSpans: i === 3 ? 3 : 0,
    meetings: i === 3 ? 2 : 0,
    conflict: false,
  },
}));
(window as any).electronAPI = {
  listPeople: async () => rows.map((row) => ({ ...row })),
  listPeopleActions: async () => [],
  onPeopleChanged: () => () => {},
  speakerCalibrationSettings: async () => ({
    values: {
      similarityFloor: 0.6,
      runnerUpMargin: 0.08,
      minimumVoicedSeconds: 3,
      overlapToleranceSeconds: 0.15,
    },
    status: "uncalibrated",
  }),
  speakerCalibrationProgress: async () => null,
  previewPersonAction: async () => ({
    success: true,
    noteCount: 10,
    segmentCount: 895,
    pinnedCount: 3,
    historyCount: 2,
    noteEmbeddingCount: 4,
    voiceSamples: 2,
  }),
  applyPersonAction: async (request: any) => {
    if (request.type === "rename")
      rows.find((row) => row.id === request.profileId)!.displayName = request.name;
    return { success: true, id: "proof-action-1", noteCount: 10, segmentCount: 895 };
  },
  listVoiceEnrollmentCandidates: async () => [],
  listVoiceEnrollmentSamples: async () => [],
};
createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <ToastProvider>
      <main className="mx-auto max-w-[1016px] px-4 pt-7">
        <PeoplePage />
      </main>
    </ToastProvider>
  </I18nextProvider>
);
