const PRESETS = [
  {
    id: "morning-brief",
    nameKey: "routines.presets.morningBrief.name",
    descriptionKey: "routines.presets.morningBrief.description",
    prompt:
      "Give me a concise morning brief. List today's meetings with relevant links to past notes. Summarize open action items from the last seven days, omitting completed items. Cite the supplied note and calendar links. If there is nothing useful to report, answer NOTHING_TO_REPORT.",
    trigger_config: { schema_version: 1, slots: [{ days: [1, 2, 3, 4, 5], time: "09:00" }] },
    suggested_tools: ["search_notes", "get_note", "get_calendar_events"],
    needs: ["routines.presets.morningBrief.pickTime"],
  },
];

module.exports = { PRESETS };
