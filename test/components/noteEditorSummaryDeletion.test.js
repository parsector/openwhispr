const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Visit every element in the tree the component returned.
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node.props) return;
  visit(node);
  walk(node.props.children, visit);
}

// The segmented-control buttons by their data-segment-value.
function collectSegments(tree) {
  const out = new Map();
  walk(tree, (node) => {
    const value = node.props["data-segment-value"];
    if (value) out.set(value, node);
  });
  return out;
}

// Every `value` a rich-text editor in the tree was handed — the body content.
function collectEditorValues(tree) {
  const out = [];
  walk(tree, (node) => {
    if (typeof node.props.value === "string") out.push(node.props.value);
  });
  return out;
}

function activeSegment(segments) {
  // The active tab is the one rendered with the full-strength label colour;
  // the inactive ones get text-foreground/60.
  const active = [];
  for (const [value, node] of segments) {
    const className = String(node.props.className ?? "");
    if (/(^|\s)text-foreground($|\s)/.test(className)) active.push(value);
  }
  return active;
}

// The strip is the element the component measures through its ref; its first
// child is the sliding highlight, positioned through its inline style.
function findSegmentStrip(tree) {
  let strip = null;
  walk(tree, (node) => {
    if (strip) return;
    const children = React.Children.toArray(node.props.children);
    if (children.some((child) => child.props?.["data-segment-button"])) strip = node;
  });
  return strip;
}

function highlightStyle(tree) {
  return React.Children.toArray(findSegmentStrip(tree).props.children)[0].props.style;
}

// The harness DOM has no layout, so the tests hand the component a strip it can
// measure: tabs laid out left to right from the strip's left edge.
const TAB_BOXES = {
  transcript: { left: 2, width: 100, height: 26 },
  raw: { left: 102, width: 90, height: 26 },
  enhanced: { left: 192, width: 110, height: 26 },
};

function measurableStrip(values) {
  const buttons = values.map((value) => ({
    dataset: { segmentValue: value },
    getBoundingClientRect: () => ({ top: 0, ...TAB_BOXES[value] }),
  }));
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 310, height: 30 }),
    querySelectorAll: () => buttons,
  };
}

const NOTE = {
  id: 1,
  client_note_id: "note-1",
  cloud_id: null,
  title: "Kickoff",
  content: "plain notes body",
  enhanced_content: "AI summary body",
  transcript: "",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  space_id: null,
  folder_id: null,
  participants: JSON.stringify([
    { email: "dana@example.com", displayName: "Dana Wu", responseStatus: null, self: false },
  ]),
};

const ENHANCEMENT = { content: NOTE.enhanced_content, isStale: false, onChange() {} };

for (const action of ["correction", "undo"]) {
  test(`live ${action} in NoteEditor preserves sibling identification windows`, async t => {
    let store;
    t.after(() => store?.stopRecording());
    installMicCaptureGlobals(t);
    navigator.userAgent = "test";
    const { render, click, latest, unmount, vite } = await loadNoteEditor(t);
    const callbacks = {};
    Object.assign(window.electronAPI, {
      checkSystemAudioAccess: async () => ({ granted: true, status: "granted", mode: "native", strategy: "native" }),
      meetingTranscriptionStart: async () => ({ success: true, systemAudioMode: "native", systemAudioStrategy: "native" }),
      meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
      meetingTranscriptionStop: async () => ({ success: true }),
      meetingTranscriptionSend() {}, getNote: async () => ({...NOTE,participants:'[]',speaker_roster_revision:0,transcript:'[]'}), updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: cb => { callbacks.segment = cb; return () => {}; },
      onMeetingSpeakerIdentified: cb => { callbacks.identify = cb; return () => {}; },
    });
    store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
    assert.equal(await store.startRecording({ noteId: NOTE.id, noteTitle: NOTE.title, folderId: null }), true);
    const now = Date.now();
    const evidence = { origin: "machine", decisionId: "accepted", noteId: NOTE.id, source: "note", rawRoster: "[]", rosterRevision: 0, eligibleProfileIds: [1], acceptedProfileId: 1, rejectionReason: null };
    const final = (text, timestamp) => callbacks.segment({ type: "final", source: "system", text, timestamp });
    final("affected", now);
    callbacks.identify({ speakerId: "speaker_0", displayName: "A", speakerDecision: evidence, startTime: now - 100, endTime: now + 500 });
    final("sibling", now + 1000);
    callbacks.identify({ speakerId: "speaker_1", displayName: "Sibling", speakerDecision: evidence, startTime: now + 900, endTime: now + 1500 });
    window.electronAPI.applySpeakerCorrection = async request => ({
      success: true,
      affectedRowIds:request.rows.filter(row=>row.speaker === "speaker_0").map(row=>row.id),
      rows: request.rows.map(row => row.speaker === "speaker_0"
        ? { ...row, speakerName: action === "undo" ? undefined : "B", speakerLocked: action !== "undo", speakerIsPlaceholder: action === "undo" }
        : row),
      mapping: { clusterId: "speaker_0", runId: store.getActiveRecordingSessionId(), value: action === "undo" ? null : { display_name: "B" } },
    });
    await render(undefined, { isRecording: true });
    await click("transcript");
    await React.act(async () => {
      let chat;
      walk(latest(), node => { if (node.props.onMapSpeaker) chat = node; });
      assert.ok(chat);
      if (action === "undo") await chat.props.onUndoCorrection("correction-id");
      else await chat.props.onMapSpeaker("speaker_0", "B");
    });
    final("covered sibling", now + 1100);
    const rows = () => store.useMeetingRecordingStore.getState().segments;
    assert.equal(rows().find(row => row.text === "covered sibling").speakerName, "Sibling");
    final("covered affected", now + 100);
    assert.equal(rows().find(row => row.text === "covered affected").speakerName, action === "undo" ? undefined : "B");
    await unmount();
  });
}

test("imported and failed-analysis rows do not claim a post-final correction", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = clearTimeout;
  const requests = [];
  globalThis.window.electronAPI.applySpeakerCorrection = async (request) => {
    requests.push(request);
    return { success: true, rows: request.rows };
  };
  const correctionControl = () => {
    let control;
    walk(latest(), (node) => {
      if (node.type?.name === "MeetingTranscriptChat") control = node;
    });
    return control.props;
  };
  try {
    for (const [index, [kind, completed]] of [
      ["imported", false],
      ["failed", false],
      ["completed", true],
    ].entries()) {
      const note = {
        ...NOTE,
        id: index + 1,
        note_type: kind === "imported" ? "upload" : "meeting",
        transcript: JSON.stringify([
          {
            id: "row-a",
            text: "hello",
            source: "system",
            speaker: "speaker_0",
            finalAnalysisCompleted: completed,
          },
        ]),
      };
      await render(undefined, { note });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await click("transcript");
      const control = correctionControl();
      await React.act(async () =>
        control.onAssignSpeakerScope("row", control.segments[0].id, "Sam")
      );
    }
    assert.deepEqual(
      requests.map((request) => request.afterFinalAnalysis),
      [false, false, true]
    );
  } finally {
    await unmount();
  }
});

// The summary callout runs a template, so the note view needs one loaded.
const TEMPLATE = {
  id: 1,
  client_id: "notes.actions.builtin.detailedNotes",
  kind: "template",
  name: "Detailed Notes",
  description: "",
  prompt: "",
  sections: [{ heading: "Summary", instruction: "" }],
  output: null,
  translation_key: "notes.actions.builtin.detailedNotes",
};
const DEFAULT_TEMPLATE = {
  ...TEMPLATE,
  id: 2,
  client_id: "notes.actions.builtin.generateNotes",
  name: "AI Summary",
  prompt: "Summarize the note.",
  sections: null,
  translation_key: "notes.actions.builtin.generateNotes",
};

function baseProps(enhancement) {
  return {
    note: { ...NOTE, enhanced_content: enhancement ? enhancement.content : null },
    onTitleChange() {},
    onContentChange() {},
    isSaving: false,
    isRecording: false,
    isProcessing: false,
    onStartRecording() {},
    onStopRecording() {},
    enhancement,
  };
}

