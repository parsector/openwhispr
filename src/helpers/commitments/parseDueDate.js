const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validDate(year, month, day) {
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

function parseDueDate(raw, now = new Date()) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const phrase = raw.trim().toLowerCase().replace(/[,\.]/g, "").replace(/\s+/g, " ");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date = null;
  let confidence = 1;
  if (phrase === "tonight" || phrase === "today") date = today;
  else if (phrase === "tomorrow") date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  else if (phrase === "end of month" || phrase === "by the end of the month")
    date = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  else {
    const weekday = /^(?:(?:this|next|on|by) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(phrase);
    if (weekday) {
      const delta = (DAYS.indexOf(weekday[1]) - today.getDay() + 7) % 7 || 7;
      date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
      confidence = 0.9;
    } else {
      const numeric = /^(?:(?:by|on) )?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(phrase);
      const named = /^(?:(?:by|on) )?(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(phrase);
      const dayFirst = /^(?:(?:by|on) )?(\d{1,2})(?:st|nd|rd|th)? (january|february|march|april|may|june|july|august|september|october|november|december)(?: (\d{4}))?$/.exec(phrase);
      if (numeric || named || dayFirst) {
        const day = Number(numeric?.[1] || named?.[2] || dayFirst?.[1]);
        const month = numeric ? Number(numeric[2]) - 1 : MONTHS.indexOf(named?.[1] || dayFirst?.[2]);
        const explicitYear = numeric?.[3] || named?.[3] || dayFirst?.[3];
        const year = explicitYear ? Number(explicitYear) : today.getFullYear();
        date = validDate(year, month, day);
        if (date && !explicitYear && date < today) date = validDate(year + 1, month, day);
      }
    }
  }
  return date ? { due_date: localIso(date), due_raw: raw, due_confidence: confidence } : null;
}

module.exports = { parseDueDate };
