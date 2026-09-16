// Address contract for remote tabs: opening a paired device's artifact
// creates a tab whose address is `skypie-remote://<peer-id>/abs/path`.
// The whole render pipeline (loader, scroll memory, isolation) keys off this
// string exactly like a local path. Nothing outside this module builds or
// splits the address by hand — use `formatRemoteAddress` / `parseRemoteAddress`.
export const REMOTE_SCHEME = "skypie-remote://";

export interface RemoteAddress {
  peer: string;
  /** The path AS SEEN ON THE HOST — always absolute. */
  path: string;
}

/** `skypie-remote://<peer-id>/abs/path` — the peer id is the authority, the
 * remote path (already absolute) is used as-is. */
export function formatRemoteAddress(peer: string, path: string): string {
  return `${REMOTE_SCHEME}${peer}${path}`;
}

export function isRemoteAddress(address: string): boolean {
  return address.startsWith(REMOTE_SCHEME);
}

/** Parses a `skypie-remote://` address; `null` for anything else, including a
 * malformed one (empty peer id or a path that lost its leading slash). The
 * single `slash <= 0` test rules out both: a slash at index 0 means an empty
 * peer id, and no slash at all means there is no absolute path to take. */
export function parseRemoteAddress(address: string): RemoteAddress | null {
  if (!isRemoteAddress(address)) return null;
  const rest = address.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { peer: rest.slice(0, slash), path: rest.slice(slash) };
}
