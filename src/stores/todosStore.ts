import { create } from "zustand";
import type { Commitment, CommitmentProposal } from "../types/electron";

const ARCHIVE_KEY = "todos-show-archived";
function savedArchivePreference(): boolean {
  try { return localStorage.getItem(ARCHIVE_KEY) === "true"; } catch { return false; }
}

type TodosState = {
  rows: Commitment[];
  proposals: CommitmentProposal[];
  overdueCount: number;
  showArchived: boolean;
  loading: boolean;
  error: string | null;
  filter: { kind: "note" | "person"; value: string; email?: string | null } | null;
  setFilter: (filter: TodosState["filter"]) => void;
  refresh: () => Promise<void>;
  setShowArchived: (show: boolean) => void;
};

export const useTodosStore = create<TodosState>((set, get) => ({
  rows: [], proposals: [], overdueCount: 0, showArchived: savedArchivePreference(),
  loading: false, error: null, filter: null,
  setFilter: (filter) => set({ filter }),
  refresh: async () => {
    set({ loading: true });
    try {
      const [rows, proposals, overdueCount] = await Promise.all([
        window.electronAPI.commitmentsList(get().showArchived),
        window.electronAPI.commitmentsProposalsList(),
        window.electronAPI.commitmentsOverdueCount(),
      ]);
      set({ rows, proposals, overdueCount, loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  setShowArchived: (show) => {
    try { localStorage.setItem(ARCHIVE_KEY, String(show)); } catch { /* unavailable */ }
    set({ showArchived: show });
    void get().refresh();
  },
}));