async function loadNoteEditor(t, permission) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getSpeakerProfiles: async () => [],
        getSpeakerMappings: async () => [],
        getActions: async () => [TEMPLATE, DEFAULT_TEMPLATE, ...(globalThis.__noteActions ?? [])],
        applySpeakerCorrection: async (request) => {
          const ids = new Set(request.rowIds || []);
          const rows = request.rows.map((row) => {
            const affected = request.scope === "cluster"
              ? row.speaker === request.target?.clusterId && row.diarizationRunId === request.target?.runId
              : ids.has(row.id);
            return affected ? { ...row, speakerName: request.name, speakerLocked: true } : row;
          });
          await globalThis.window.electronAPI.updateNote?.(request.noteId, {
            transcript: JSON.stringify(rows),
          });
          return { success: true, rows, affectedRowIds:rows.filter(row=>row.speakerLocked).map(row=>row.id) };
        },
      },
    },
  });
  const container = installHookDom(t);
  const resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    delete globalThis.ResizeObserver;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-editor-summary-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        const i18n = { resolvedLanguage: "en", language: "en" };
        export function useTranslation() { return { t, i18n }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/RichTextEditor": `
        export function RichTextEditor(props) { return null; }
      `,
      "./MeetingTranscriptChat": `
        export function MeetingTranscriptChat() { return null; }
        export function SelectionBar() { return null; }
      `,
      "/EmbeddedChat": `export default function EmbeddedChat() { return null; }`,
      "/hooks/useAuth": `
        export function useAuth() {
          return globalThis.__noteEditorAuth ?? { isSignedIn: false, user: null };
        }
      `,
      "/hooks/useEmbeddedChat": `
        export function useEmbeddedChat(options) {
          globalThis.__embeddedChatOptions = options;
          return {
            messages: globalThis.__embeddedChatMessages ?? [],
            noteConversations: globalThis.__embeddedChatConversations,
            switchConversation() {},
            agentState: globalThis.__embeddedChatAgentState ?? "idle",
            sendMessage: (...args) => globalThis.__embeddedChatSent?.push(args),
            sendInNewChat: (...args) => globalThis.__embeddedChatSent?.push(["new chat", ...args]),
            send() {},
            reset() {},
            isStreaming: false,
            containerRef: { current: null },
          };
        }
      `,
      "/services/NoteSharingService": `
        export const NoteSharingService = {
          fetchAcl: async () => null,
          // A signed-in cloud note loads its sharing state; never answered here.
          getShareSettings: () => new Promise(() => {}),
        };
      `,
      "/hooks/useSpaceRoster": `export async function fetchSpaceRoster() { return []; }
export function useSpaceRoster(cloudSpaceId) {
  globalThis.__noteEditorRosterId = cloudSpaceId;
  return globalThis.__noteEditorRoster ? new Map(globalThis.__noteEditorRoster.map(member => [member.user_id, member])) : null;
}`,
    },
  });

  if (permission) {
    const { updateShareCache } = await vite.ssrLoadModule("/stores/noteStore.ts");
    updateShareCache("shared-note", () => ({
      share: { visibility: "private" },
      invitations: [],
      rawToken: null,
      access: { my_permission: permission },
    }));
  }
  const mod = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");
  const NoteEditor = mod.default;

  const renders = [];
  function Harness({ enhancement, overrides }) {
    // Run the real component body + hooks under React's lifecycle without
    // mounting host elements (the harness DOM has no layout), then assert on
    // the tree it returned.
    renders.push(NoteEditor({ ...baseProps(enhancement), ...overrides }));
    return null;
  }

  const root = createRoot(container);
  const render = (enhancement, overrides) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { enhancement, overrides }));
    });
  // The AI Summary tab wraps its label button and the template chevron.
  const click = (value) =>
    React.act(async () => {
      let target = null;
      walk(collectSegments(renders.at(-1)).get(value), (node) => {
        if (!target && node.props.onClick) target = node;
      });
      target.props.onClick();
    });
  const latest = () => renders.at(-1);
  const unmount = () => React.act(async () => root.unmount());
  return { render, click, latest, unmount, resizeCallbacks, vite };
}

test("deleting the AI summary moves the selection to Your notes", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  const withSummary = collectSegments(latest());
  assert.deepEqual([...withSummary.keys()].sort(), ["enhanced", "raw", "transcript"]);
  assert.deepEqual(activeSegment(withSummary), ["enhanced"], "AI Summary starts selected");

  // The user clears the summary text: RichTextEditor emits "", the draft stores
  // "", and PersonalNotesView stops passing an enhancement at all.
  await render(undefined);
  const afterDelete = collectSegments(latest());
  assert.deepEqual(
    [...afterDelete.keys()].sort(),
    ["raw", "transcript"],
    "the AI Summary button is gone"
  );
  // The body already falls back — only the tab strip disagreed with it.
  assert.ok(
    collectEditorValues(latest()).includes(NOTE.content),
    "the body renders the plain notes content"
  );
  assert.deepEqual(
    activeSegment(afterDelete),
    ["raw"],
    "selection falls back to Your notes instead of pointing at a tab that no longer exists"
  );

  await unmount();
});

test("a mounted recording editor refreshes people and follows same-note row navigation", async (t) => {
  const { render, latest } = await loadNoteEditor(t);
  let profileReads = 0,
    mappingReads = 0,
    peopleChanged;
  window.electronAPI.getSpeakerProfiles = async () => {
    profileReads++;
    return [];
  };
  window.electronAPI.getSpeakerMappings = async () => {
    mappingReads++;
    return [];
  };
  window.electronAPI.onPeopleChanged = (callback) => {
    peopleChanged = callback;
    return () => {};
  };
  const listeners = new Map();
  window.addEventListener = (type, callback) => listeners.set(type, callback);
  window.removeEventListener = (type) => listeners.delete(type);
  window.dispatchEvent = (event) => listeners.get(event.type)?.(event);
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.sessionStorage = {
    removeItem() {},
    getItem() {
      return null;
    },
  };
  await render(null, {
    isRecording: true,
    note: {
      ...NOTE,
      transcript: JSON.stringify([
        { id: "row-1", text: "hello", source: "system", speaker: "speaker_0" },
      ]),
    },
  });
  assert.equal(typeof peopleChanged, "function");
  const initialProfileReads = profileReads,
    initialMappingReads = mappingReads;
  await React.act(async () => {
    peopleChanged();
    await Promise.resolve();
  });
  assert.ok(profileReads > initialProfileReads);
  assert.ok(mappingReads > initialMappingReads);
  await React.act(async () => {
    window.dispatchEvent({
      type: "people-review-navigate",
      detail: { noteId: NOTE.id, rowId: "row-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  let resolveOldProfiles, resolveOldMappings;
  window.electronAPI.getSpeakerProfiles = () =>
    new Promise((resolve) => {
      resolveOldProfiles = resolve;
    });
  window.electronAPI.getSpeakerMappings = () =>
    new Promise((resolve) => {
      resolveOldMappings = resolve;
    });
  peopleChanged();
  window.electronAPI.getSpeakerProfiles = async () => [
    { id: 11, display_name: "Sam", email: null },
  ];
  window.electronAPI.getSpeakerMappings = async () => [
    { speaker_id: "speaker_0", display_name: "Sam" },
  ];
  await React.act(async () => {
    peopleChanged();
    await Promise.resolve();
  });
  await React.act(async () => {
    resolveOldProfiles([{ id: 10, display_name: "Alex", email: null }]);
    resolveOldMappings([{ speaker_id: "speaker_0", display_name: "Alex" }]);
    await Promise.resolve();
  });
  const liveProps = [];
  walk(latest(), (node) => {
    if (Array.isArray(node.props.speakerProfiles) && node.props.speakerMappings)
      liveProps.push(node.props);
  });
  assert.ok(
    liveProps.some((props) =>
      props.speakerProfiles.some((profile) => profile.display_name === "Sam")
    )
  );
  assert.ok(liveProps.some((props) => props.speakerMappings.speaker_0 === "Sam"));
  assert.ok(
    liveProps.every(
      (props) => !props.speakerProfiles.some((profile) => profile.display_name === "Alex")
    )
  );
  await React.act(async () => {
    window.dispatchEvent({
      type: "people-review-navigate",
      detail: { noteId: NOTE.id, rowId: "row-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(collectSegments(latest()).get("transcript") !== undefined, true);
  let focusRow;
  walk(latest(), (node) => {
    if (node.props.focusRowId) focusRow = node.props.focusRowId;
  });
  assert.equal(focusRow, "row-1");
});

test("an uploaded transcript opens in Transcript and leaves Your notes available for writing", async (t) => {
  const { createDb } = require("../helpers/harness/db");
  const db = createDb(t);
  assert.ok(db);
  let cleanup = () => {};
  t.after(() => cleanup());
  const { render, click, latest, unmount, vite } = await loadNoteEditor(t);
  cleanup = unmount;
  Object.assign(globalThis.window.electronAPI, {
    saveNote: async (...args) => db.saveNote(...args),
    updateNote: async (...args) => db.updateNote(...args),
  });
  const { saveUploadNote } = await vite.ssrLoadModule("/services/uploadNotes.ts");
  const text = "Uploaded words.\nAnother paragraph.";
  const saved = await saveUploadNote({
    title: "Uploaded meeting",
    text,
    sourceName: "public-fixture.wav",
    folderId: null,
    diarization: { enabled: false, localModelsReady: false, numSpeakers: null },
  });
  const note = db.getNote(saved.note.id);
  await render(undefined, { note });
  // No click: an upload without notes opens on its transcript.
  let transcript = null;
  walk(latest(), (node) => {
    if (node.props.segments) transcript = node.props.segments;
  });
  assert.deepEqual(
    transcript?.map((segment) => segment.text),
    [text]
  );
  await click("raw");
  assert.ok(collectEditorValues(latest()).includes(""), "Your notes starts empty");
  db.updateNote(note.id, { content: "My own reminder" });
  await render(undefined, { note: db.getNote(note.id) });
  await click("raw");
  assert.ok(collectEditorValues(latest()).includes("My own reminder"));
  await click("transcript");
  transcript = null;
  walk(latest(), (node) => {
    if (node.props.segments) transcript = node.props.segments;
  });
  assert.deepEqual(
    transcript.map((segment) => segment.text),
    [text]
  );
  await unmount();
  cleanup = () => {};
});

test("the highlight slides onto Your notes when the summary is deleted", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  const strip = findSegmentStrip(latest());
  strip.props.ref.current = measurableStrip(["transcript", "raw", "enhanced"]);
  // Take a real measurement over the AI Summary tab, as the app has by the time
  // the user starts deleting.
  await click("transcript");
  await click("enhanced");
  assert.deepEqual(highlightStyle(latest()), {
    width: 110,
    height: 26,
    transform: "translateX(192px)",
    opacity: 1,
  });

  strip.props.ref.current = measurableStrip(["transcript", "raw"]);
  await render(undefined);
  assert.deepEqual(
    highlightStyle(latest()),
    { width: 90, height: 26, transform: "translateX(102px)", opacity: 1 },
    "the highlight moved onto Your notes instead of freezing over the removed tab"
  );

  await unmount();
});

test("hides the highlight instead of freezing it when no tab matches the selection", async (t) => {
  const { render, click, latest, unmount, resizeCallbacks } = await loadNoteEditor(t);

  await render(undefined);
  const strip = findSegmentStrip(latest());
  strip.props.ref.current = measurableStrip(["transcript", "raw"]);
  await click("transcript");
  await click("raw");
  assert.equal(highlightStyle(latest()).opacity, 1);

  // The strip lost the selected tab's button: the net under the whole bug class,
  // reached through the same resize measurement the app performs.
  strip.props.ref.current = measurableStrip(["transcript"]);
  await React.act(async () => resizeCallbacks.at(-1)());
  assert.deepEqual(
    highlightStyle(latest()),
    { width: 90, height: 26, transform: "translateX(102px)", opacity: 0 },
    "the highlight fades in place rather than staying lit over nothing"
  );

  await unmount();
});

test("a typed note without a summary wires the default template to the callout", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(undefined, { onRunNoteAction: (action) => ran.push(action.client_id) });
  let callout = null;
  walk(latest(), (node) => {
    if (!callout && "onAskSubmit" in node.props) callout = node.props.callout;
  });
  assert.ok(callout, "notes with no transcript still offer a summary");
  assert.equal(callout.props.savedTemplateId ?? null, null);
  const defaultTemplate = callout.props.templates.find(
    (template) => template.client_id === DEFAULT_TEMPLATE.client_id
  );
  assert.ok(defaultTemplate, "the callout receives the default template");
  callout.props.onRun(defaultTemplate);
  assert.deepEqual(ran, [DEFAULT_TEMPLATE.client_id]);

  await unmount();
});

test("the summary callout makes way for the transcript selection bar", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  const propsWith = (key) => {
    let found = null;
    walk(latest(), (node) => {
      if (!found && key in node.props) found = node.props;
    });
    return found;
  };

  await render(undefined, {
    note: {
      ...NOTE,
      enhanced_content: null,
      transcript: JSON.stringify([{ text: "Hello", source: "mic", timestamp: 0 }]),
    },
    onRunNoteAction() {},
  });
  findSegmentStrip(latest()).props.ref.current = measurableStrip(["transcript", "raw"]);
  await click("transcript");
  assert.ok(propsWith("onAskSubmit").callout, "a transcript without a summary offers one");

  const transcript = propsWith("onToggleSelect");
  await React.act(async () => transcript.onToggleSelect(transcript.segments[0].id));
  assert.ok(propsWith("onAssignName"), "selecting a segment shows the selection bar");
  // Both float in the same bottom strip; the callout would cover the bar's buttons.
  assert.ok(
    !propsWith("onAskSubmit").callout,
    "the callout steps aside while segments are selected"
  );

  await unmount();
});

test("the note's chat gets the note's participants, parsed once", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
  });
  const { render, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);

  assert.deepEqual(
    globalThis.__embeddedChatOptions.noteParticipants,
    JSON.parse(NOTE.participants)
  );
  assert.equal(globalThis.__embeddedChatOptions.noteId, NOTE.id);
  await unmount();
});

test("the note's chat learns who is viewing the note and its calendar event", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
    delete globalThis.__noteEditorAuth;
  });
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "user-chad", email: "chad@example.com" },
  };
  const { render, unmount } = await loadNoteEditor(t);
  const options = () => globalThis.__embeddedChatOptions;

  // A local note is the user's own.
  await render(ENHANCEMENT, { note: { ...NOTE, calendar_event_id: "evt-1" } });
  assert.equal(options().noteOwnedByUser, true);
  assert.equal(options().selfEmail, "chad@example.com");
  assert.equal(options().noteCalendarEventId, "evt-1");

  // A team note someone else recorded is not.
  await render(ENHANCEMENT, {
    note: {
      ...NOTE,
      cloud_id: "cloud-1",
      owner_user_id: "user-alice",
      calendar_event_id: null,
    },
  });
  assert.equal(options().noteOwnedByUser, false);
  assert.equal(options().noteCalendarEventId, null);
  await unmount();
});

test("the note's chat labels speakers as get_note does and leaves attendees to the attendee block", async (t) => {
  t.after(() => {
    delete globalThis.__embeddedChatOptions;
    delete globalThis.__noteEditorAuth;
  });
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "user-chad", name: "Chad", email: "chad@example.com" },
  };
  const { render, unmount } = await loadNoteEditor(t);
  const transcript = JSON.stringify([
    { text: "I'll send the deck.", source: "mic", timestamp: 0 },
    { text: "Thanks.", source: "system", timestamp: 3 },
  ]);
  const chatTranscript = () => globalThis.__embeddedChatOptions.noteTranscript;

  const lines = "Unknown speaker 1: I'll send the deck.\nUnknown speaker 2: Thanks.";
  await render(ENHANCEMENT, { note: { ...NOTE, transcript } });
  assert.equal(
    chatTranscript(),
    `## Meeting Context\nThe note taker is Chad <chad@example.com>.\n\n${lines}`
  );
  assert.doesNotMatch(chatTranscript(), /Dana Wu|Invited participants/);

  // A teammate's recording: its note taker is the teammate, so the user isn't named.
  await render(ENHANCEMENT, {
    note: { ...NOTE, transcript, cloud_id: "cloud-1", owner_user_id: "user-alice" },
  });
  assert.equal(
    chatTranscript(),
    `## Meeting Context\nSomeone other than the user took these notes.\n\n${lines}`
  );
  await unmount();
});

