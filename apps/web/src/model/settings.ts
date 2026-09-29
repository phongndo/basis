/** A searchable entry in the settings view: `text` is everything a search can match. */
export interface Searchable {
  readonly text: string;
}

export interface EntryGroup<E extends Searchable> {
  readonly title?: string;
  readonly entries: readonly E[];
}

/** True when every word of `query` appears in `text`, ignoring case; an empty query matches everything. */
export const matchesQuery = (query: string, text: string): boolean => {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

/** The groups' matching entries, dropping groups left empty. */
export const filterGroups = <E extends Searchable>(groups: readonly EntryGroup<E>[], query: string): EntryGroup<E>[] =>
  groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => matchesQuery(query, entry.text)) })).filter((group) => group.entries.length > 0);
