/**
 * Query strings as flat records of strings: what a route's search Schema
 * decodes from and encodes to. A key given more than once keeps its last value.
 */
export type RawSearch = Readonly<Record<string, string>>;

export const parseSearch = (search: string): RawSearch => Object.fromEntries(new URLSearchParams(search));

/** `?a=1&b=2`, keys in the record's order; "" when empty. */
export const stringifySearch = (search: RawSearch): string => {
  const text = new URLSearchParams(Object.entries(search)).toString();
  return text === "" ? "" : `?${text}`;
};