// The note's ask bar.
function findBottomBar(tree) {
  let bar = null;
  walk(tree, (node) => {
    if (!bar && "onAskSubmit" in node.props) bar = node;
  });
  return bar;
}

test("the collapsed composer keeps its send button while the note has no actions", async (t) => {
  const { render, latest, unmount } = await loadNoteEditor(t);
  await render(ENHANCEMENT);
  assert.ok(!findBottomBar(latest()).props.actionPicker);
  await unmount();
});

function findDockedChat(tree) {
  let chat = null;
  walk(tree, (node) => {
    if (!chat && "onSwitchConversation" in node.props) chat = node;
  });
  return chat;
}

const FOLLOW_UP = {
  ...TEMPLATE,
  id: 3,
  client_id: "follow-up",
  kind: "action",
  name: "Follow-up",
  prompt: "Draft a follow-up.",
  sections: null,
  output: "chat",
  translation_key: null,
};

test("Create to-dos still extracts when no toast provider is mounted", async (t) => {
  const makeTodos = { ...FOLLOW_UP, translation_key: "notes.actions.builtin.makeTodos" };
  globalThis.__noteActions = [makeTodos];
  t.after(() => delete globalThis.__noteActions);
  const { render, latest, unmount } = await loadNoteEditor(t);
  const calls = [];
  window.electronAPI.commitmentsExtractSummaryNote = async (noteId) => {
    calls.push(["extract", noteId]);
    return { created: 1 };
  };
  await render(ENHANCEMENT, {
    onFlushPendingSaves: async (noteId) => calls.push(["flush", noteId]),
  });
  await React.act(async () => {
    findBottomBar(latest()).props.actionPicker.props.onRunAction(makeTodos);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(calls, [["flush", NOTE.id], ["extract", NOTE.id]]);
  await unmount();
});

test("a question sent from the ask bar opens the docked chat in a new conversation", async (t) => {
  globalThis.__embeddedChatSent = [];
  t.after(() => delete globalThis.__embeddedChatSent);
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onInputFocus());
  assert.equal(findBottomBar(latest()).props.chatOpen, true, "focus still unfolds the bar");
  assert.equal(findDockedChat(latest()), null);

  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("What did we decide?"));
  const bar = findBottomBar(latest());
  assert.equal(bar.props.chatOpen, false);
  assert.equal(bar.props.hideInput, true, "the ask bar folds away");
  assert.ok(findDockedChat(latest()), "the docked chat opens");
  assert.deepEqual(globalThis.__embeddedChatSent, [["new chat", "What did we decide?"]]);
  await unmount();
});

