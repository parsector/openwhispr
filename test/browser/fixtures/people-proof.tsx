import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n";
import PeoplePage from "./components/settings/PeoplePage";
import SidebarModal from "./components/ui/SidebarModal";
import { Users } from "./components/icons";
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
const peopleChanged = new Set<() => void>();
(window as any).peopleProof = {
  refresh: () => peopleChanged.forEach((notify) => notify()),
  rows,
};
(window as any).electronAPI = {
  listPeople: async () => rows.map((row) => ({ ...row })),
  listPeopleActions: async () => {
    if (location.search.includes("history-fail")) throw Error("unavailable");
    return location.search.includes("proof-rich")
      ? [
          {
            id: "action-1",
            kind: "rename",
            label: "Alexandra Rivera",
            noteId: null,
            noteInTrash: false,
            unavailableReason: null,
          },
        ]
      : [];
  },
  listPeopleReview: async () =>
    location.search.includes("reliability")
      ? Array.from({ length: 130 }, (_, index) => ({
          noteId: 42,
          rowId: `row-${index + 1}`,
          noteTitle: "October planning meeting",
          reason: "unassessed",
          candidates: null,
          profileId: 1,
          text: `Review speaker label ${index + 1}.`,
          speakerName: "Alexandra Rivera",
        }))
      : [
          {
            noteId: 42,
            rowId: "row-1",
            noteTitle: "October planning meeting",
            reason: "unassessed",
            candidates: null,
            profileId: 1,
            text: "We should review this speaker label.",
            speakerName: "Alexandra Rivera",
          },
        ],
  onPeopleChanged: (notify: () => void) => {
    peopleChanged.add(notify);
    return () => peopleChanged.delete(notify);
  },
  previewClearVoiceData: async () => ({
    success: true,
    personCount: 20,
    embeddingCount: 2,
    mappingCount: 3,
    noteEmbeddingCount: 4,
    sampleCount: 5,
    candidateCount: 6,
  }),
  clearVoiceData: async () => ({
    success: true,
    id: "clear-1",
    personCount: 20,
    embeddingCount: 2,
    mappingCount: 3,
  }),
  undoClearVoiceData: async () => ({ success: true }),
  speakerCalibrationSettings: async () => {
    if (location.search.includes("calibration-fail")) throw Error("unavailable");
    return {
      values: {
        similarityFloor: 0.6,
        runnerUpMargin: 0.08,
        minimumVoicedSeconds: 3,
        overlapToleranceSeconds: 0.15,
      },
      status: "uncalibrated",
    };
  },
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
  listVoiceEnrollmentCandidates: async (profileId: number) => ({
    candidates:
      profileId === 1
        ? [
            {
              id: "proof-span",
              profileId,
              noteId: 42,
              noteTitle: "October planning meeting",
              meetingDate: "2026-10-30 12:00:00",
              rowIds: ["row-1"],
              track: "mic",
              startSample: 0,
              endSample: 96000,
              durationSeconds: 4,
              everCorrected: true,
            },
          ]
        : [],
    reasons:
      profileId === 1
        ? { short: 0, long: 0, audio: 0, overlap: 0, uncertain: 0, reviewed: 0, limit: 0 }
        : { short: 3, long: 0, audio: 2, overlap: 0, uncertain: 1, reviewed: 0, limit: 0 },
  }),
  listVoiceEnrollmentSamples: async (profileId: number) =>
    location.search.includes("reliability") && profileId === 1
      ? [
          {
            id: "sample-1",
            profileId,
            noteId: 42,
            noteTitle: "October planning meeting",
            meetingDate: "2026-10-30 12:00:00",
            rowIds: ["row-1"],
            odd: true,
          },
        ]
      : [],
};
function ProofPage() {
  const [note, setNote] = React.useState<number | null>(null);
  const peoplePage = (
    <PeoplePage
      onOpenNote={(noteId, rowId) => {
        document.body.dataset.openedNote = String(noteId);
        document.body.dataset.openedRow = rowId;
        if (location.search.includes("reliability")) setNote(noteId);
      }}
    />
  );
  if (note !== null)
    return (
      <main>
        <h1>Transcript {note}</h1>
        <button onClick={() => setNote(null)}>Return to review</button>
      </main>
    );
  return location.search.includes("proof-rich") ? (
    <SidebarModal
      open
      onOpenChange={() => {}}
      title="Settings"
      sidebarItems={[{ id: "people", label: "People", icon: Users }]}
      activeSection="people"
      onSectionChange={() => {}}
    >
      {peoplePage}
    </SidebarModal>
  ) : (
    <main className="mx-auto max-w-[1016px] px-4 pt-7">{peoplePage}</main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <ToastProvider>
      <ProofPage />
    </ToastProvider>
  </I18nextProvider>
);
