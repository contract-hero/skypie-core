// The first 10 hex characters of a node id — the width iroh's own
// `fmt_short` prints and the backend's `short_id` returns, so an id shown
// here and one in a tool reply are the same string.
export const SHORT_ID_CHARS = 10;

export function shortId(nodeId: string): string {
  return nodeId.slice(0, SHORT_ID_CHARS);
}