test("the docked chat holds the conversation and its history, and its chips continue it", async (t) => {
  const messages = [{ id: "m1", role: "user", content: "Who owns the copy pass?" }];
  const conversations = [{ id: 7, title: "Copy pass", updated_at: "2026-10-08" }];
  globalThis.__noteActions = [FOLLOW_UP];
  globalThis.__embeddedChatMessages = messages;
  globalThis.__embeddedChatConversations = conversations;
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatMessages;
    delete globalThis.__embeddedChatConversations;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("And the deadline?"));
  const docked = findDockedChat(latest()).props;
  assert.equal(docked.messages, messages);
  assert.equal(docked.noteConversations, conversations);

  await React.act(async () => docked.actionChips.props.onRunAction(FOLLOW_UP));
  const [cta, options] = globalThis.__embeddedChatSent.at(-1);
  assert.equal(cta, "Follow-up", "the docked chat's own chip continues the open conversation");
  assert.ok(options.requestText.includes("Draft a follow-up."));
  assert.equal(options.keepNotesUnchanged, true, "and can't change the note");
  await unmount();
});

test("a chat action from the collapsed picker opens the docked chat, with the actions", async (t) => {
  globalThis.__noteActions = [FOLLOW_UP];
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(ENHANCEMENT, { onRunNoteAction: (action) => ran.push(action.client_id) });
  const bar = findBottomBar(latest());
  await React.act(async () => bar.props.actionPicker.props.onRunAction(FOLLOW_UP));

  const docked = findDockedChat(latest());
  assert.ok(docked, "the docked chat opens without the bar ever unfolding");
  const chips = docked.props.actionChips.props;
  assert.equal(chips.docked, true);
  assert.deepEqual(chips.actions, [FOLLOW_UP]);
  assert.equal(docked.props.slashCommands.length, 1, "and offers the same / menu");
  assert.deepEqual(ran, []);
  const [[marker, shown, { requestText, keepNotesUnchanged }]] = globalThis.__embeddedChatSent;
  assert.equal(marker, "new chat", "from the ask bar it starts a new conversation");
  assert.equal(shown, "Follow-up");
  assert.ok(requestText.includes("Draft a follow-up."));
  assert.equal(keepNotesUnchanged, true, "its result goes in the chat, never into the note");
  await unmount();
});

test("a summary action from the collapsed picker runs on the summary and leaves the chat closed", async (t) => {
  const shorten = {
    ...TEMPLATE,
    id: 4,
    client_id: "shorten",
    kind: "action",
    name: "Shorten",
    prompt: "Shorten it.",
    sections: null,
    output: "summary",
    translation_key: null,
  };
  globalThis.__noteActions = [shorten];
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__noteActions;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);
  const ran = [];

  await render(ENHANCEMENT, { onRunNoteAction: (action) => ran.push(action.client_id) });
  const bar = findBottomBar(latest());
  await React.act(async () => bar.props.actionPicker.props.onRunAction(shorten));

  assert.deepEqual(ran, ["shorten"]);
  assert.equal(findDockedChat(latest()), null);
  assert.deepEqual(globalThis.__embeddedChatSent, []);
  await unmount();
});

test("a question sent while a reply is still coming waits as the docked chat's draft", async (t) => {
  globalThis.__embeddedChatAgentState = "streaming";
  globalThis.__embeddedChatSent = [];
  t.after(() => {
    delete globalThis.__embeddedChatAgentState;
    delete globalThis.__embeddedChatSent;
  });
  const { render, latest, unmount } = await loadNoteEditor(t);

  await render(ENHANCEMENT);
  await React.act(async () => findBottomBar(latest()).props.onAskSubmit("And the budget?"));
  assert.deepEqual(globalThis.__embeddedChatSent, []);
  assert.equal(findDockedChat(latest()).props.draftText, "And the budget?");
  await unmount();
});

for (const surface of ["picker", "floating", "sidebar", "slash"]) {
  test(`${surface} dispatch, busy states and hints follow the destination`, async (t) => {
    const rows = [
      FOLLOW_UP,
      {
        ...FOLLOW_UP,
        id: 4,
        client_id: "tldr",
        is_builtin: 1,
        translation_key: "notes.actions.builtin.addTldr",
      },
      {
        ...FOLLOW_UP,
        id: 5,
        client_id: "custom",
        name: "Make notes shorter",
        is_builtin: 0,
        translation_key: null,
      },
      ...["shorten", "lengthen"].map((key, i) => ({
        ...FOLLOW_UP,
        id: 6 + i,
        client_id: key,
        is_builtin: 1,
        translation_key: `notes.actions.builtin.${key}`,
        output: "summary",
      })),
    ];
    globalThis.__noteActions = rows;
    globalThis.__embeddedChatSent = [];
    t.after(() => {
      delete globalThis.__noteActions;
      delete globalThis.__embeddedChatSent;
      delete globalThis.__embeddedChatAgentState;
    });
    let cleanup;
    t.after(() => cleanup?.());
    const { render, latest, unmount } = await loadNoteEditor(t);
    const originalHTMLElement = globalThis.HTMLElement;
    globalThis.HTMLElement = globalThis.window.HTMLElement;
    cleanup = async () => {
      await unmount();
      if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = originalHTMLElement;
    };
    const written = [];
    const overrides = { onRunNoteAction: (a) => written.push(a.client_id) };
    await render(ENHANCEMENT, overrides);
    if (surface === "floating")
      await React.act(async () => findBottomBar(latest()).props.onInputFocus());
    if (surface === "sidebar")
      await React.act(async () => findBottomBar(latest()).props.onAskSubmit("open"));
    const bar = findBottomBar(latest());
    const commands =
      surface === "sidebar"
        ? findDockedChat(latest()).props.slashCommands
        : bar.props.slashCommands;
    const controls =
      surface === "picker"
        ? bar.props.actionPicker.props
        : surface === "sidebar"
          ? findDockedChat(latest()).props.actionChips.props
          : bar.props.actionChips.props;
    // The same dispatch callbacks feed the actual chips and All actions menu.
    for (const row of rows) {
      await React.act(async () =>
        surface === "slash"
          ? commands.find((c) => c.id === row.client_id).run()
          : controls.onRunAction(row)
      );
    }
    assert.deepEqual(written, ["shorten", "lengthen"]);
    assert.equal(globalThis.__embeddedChatSent.length, surface === "sidebar" ? 4 : 3);
    if (!findDockedChat(latest()))
      await React.act(async () => findBottomBar(latest()).props.onAskSubmit("reopen"));
    const currentCommands = findDockedChat(latest()).props.slashCommands;
    assert.deepEqual(
      currentCommands.map((c) => c.hint),
      [
        "notes.actions.output.chat",
        "notes.actions.output.chat",
        "notes.actions.output.chat",
        "notes.actions.output.summary",
        "notes.actions.output.summary",
      ]
    );
    globalThis.__embeddedChatAgentState = "streaming";
    await render(ENHANCEMENT, overrides);
    assert.deepEqual(
      findDockedChat(latest()).props.slashCommands.map((c) => c.disabled),
      [true, true, true, false, false]
    );
    globalThis.__embeddedChatAgentState = "idle";
    await render(ENHANCEMENT, { ...overrides, actionProcessingState: "processing" });
    assert.deepEqual(
      findDockedChat(latest()).props.slashCommands.map((c) => c.disabled),
      [false, false, false, true, true]
    );
    await render(ENHANCEMENT, { ...overrides, isRecording: true });
    assert.equal(findDockedChat(latest()).props.slashCommands, undefined);
  });
}

