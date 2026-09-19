// Pure display helpers for Beam UI (dialog + offers indicator). Size
// *limits* live in the backend (crates/skypie-remote/src/beam.rs) — the
// receive dialog gets a pre-computed `warn` flag instead of mirroring the
// threshold here.

/** Unix seconds — the unit every expiry and `created_at` on the wire uses.
 * Shared so the dialog and the remote provider cannot drift on it. */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** "482 KB", "1.2 MB" — coarse on purpose, one decimal only when it matters. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${Math.round(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 10) return `${mib.toFixed(1)} MB`;
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

/** Time until an offer's expiry, coarse on purpose: "23 h", "45 min",
 * "<1 min", "expired". Both arguments are unix seconds. */
export function expiresIn(expiresAt: number, nowSecs: number): string {
  const left = expiresAt - nowSecs;
  if (left <= 0) return "expired";
  if (left < 60) return "<1 min";
  if (left < 3600) return `${Math.round(left / 60)} min`;
  return `${Math.round(left / 3600)} h`;
}

/** When two machines last spoke, for a device row: "Never connected",
 * "just now", "5 min ago", "3 h ago", "2 d ago". `lastSeen` is unix seconds;
 * 0 means the pairing never completed a handshake. */
export function formatLastSeen(lastSeen: number, now: number): string {
  if (!lastSeen) return "Never connected";
  const ago = formatAgo(lastSeen, now);
  // One ladder, two presentations: this line used to repeat formatAgo's
  // 60/3600/86400 cutoffs, so a future change to one would have drifted.
  return ago === "just now" ? "Last seen just now" : `Last seen ${ago} ago`;
}

/** Compact age for a shared-file row: "just now", "5 min", "3 h", "2 d".
 *
 * Deliberately shorter than `formatLastSeen`, which prefixes "Last seen" and
 * belongs on a device row where there is a whole line to spend. Here it sits
 * beside a filename that must win the space, so it carries no prefix. */
export function formatAgo(then: number, now: number): string {
  const ago = Math.max(0, now - then);
  if (ago < 60) return "just now";
  if (ago < 3600) return `${Math.round(ago / 60)} min`;
  if (ago < 86400) return `${Math.round(ago / 3600)} h`;
  return `${Math.round(ago / 86400)} d`;
}

/** A file row's age, e.g. "just now", "5 min ago", "3 h ago" — the one copy
 *  shared by the desktop plate (`PiePlate.tsx`) and the phone sheet
 *  (`PhonePieSheet.tsx`), which each carried their own identical version
 *  before.
 *
 *  It lives HERE, beside `formatAgo`, because the whole reason it exists is
 *  `formatAgo`'s own contract: that function already returns the complete
 *  phrase "just now" for anything under 60s, so appending " ago"
 *  unconditionally reads "just now ago". Keeping the two apart is what let
 *  the rule be rediscovered — and re-implemented — twice.
 *
 *  BOTH arguments are MILLISECONDS — the unit `DerivedPieFile.mtime`
 *  already carries — and the division to `formatAgo`'s seconds happens
 *  inside. The signature used to take ms for the file and SECONDS for the
 *  clock, so a caller that passed `Date.now()` (the obvious clock) read
 *  "just now" for every row, silently. One unit per function is what makes
 *  that unrepresentable.
 *
 *  `nowMs` defaults to the real clock so a render site needs no second
 *  argument; a test passes a fixed "now" to reach the under-60s branch
 *  deterministically. */
export function mtimeAgo(mtimeMs: number, nowMs: number = Date.now()): string {
  const ago = formatAgo(Math.floor(mtimeMs / 1000), Math.floor(nowMs / 1000));
  return ago === "just now" ? ago : `${ago} ago`;
}
