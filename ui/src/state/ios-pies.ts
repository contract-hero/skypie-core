// ios-pies.ts — M6: the phone Sky band's own two derived pies, Received
// (over `useBeamState().received`) and one Shared-from-<Mac> pie per ONLINE
// peer (over `remote_list_shared`). Pure, no React — ios-pies-context.tsx
// wraps these calls in useMemo, the same split derived-pies.ts (M1's
// Pinned/Recent) already uses.
//
// PITFALL: never route iOS data through derived-pies.ts's own
// `pinnedPie`/`recentPie` — both deliberately DROP a member whose path is
// not an absolute local `/` path (see `recentPie`'s own comment), but a
// Shared pie's members ARE `skypie-remote://peer/path` addresses by
// design, so that guard would empty the pie instead of building it. This
// file reuses derived-pies.ts's TYPES (`DerivedPie`/`DerivedPieFile`) and
// its pure wedge helpers (`wedgesOf`/`groupByWedge`/`shareLabel`, consumed
// by `Pie.tsx`/`PhonePieSheet.tsx` unchanged) — never its two pie BUILDERS.
import type { BeamReceivedEntry, SharedEntry } from "../ipc";
import { kindOf } from "../render/kind";
import { formatAgo } from "../utils/beam-format";
import { formatRemoteAddress } from "../utils/remote-address";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";

/** Both `beam_list_received` and `remote_list_shared` report their
 *  timestamps in UNIX SECONDS (`beam.rs`'s `ReceivedEntry`/`SharedEntry`,
 *  the same convention `bookmarks.rs`/`recents.rs` use) — every other
 *  timestamp downstream (mtime, `Date.now()`) is milliseconds. Converted
 *  once, here — the same trap derived-pies.ts's own `secsToMs` documents. */
function secsToMs(secs: number): number {
  return secs * 1000;
}

/** The band's Received pie — every past beam under the phone's own
 *  `received/` tree. `fresh`/`census` are left
 *  `undefined` forever (never set below): a derived pie has no `seen_at`,
 *  so `Pie.tsx` never draws a `+N` pill on it — the M6 brief's own "no
 *  pill" decision, enforced by construction rather than a runtime check. */
export function receivedPie(entries: BeamReceivedEntry[]): DerivedPie {
  return {
    id: "builtin:received",
    name: "Received",
    files: entries.map((e) => ({
      path: e.path,
      // The KIND comes from the SENDER-SUPPLIED basename (`e.name`), not
      // the on-disk `e.path` — a beam's landed path can carry a
      // disambiguating `-2`/`-3` suffix (beam.rs's own `unique_name`) that
      // never touches the extension, so the two agree in practice, but
      // `e.name` is the one field defined to be the original filename a
      // remote address is not.
      kind: kindOf(e.name),
      mtime: secsToMs(e.received_at),
      // Carried through so a row can show the same name the "Received"
      // list directly below it on the start page already shows, rather
      // than the on-disk (possibly `-2`/`-3`-suffixed) basename of `path`
      // (review: PhonePieSheet.tsx:70, minor).
      name: e.name,
    })),
  };
}

/** One "Shared from &lt;device&gt;" pie for a single online peer's offers.
 *  `peer` is the node id (the address authority — `formatRemoteAddress`);
 *  `device` is its display label (`useRemoteActions().deviceLabel`).
 *  Member paths are `skypie-remote://<peer><host-path>` — a REMOTE
 *  address, never a local filesystem path, so a pie built here must never
 *  reach `derived-pies.ts`'s builders or any code that calls
 *  `fs`/`ipc.canonicalizePath` on a pie's own files (this file's header
 *  comment). */
export function sharedPie(peer: string, device: string, entries: SharedEntry[]): DerivedPie {
  return {
    id: `builtin:shared:${peer}`,
    name: `Shared from ${device}`,
    files: entries.map((e) => ({
      path: formatRemoteAddress(peer, e.path),
      // Same reasoning as receivedPie above: `e.name` is the sender's own
      // filename, sent so this side never parses a foreign path (SharedEntry's
      // own doc comment) — the host path in `e.path` is not a hint to trust.
      kind: kindOf(e.name),
      mtime: secsToMs(e.shared_at),
      name: e.name,
    })),
  };
}

/** `PhonePieSheet.tsx`'s row order — newest first, the same order
 *  `PiePlate.tsx`'s own layer list uses, so the row a beam or a share just
 *  added is always on top. Pulled out of that component (review:
 *  PhonePieSheet.tsx:43, minor): there is no jsdom in `ui/`, so a pure
 *  sort with an equal-mtime tie-break is only reachable from e2e while it
 *  lives inside a component; here it is a plain export `ios-pies.test.ts`
 *  can call directly. */
export function pieRows(pie: DerivedPie): DerivedPieFile[] {
  return [...pie.files].sort((a, b) => b.mtime - a.mtime);
}

/** `PhonePieSheet.tsx`'s row age string, e.g. "5 min ago", "just now" —
 *  pulled out for the same testability reason as `pieRows` above (review:
 *  PhonePieSheet.tsx:27, minor). `formatAgo` already returns the whole
 *  phrase "just now" for anything under 60s, so appending " ago"
 *  unconditionally would read "just now ago"; `nowSecsValue` is threaded
 *  in rather than read from `Date.now()` here so a test can pick a fixed
 *  "now" and exercise the under-60s branch deterministically. */
export function mtimeAgo(mtimeMs: number, nowSecsValue: number): string {
  const ago = formatAgo(Math.floor(mtimeMs / 1000), nowSecsValue);
  return ago === "just now" ? ago : `${ago} ago`;
}

/** One peer's shared-list fetch, already resolved to a display label —
 *  `ios-pies-context.tsx` collects these from its own `remoteListShared`
 *  fan-out, so this module never has to look a peer up itself. */
export interface IosSharedSource {
  peer: string;
  device: string;
  entries: SharedEntry[];
}

/**
 * The whole M6 band, in order: Received first, then one Shared-from-<Mac>
 * pie per entry in `shared`, sorted by device label (the M6 brief's own
 * band-order decision) — a pie with zero files is dropped entirely, not
 * just emptied: iOS has no tin and no way to feed an empty pie, so an empty
 * one has nothing to open and no reason to hold a band slot.
 */
export function iosPies(received: BeamReceivedEntry[], shared: IosSharedSource[]): DerivedPie[] {
  const pies: DerivedPie[] = [];

  const receivedP = receivedPie(received);
  if (receivedP.files.length > 0) pies.push(receivedP);

  const bySource = [...shared].sort((a, b) => a.device.localeCompare(b.device));
  for (const { peer, device, entries } of bySource) {
    const pie = sharedPie(peer, device, entries);
    if (pie.files.length > 0) pies.push(pie);
  }

  return pies;
}