test("a read-only shared note offers no action picker, chips, slash menu or summary generation", async (t) => {
  globalThis.__noteActions = [FOLLOW_UP];
  t.after(() => delete globalThis.__noteActions);
  const { render, latest, unmount } = await loadNoteEditor(t, "viewer");
  try {
    await render(undefined, {
      note: { ...NOTE, cloud_id: "shared-note", enhanced_content: null },
      onRunNoteAction() {
        throw new Error("must not run");
      },
    });
    const bar = findBottomBar(latest()).props;
    assert.ok(!bar.actionPicker);
    assert.ok(!bar.actionChips);
    assert.equal(bar.slashCommands, undefined);
    assert.ok(!bar.callout);
  } finally {
    await unmount();
  }
});

// The body editor (RichTextEditor, mocked) in the tree the component returned.
function bodyEditor(tree) {
  let editor = null;
  walk(tree, (node) => {
    if (!editor && node.type?.name === "RichTextEditor") editor = node;
  });
  return editor;
}

test("each tab has its own body editor, so undo never carries over between tabs", async (t) => {
  // An undo step from one tab, replayed over the other, would save there.
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  await render(ENHANCEMENT, { note: { ...NOTE, transcript: "Plain transcript" } });
  const keys = [bodyEditor(latest()).key];
  for (const tab of ["raw", "transcript"]) {
    await click(tab);
    assert.equal(bodyEditor(latest()).props.disabled === true, tab === "transcript");
    keys.push(bodyEditor(latest()).key);
  }
  assert.ok(keys.every((key) => key != null));
  assert.equal(new Set(keys).size, 3, `distinct keys, got ${keys}`);
  await unmount();
});

test("the body editor sits under the bottom bar's parent, which the bar publishes its height on", async (t) => {
  // The editor keeps the caret clear of the bar by inheriting --bottom-overlay-height.
  const { render, latest, unmount } = await loadNoteEditor(t);
  await render(ENHANCEMENT);
  let barParent = null;
  walk(latest(), (node) => {
    const children = React.Children.toArray(node.props.children);
    if (!barParent && children.some((child) => child.props?.onAskSubmit)) barParent = node;
  });
  assert.ok(barParent, "the note renders its bottom bar");
  assert.ok(bodyEditor(barParent), "the body editor is inside the bar's parent");
  await unmount();
});

const CONFLICT = {
  id: "cloud-1",
  client_note_id: NOTE.client_note_id,
  title: "Kickoff",
  content: "",
  content_state: "clear",
  enhanced_content: NOTE.enhanced_content,
  updated_at: "2026-09-02T00:00:00.000Z",
  revision: 4,
  updated_by_user_id: null,
};

async function loadWithConflict(t, overrides) {
  const loaded = await loadNoteEditor(t);
  const store = await loaded.vite.ssrLoadModule("/stores/noteStore.ts");
  t.after(() => store.clearNoteConflict(NOTE.client_note_id));
  await loaded.render(ENHANCEMENT, overrides);
  await React.act(async () => store.setNoteConflict(NOTE.client_note_id, CONFLICT));
  const keepButton = () => {
    let button = null;
    walk(loaded.latest(), (node) => {
      if (!button && node.props.children === "notes.spaces.conflictKeep") button = node;
    });
    return button;
  };
  return { ...loaded, keepButton };
}

test("Keep saves the pending edits before it advances the base", async (t) => {
  // A debounced save landing after Keep would write the draft's old notes back
  // over the clear Keep accepted from the other device.
  const calls = [];
  const { keepButton, unmount } = await loadWithConflict(t, {
    onFlushPendingSaves: async (noteId) => calls.push(["flush", noteId]),
  });
  globalThis.window.electronAPI.setNoteCloudBase = async (...args) => {
    calls.push(["base", ...args]);
    return { success: true, note: { ...NOTE, content: "" } };
  };
  await React.act(async () => keepButton().props.onClick());
  assert.deepEqual(calls, [
    ["flush", NOTE.id],
    [
      "base",
      NOTE.id,
      CONFLICT.updated_at,
      CONFLICT.revision,
      { keepLocal: true, cloudNote: CONFLICT },
    ],
  ]);
  assert.equal(keepButton(), null, "the banner is gone");
  await unmount();
});

for (const failing of ["flush", "base"]) {
  test(`Keep leaves the banner up for a retry when the ${failing} step fails`, async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const calls = [];
    const { keepButton, unmount } = await loadWithConflict(t, {
      onFlushPendingSaves: async () => {
        calls.push("flush");
        if (failing === "flush") throw new Error("disk full");
      },
    });
    globalThis.window.electronAPI.setNoteCloudBase = async () => {
      calls.push("base");
      throw new Error("database locked");
    };
    await React.act(async () => keepButton().props.onClick());
    assert.deepEqual(calls, failing === "flush" ? ["flush"] : ["flush", "base"]);
    assert.ok(keepButton(), "the banner stays");
    assert.equal(errors.mock.callCount(), 1);
    await unmount();
  });
}

// The note header's date and attendees dropdown in the tree the component returned.
function findElementOfType(tree, type) {
  let found = null;
  walk(tree, (node) => {
    if (!found && node.type === type) found = node;
  });
  return found;
}

test("the note header hands its event link to the dropdown, changeable only by editors", async (t) => {
  const { render, latest, unmount, vite } = await loadNoteEditor(t, "viewer");
  const { default: NoteParticipants } = await vite.ssrLoadModule(
    "/components/notes/NoteParticipants.tsx"
  );
  try {
    const linkedEvent = { id: "evt-1", summary: "Standup" };
    await render(undefined, {
      note: { ...NOTE, cloud_id: "shared-note", calendar_event_id: "evt-1" },
      linkedEvent,
    });
    const viewer = findElementOfType(latest(), NoteParticipants).props;
    assert.equal(viewer.canEdit, false, "a viewer of a shared note can't change the link");
    assert.equal(viewer.ownedByUser, false, "someone else's note");
    assert.equal(viewer.linkedEventId, "evt-1");
    assert.equal(viewer.linkedEvent, linkedEvent);
    assert.equal(viewer.noteCreatedAt, NOTE.created_at);

    await render(undefined, { note: { ...NOTE, calendar_event_id: "" } });
    const owner = findElementOfType(latest(), NoteParticipants).props;
    assert.equal(owner.canEdit, true, "the user's own note is editable");
    assert.equal(owner.ownedByUser, true);
    assert.equal(owner.linkedEventId, null, "an unlinked note's blank id reaches it as no link");
  } finally {
    await unmount();
  }
});

test("a teammate's This is me correction saves their identity for display and generation", async (t) => {
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "bob", name: "Bob Viewer", email: "bob@example.com" },
  };
  t.after(() => delete globalThis.__noteEditorAuth);
  const { render, click, latest, unmount } = await loadNoteEditor(t, "editor");
  const saved = [];
  const corrections = [];
  const applyCorrection = globalThis.window.electronAPI.applySpeakerCorrection;
  globalThis.window.electronAPI.applySpeakerCorrection = async (request) => {
    corrections.push(request);
    return applyCorrection(request);
  };
  globalThis.window.electronAPI.updateNote = async (_id, patch) => saved.push(patch);
  await render(undefined, {
    note: {
      ...NOTE,
      cloud_id: "shared-note",
      owner_user_id: "alice",
      transcript: JSON.stringify([{ source: "mic", speaker: "speaker_0", text: "I'll send it." }]),
    },
  });
  await click("transcript");
  await React.act(async () => {
    let chat;
    walk(latest(), (node) => {
      if (node.props.onMapSpeaker) chat = node;
    });
    await chat.props.onMapSpeaker("speaker_0", "You");
  });
  assert.equal(corrections[0].name, "Bob Viewer", "the viewer's correction uses their identity");
  const firstTranscript = saved.find((patch) => patch.transcript)?.transcript;
  assert.equal(JSON.parse(firstTranscript)[0].speakerName, "Bob Viewer");
  const { buildLlmTranscript } = await import("../../src/utils/llmTranscript.ts");
  assert.equal(
    buildLlmTranscript(JSON.parse(firstTranscript), {}, "Alice", (key) => key),
    "Bob Viewer: I'll send it."
  );
  await React.act(async () => {
    let chat;
    walk(latest(), (node) => {
      if (node.props.onToggleSelect) chat = node;
    });
    chat.props.onToggleSelect(chat.props.segments[0].id);
  });
  await React.act(async () => {
    let selection;
    walk(latest(), (node) => {
      if (node.props.onAssignName) selection = node;
    });
    await selection.props.onAssignName("You");
  });
  assert.equal(
    JSON.parse(saved.filter((patch) => patch.transcript).at(-1).transcript)[0].speakerName,
    "Bob Viewer"
  );
  await unmount();
});

