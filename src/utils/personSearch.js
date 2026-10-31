// The attendee picker and People filter the same visible name and email fields.
const fold = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
export function matchesPerson(person, query) {
  const term = fold(query.trim());
  return [
    person.displayName || person.display_name,
    person.email,
    ...(person.searchAliases || []),
  ].some((value) => fold(value).includes(term));
}
