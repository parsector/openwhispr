const PRESETS = [
  {
    id: "morning-brief",
    nameKey: "routines.presets.morningBrief.name",
    descriptionKey: "routines.presets.morningBrief.description",
    prompt:
      "Give me a concise morning brief. List today's meetings with relevant links to past notes. Summarize open action items from the last seven days, omitting completed items. Cite the supplied note and calendar links. If there is nothing useful to report, answer NOTHING_TO_REPORT.",
    trigger_config: { schema_version: 1, slots: [{ days: [1, 2, 3, 4, 5], time: "09:00" }] },
    suggested_tools: ["search_notes", "get_note", "get_calendar_events", "list_todos"],
    needs: ["routines.presets.morningBrief.pickTime"],
  },
  {
    id: "meeting-prep",
    nameKey: "routines.presets.meetingPrep.name",
    descriptionKey: "routines.presets.meetingPrep.description",
    prompt: "Prepare me for this meeting. Give a concise agenda, relevant history with these attendees, and open items between us. Cite related notes. If there is nothing useful to report, answer NOTHING_TO_REPORT.",
    trigger_type: "before_event",
    trigger_config: { schema_version: 1, minutes_before: 10, title_pattern: "", title_template: "Prep - {event} - {date}", has_attendees: true, has_meeting_link: false, skip_declined: true },
    suggested_tools: ["search_notes", "get_note", "get_calendar_events", "list_todos"],
    needs: ["routines.presets.meetingPrep.reviewSources"],
  },
  {
    id: "friday-digest",
    nameKey: "routines.presets.fridayDigest.name",
    descriptionKey: "routines.presets.fridayDigest.description",
    prompt: "Using only the selected notes from the past seven days, summarize decisions, risks, and blockers. Then draft a concise status update. Cite the supplied note links. If there is nothing useful to report, answer NOTHING_TO_REPORT.",
    trigger_config: { schema_version: 1, slots: [{ days: [5], time: "16:00" }] },
    source_config: { folder_ids: [], people: [], lookback_days: 7 },
    required_selection: ["folders", "people"],
    suggested_tools: ["search_notes", "get_note"],
    needs: ["routines.presets.fridayDigest.pickFolders", "routines.presets.fridayDigest.pickPeople"],
  },
];

module.exports = { PRESETS };