for (const [session, recorderName, expectedName] of [
  ["original", undefined, "Alice Recorder"],
  ["appended", "Carol Recorder", "Carol Recorder"],
]) {
  test(`confirming an inherited ${session} self suggestion preserves its recorder`, async (t) => {
    globalThis.__noteEditorAuth = {
      isSignedIn: true,
      user: { id: "bob", name: "Bob Viewer", email: "bob@example.com" },
    };
    t.after(() => delete globalThis.__noteEditorAuth);
    const { render, click, latest, unmount } = await loadNoteEditor(t, "editor");
    const saved = [];
    globalThis.window.electronAPI.setSpeakerMapping = async () => {};
    globalThis.window.electronAPI.updateNote = async (_id, patch) => saved.push(patch);
    await render(undefined, {
      note: {
        ...NOTE,
        cloud_id: "shared-note",
        owner_user_id: "alice",
        participants: JSON.stringify([
          { email: "alice@example.com", displayName: "Alice Recorder", self: true },
        ]),
        transcript: JSON.stringify([
          {
            source: "mic",
            speaker: "speaker_0",
            text: "I'll send it.",
            suggestedName: "You",
            suggestedProfileId: 7,
            recorderName,
          },
        ]),
      },
    });
    await click("transcript");
    await React.act(async () => {
      let chat;
      walk(latest(), (node) => {
        if (node.props.onConfirmSuggestion) chat = node;
      });
      await chat.props.onConfirmSuggestion("speaker_0", "You", 7, recorderName);
    });
    assert.equal(JSON.parse(saved.at(-1).transcript)[0].speakerName, expectedName);
    await unmount();
  });
}

test("confirming the current recorder's self suggestion preserves their global self profile", async (t) => {
  const { createDb } = require("../helpers/harness/db");
  const db = createDb(t);
  assert.ok(db);
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "bob", name: "Bob Viewer", email: "bob@example.com" },
  };
  t.after(() => delete globalThis.__noteEditorAuth);
  let cleanup = () => {};
  t.after(() => cleanup());
  const { render, click, latest, unmount } = await loadNoteEditor(t, "editor");
  cleanup = unmount;
  const embedding = Buffer.from(new Float32Array([1, 0]).buffer);
  const selfProfile = db.upsertSpeakerProfile("You", null, embedding);
  const note = db.saveNote("Shared meeting", "", "meeting").note;
  const corrections = [];
  const applyCorrection = globalThis.window.electronAPI.applySpeakerCorrection;
  Object.assign(globalThis.window.electronAPI, {
    getSpeakerProfiles: async () => db.getSpeakerProfiles(),
    applySpeakerCorrection: async (request) => {
      corrections.push(request);
      return applyCorrection(request);
    },
    updateNote: async (...args) => db.updateNote(...args),
  });
  await render(undefined, {
    note: {
      ...NOTE,
      id: note.id,
      cloud_id: "shared-note",
      owner_user_id: "alice",
      created_by_user_id: "alice",
      transcript: JSON.stringify([
        {
          source: "mic",
          speaker: "speaker_0",
          text: "I'll send it.",
          suggestedName: "You",
          suggestedProfileId: selfProfile.id,
          recorderName: "Bob Viewer",
        },
      ]),
    },
  });
  await click("transcript");
  await React.act(async () => {
    let chat;
    walk(latest(), (node) => {
      if (node.props.onConfirmSuggestion) chat = node;
    });
    await chat.props.onConfirmSuggestion("speaker_0", "You", selfProfile.id, "Bob Viewer");
  });
  assert.equal(corrections[0].name, "Bob Viewer");
  assert.equal(corrections[0].profileId, selfProfile.id);
  assert.equal(
    db.getSpeakerProfiles().find((profile) => profile.id === selfProfile.id).display_name,
    "You"
  );
  await unmount();
  cleanup = () => {};
});

test("the owner can correct a teammate's self row without renaming earlier sessions", async (t) => {
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "alice", name: "Alice Owner", email: "alice@example.com" },
  };
  t.after(() => delete globalThis.__noteEditorAuth);
  const { render, click, latest, unmount } = await loadNoteEditor(t, "editor");
  const saved = [];
  globalThis.window.electronAPI.setSpeakerMapping = async () => {
    throw new Error("a cross-session self ID must not create a global mapping");
  };
  globalThis.window.electronAPI.updateNote = async (_id, patch) => saved.push(patch);
  await render(undefined, {
    note: {
      ...NOTE,
      cloud_id: "shared-note",
      owner_user_id: "alice",
      transcript: JSON.stringify([
        {
          source: "mic",
          speaker: "you",
          text: "Old words",
          speakerName: "Original correction",
          speakerLocked: true,
        },
        { source: "mic", speaker: "you", text: "New words", recorderName: "Bob Viewer" },
      ]),
    },
  });
  await click("transcript");
  await React.act(async () => {
    let chat;
    walk(latest(), (node) => {
      if (node.props.onMapSpeaker) chat = node;
    });
    await chat.props.onMapSpeaker("you", "You", null, undefined, "Bob Viewer");
  });
  const segments = JSON.parse(saved.at(-1).transcript);
  assert.equal(segments[0].speakerName, "Original correction");
  assert.equal(segments[1].speakerName, "Alice Owner");
  const { buildLlmTranscript } = await import("../../src/utils/llmTranscript.ts");
  assert.equal(
    buildLlmTranscript(segments, {}, "Alice Owner", (key) => key),
    "Original correction: Old words\nAlice Owner: New words"
  );
  await unmount();
});

test("the editor resolves the creator separately from custodian permissions and self corrections", async (t) => {
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "bob", name: "Bob Viewer", email: "bob@example.com" },
  };
  globalThis.__noteEditorRoster = [
    { user_id: "alice", name: "Alice Recorder", email: "alice@example.com" },
  ];
  t.after(() => {
    delete globalThis.__noteEditorAuth;
    delete globalThis.__noteEditorRoster;
    delete globalThis.__noteEditorRosterId;
    delete globalThis.__embeddedChatOptions;
  });
  const { render, click, latest, unmount, vite } = await loadNoteEditor(t, "editor");
  const { loadSpaces } = await vite.ssrLoadModule("/stores/noteStore.ts");
  globalThis.window.electronAPI.getSpaces = async () => [
    { id: 1, kind: "team", cloud_space_id: "team" },
  ];
  await loadSpaces();
  const saved = [];
  globalThis.window.electronAPI.setSpeakerMapping = async () => {};
  globalThis.window.electronAPI.updateNote = async (_id, patch) => saved.push(patch);
  const note = {
    ...NOTE,
    cloud_id: "shared-note",
    owner_user_id: "bob",
    created_by_user_id: "alice",
    space_id: 1,
    transcript: JSON.stringify([{ source: "mic", speaker: "you", text: "Original words" }]),
  };
  await render(undefined, { note });
  await click("transcript");
  let chat;
  let dropdown;
  walk(latest(), (node) => {
    if (node.props.onMapSpeaker) chat = node;
    if ("ownedByUser" in node.props) dropdown = node;
  });
  assert.equal(chat.props.recorderLabel, "Alice Recorder");
  assert.equal(
    globalThis.__noteEditorRosterId,
    "team",
    "custodians still load the recorder's roster"
  );
  assert.equal(dropdown.props.ownedByUser, true, "permission ownership remains the custodian's");
  assert.equal(globalThis.__embeddedChatOptions.noteOwnedByUser, false);
  assert.match(
    globalThis.__embeddedChatOptions.noteTranscript,
    /Someone other than the user took these notes/
  );
  await React.act(async () => chat.props.onMapSpeaker("you", "You"));
  assert.equal(JSON.parse(saved.at(-1).transcript)[0].speakerName, "Bob Viewer");

  await render(undefined, { note: { ...note, created_by_user_id: null, participants: null } });
  walk(latest(), (node) => {
    if (node.props.onMapSpeaker) chat = node;
  });
  assert.equal(chat.props.recorderLabel, "notes.speaker.noteTaker");
  assert.equal(
    globalThis.__noteEditorRosterId,
    null,
    "a cleared creator never uses the owner's roster"
  );
  assert.equal(globalThis.__embeddedChatOptions.noteOwnedByUser, false);
  await unmount();
});

test("diarization keeps stored recorder labels separate from viewer-local self mappings", async (t) => {
  globalThis.__noteEditorAuth = {
    isSignedIn: true,
    user: { id: "bob", name: "Bob Viewer", email: "bob@example.com" },
  };
  t.after(() => {
    delete globalThis.__noteEditorAuth;
    delete globalThis.__embeddedChatOptions;
  });
  const { render, unmount, vite } = await loadNoteEditor(t, "editor");
  globalThis.window.electronAPI.getSpeakerMappings = async () => [
    { speaker_id: "speaker_2", display_name: "You" },
  ];
  const segments = [
    { id: "original", source: "mic", speaker: "speaker_0", speakerName: "You", speakerLockSource: "user", text: "Original" },
    {
      id: "appended",
      source: "mic",
      speaker: "speaker_1",
      speakerName: "You",
      recorderName: "Carol Recorder",
      speakerLockSource: "user",
      text: "Appended",
    },
    { id: "viewer", source: "mic", speaker: "speaker_2", speakerAssignment: { origin: "human" }, text: "Viewer" },
  ];
  await render(undefined, {
    note: {
      ...NOTE,
      cloud_id: "shared-note",
      owner_user_id: "alice",
      transcript: JSON.stringify(segments),
    },
  });
  const before = globalThis.__embeddedChatOptions.noteTranscript;
  assert.match(before, /Note taker: Original\nCarol Recorder: Appended\nYou: Viewer$/);
  const { useMeetingRecordingStore } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  await React.act(async () =>
    useMeetingRecordingStore.setState({ completedDiarization: { noteId: NOTE.id, segments } })
  );
  assert.equal(globalThis.__embeddedChatOptions.noteTranscript, before);
  await unmount();
});

test("only the org's meeting switch shows a banner; other restrictions explain themselves on the record button", async (t) => {
  const { render, latest, unmount, vite } = await loadNoteEditor(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const messages = () => {
    const out = [];
    walk(latest(), (node) => {
      if (node.props.role === "status") out.push(node.props.children);
    });
    return out;
  };
  for (const audioUploadEnabled of [true, false]) {
    await React.act(async () => {
      usePolicyStore.setState({
        status: "managed",
        policy: { features: { meetingRecordingEnabled: false, audioUploadEnabled } },
      });
    });
    await render(undefined, { recordingAllowed: false });
    assert.ok(messages().includes("notes.meeting.recordingDisabledByOrg"));
    assert.ok(collectEditorValues(latest()).includes(NOTE.content), "saved notes remain readable");
    await React.act(async () => {
      usePolicyStore.setState({
        policy: { features: { meetingRecordingEnabled: true, audioUploadEnabled } },
      });
    });
    await render(undefined, { recordingAllowed: true });
    assert.ok(!messages().includes("notes.meeting.recordingDisabledByOrg"));
  }
  const recordReason = () => {
    let reason;
    walk(latest(), (node) => {
      if ("disabledReason" in node.props) reason = node.props.disabledReason;
    });
    return reason;
  };
  for (const [policy, expected] of [
    [{ status: "loading", policy: null }, "common.policyUnresolved"],
    [
      { status: "managed", policy: { features: { meetingRecordingEnabled: true } } },
      "notes.meeting.restrictedByOrg",
    ],
  ]) {
    await React.act(async () => usePolicyStore.setState(policy));
    await render(undefined, { recordingAllowed: false });
    assert.deepEqual(messages(), [], `${policy.status}: no banner`);
    assert.equal(recordReason(), expected);
  }
  await unmount();
});

for (const response of ["committed Unknown", "stale accepted A"]) {
  test(`NoteEditor undo after roster change installs ${response} safely within its affected rows`, async (t) => {
    let store;
    t.after(() => store?.stopRecording());
    installMicCaptureGlobals(t);
    navigator.userAgent = "test";
    const { render, click, latest, unmount, vite } = await loadNoteEditor(t);
    const callbacks = {};
    Object.assign(window.electronAPI, {
      checkSystemAudioAccess: async () => ({
        granted: true,
        status: "granted",
        mode: "native",
        strategy: "native",
      }),
      meetingTranscriptionStart: async () => ({
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
      }),
      meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
      meetingTranscriptionStop: async () => ({ success: true }),
      meetingTranscriptionSend() {},
      getNote: async () => null,
      updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: (cb) => {
        callbacks.segment = cb;
        return () => {};
      },
      onMeetingSpeakerIdentified: (cb) => {
        callbacks.identify = cb;
        return () => {};
      },
      onNoteUpdated: (cb) => {
        callbacks.updated = cb;
        return () => {};
      },
    });
    store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
    await store.startRecording({ noteId: NOTE.id, noteTitle: NOTE.title, folderId: null });
    const accepted = {
      origin: "machine",
      decisionId: "old-A",
      noteId: NOTE.id,
      source: "note",
      revision: "A",
      rawRoster: JSON.stringify([{ email: "a@example.com" }]),
      rosterRevision: 0,
      eligibleProfileIds: [1],
      acceptedProfileId: 1,
      rejectionReason: null,
    };
    const now = Date.now();
    callbacks.segment({ type: "final", source: "system", text: "affected", timestamp: now });
    callbacks.segment({
      type: "final",
      source: "system",
      text: "unaffected",
      timestamp: now + 1000,
    });
    callbacks.identify({
      speakerId: "speaker_0",
      displayName: "A",
      speakerDecision: accepted,
      startTime: now - 100,
      endTime: now + 1500,
    });
    const before = store.useMeetingRecordingStore.getState().segments;
    const veto = {
      ...accepted,
      decisionId: "roster-veto",
      revision: "B",
      rawRoster: JSON.stringify([{ email: "b@example.com" }]),
      rosterRevision: 1,
      eligibleProfileIds: [2],
      acceptedProfileId: null,
      rejectionReason: "roster_changed",
    };
    const unknown = before.map((row) => ({
      ...row,
      speakerName: undefined,
      speakerIsPlaceholder: true,
      speakerDecision: veto,
    }));
    callbacks.updated({
      id: NOTE.id,
      participants: veto.rawRoster,
      speaker_roster_revision: 1,
      transcript: JSON.stringify(unknown),
    });
    window.electronAPI.applySpeakerCorrection = async () => ({
      success: true,
      affectedRowIds: [before[0].id],
      rows: unknown.map((row, i) =>
        i === 1 || response === "stale accepted A"
          ? { ...row, speakerName: "A", speakerIsPlaceholder: false, speakerDecision: accepted }
          : row
      ),
    });
    await render(undefined, { isRecording: true });
    await click("transcript");
    await React.act(async () => {
      let chat;
      walk(latest(), (node) => {
        if (node.props.onUndoCorrection) chat = node;
      });
      assert.ok(chat);
      await chat.props.onUndoCorrection("undo-A");
    });
    for (const row of store.useMeetingRecordingStore.getState().segments) {
      assert.equal(row.speakerName, undefined);
      assert.equal(row.speakerDecision.rejectionReason, "roster_changed");
    }
    await unmount();
  });
}

test("NoteEditor stopped undo revalidates restored automatic decisions against current participants", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  const accepted = {
    origin: "machine",
    decisionId: "old-A",
    noteId: NOTE.id,
    source: "note",
    revision: "A",
    rawRoster: JSON.stringify([{ email: "a@example.com" }]),
    rosterRevision: 0,
    eligibleProfileIds: [1],
    acceptedProfileId: 1,
    rejectionReason: null,
  };
  const note = {
    ...NOTE,
    participants: JSON.stringify([{ email: "b@example.com" }]),
    speaker_roster_revision: 1,
    transcript: JSON.stringify([
      {
        id: "vetoed",
        text: "hello",
        source: "system",
        speaker: "speaker_0",
        speakerIsPlaceholder: true,
        speakerDecision: {
          ...accepted,
          acceptedProfileId: null,
          rejectionReason: "roster_changed",
        },
      },
    ]),
  };
  window.electronAPI.applySpeakerCorrection = async (request) => ({
    success: true,
    affectedRowIds: request.rows.map((row) => row.id),
    rows: request.rows.map((row) => ({
      ...row,
      speakerName: "A",
      speakerIsPlaceholder: false,
      speakerDecision: accepted,
    })),
  });
  await render(undefined, { note });
  await click("transcript");
  const chat = () => {
    let result;
    walk(latest(), (node) => {
      if (node.props.onUndoCorrection) result = node;
    });
    return result;
  };
  await React.act(async () => {
    await chat().props.onUndoCorrection("undo-A");
  });
  assert.equal(chat().props.segments[0].speakerName, undefined);
  assert.equal(chat().props.segments[0].speakerDecision.rejectionReason, "roster_changed");
  await unmount();
});

test('NoteEditor undo uses the current scope when participants change during its IPC wait', async t => {
  const {render,click,latest,unmount} = await loadNoteEditor(t);
  const rawRoster = JSON.stringify([{email:'a@example.com'}]);
  const evidence = {origin:'machine',decisionId:'A',noteId:NOTE.id,source:'note',revision:'A',rawRoster,rosterRevision:0,eligibleProfileIds:[1],acceptedProfileId:1,rejectionReason:null};
  const row = {id:'locked-row',text:'hello',source:'system',speaker:'speaker_0',speakerName:'Manual outsider',speakerLocked:true,speakerStatus:'locked',speakerLockSource:'user',speakerDecision:evidence};
  const noteA = {...NOTE,participants:rawRoster,speaker_roster_revision:0,transcript:JSON.stringify([row])};
  let reply;
  window.electronAPI.applySpeakerCorrection = request => new Promise(resolve => {
    reply = () => resolve({success:true,affectedRowIds:request.rows.map(row=>row.id),rows:request.rows.map(row=>({...row,
      speakerName:'A',speakerLocked:false,speakerLockSource:undefined,speakerStatus:'confirmed',speakerDecision:evidence}))});
  });
  await render(undefined,{note:noteA});
  await click('transcript');
  const chat = () => {let result;walk(latest(),node=>{if(node.props.onUndoCorrection)result=node;});return result;};
  let pending;
  await React.act(async()=>{pending = chat().props.onUndoCorrection('undo-A'); await Promise.resolve();});
  assert.ok(reply);
  await render(undefined,{note:{...noteA,participants:JSON.stringify([{email:'b@example.com'}]),speaker_roster_revision:1}});
  await React.act(async()=>{reply();await pending;});
  assert.equal(chat().props.segments[0].speakerName,undefined);
  assert.equal(chat().props.segments[0].speakerDecision.rejectionReason,'roster_changed');
  await unmount();
});

test('run6: NoteEditor completion overlay is invalidated by an ordinary roster change', async t=>{
  const { render, click, latest, unmount, vite }=await loadNoteEditor(t);
  const store=await vite.ssrLoadModule('/stores/meetingRecordingStore.ts');
  const note={...NOTE,participants:'[]',speaker_roster_revision:0,transcript:JSON.stringify([{id:'overlay',text:'hello',source:'system'}])};
  const decision={candidateSetStatus:'recorded',decisionId:'accepted',noteId:note.id,source:'note',rawRoster:'[]',rosterRevision:0,eligibleProfileIds:[1],acceptedProfileId:1,rejectionReason:null};
  const segments=[{id:'overlay',text:'hello',source:'system',speakerName:'A',speakerDecision:decision}];
  const chat=()=>{let found;walk(latest(),node=>{if(node.props.onMapSpeaker)found=node;});return found.props;};
  try {
    await render(undefined,{note});await click('transcript');
    await React.act(async()=>store.useMeetingRecordingStore.setState({completedDiarization:{noteId:note.id,segments}}));
    assert.equal(chat().segments[0].speakerName,'A');
    const current={...segments[0],speakerName:'Re-evaluated member',speakerDecision:{...decision,decisionId:'new-evaluation'}};
    await render(undefined,{note:{...note,transcript:JSON.stringify({version:2,rows:[current]})}});
    assert.equal(chat().segments[0].speakerName,'Re-evaluated member','same-roster enrollment recovery must invalidate an old overlay');

    await render(undefined,{note:{...note,participants:'[{"email":"other@example.com"}]',speaker_roster_revision:1}});
    assert.equal(chat().segments[0].speakerName,undefined);
    assert.equal(chat().segments[0].speakerDecision?.acceptedProfileId ?? null,null);
    const participants='[{"email":"other@example.com"}]';
    const recovered={...segments[0],speakerName:'Current member',speakerDecision:{...decision,decisionId:'recovered',rawRoster:participants,rosterRevision:1,acceptedProfileId:2,eligibleProfileIds:[2]}};
    await render(undefined,{note:{...note,participants,speaker_roster_revision:1,transcript:JSON.stringify({version:2,rows:[recovered]})}});
    assert.equal(chat().segments[0].speakerName,'Current member','an old overlay must not hide a legitimate current recovery');
  } finally {await unmount();}
});

test("run7: main and NoteEditor agree on every legacy roster form", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  const { enforceRows } = require("../../src/helpers/noteSpeakerScope");
  const forms = [
    null,
    "[]",
    "[ ]",
    [],
    "   ",
    "{broken",
    "{}",
    '[{"email":"a@example.com"}]',
    [{ email: "a@example.com" }],
  ];
  try {
    for (const participants of forms) {
      const row = {
        id: "legacy-roster",
        text: "hello",
        source: "system",
        speakerName: "Alice",
      };
      const note = { ...NOTE, participants, transcript: JSON.stringify([row]) };
      const db = { getNote: () => note, getSpeakerProfiles: () => [] };
      const main = enforceRows(db, note.id, [{ ...row }])[0];
      await render(undefined, { note });
      await click("transcript");
      let editor;
      walk(latest(), (node) => {
        if (node.props.onMapSpeaker) editor = node.props.segments[0];
      });
      const attribution = (r) => [
        r.speakerName,
        r.speakerReviewRequired,
        r.speakerDecision?.rejectionReason,
      ];
      assert.deepEqual(attribution(editor), attribution(main), JSON.stringify(participants));
      const unrestricted =
        participants === null ||
        (Array.isArray(participants) && participants.length === 0) ||
        ["[]", "[ ]"].includes(participants);
      assert.equal(
        editor.speakerName,
        unrestricted ? "Alice" : undefined,
        JSON.stringify(participants)
      );
    }
  } finally {
    await unmount();
  }
});

test("run7: NoteEditor suppresses legacy review count for human resolution and restores it on undo", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  const legacy = {
    id: "resolved-review",
    text: "hello",
    source: "system",
    speakerReviewRequired: true,
  };
  const count = () => {
    let found = false;
    walk(latest(), (node) => {
      if (node.props.children === "notes.speaker.reviewStretches") found = true;
    });
    return found;
  };
  try {
    await render(undefined, {
      note: { ...NOTE, transcript: JSON.stringify([legacy]) },
    });
    await click("transcript");
    assert.equal(count(), true);
    const resolved = {
      ...legacy,
      speakerName: "My choice",
      speakerLocked: true,
      speakerLockSource: "user",
    };
    await render(undefined, {
      note: { ...NOTE, transcript: JSON.stringify([resolved]) },
    });
    assert.equal(count(), false);
    await render(undefined, {
      note: { ...NOTE, transcript: JSON.stringify([legacy]) },
    });
    assert.equal(count(), true);
  } finally {
    await unmount();
  }
});

test("run8: NoteEditor opens uncertain legacy names under the real note scope", async (t) => {
  const { render, click, latest, unmount } = await loadNoteEditor(t);
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.cancelAnimationFrame = clearTimeout;
  const forms = [null, "[]", "[ ]", "   ", "{broken", "null", "{}", '[{"email":"a@example.com"}]'];
  try {
    for (const [index, participants] of forms.entries()) {
      const row = {
        id: "r",
        text: "Hello",
        speakerName: "Alice",
        uncertainty: { reason: "close_match" },
      };
      await render(undefined, {
        note: { ...NOTE, id: index + 1, participants, transcript: JSON.stringify([row]) },
      });
      await click("transcript");
      let actual;
      walk(latest(), (node) => {
        if (node.props.onMapSpeaker) actual = node.props.segments[0];
      });
      const unrestricted = index < 3;
      assert.equal(
        actual.speakerName,
        unrestricted ? "Alice" : undefined,
        JSON.stringify(participants)
      );
      if (!unrestricted) {
        assert.equal(actual.speakerReviewRequired, true);
        assert.equal(actual.speakerDecision.rejectionReason, "legacy_not_evaluated");
      }
    }
  } finally {
    await unmount();
  }
});
