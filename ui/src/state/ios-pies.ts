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
// its pure wedge helpers (`wedgesOf`/`groupByWedge`/`labelOfWedges`, consumed
// by `Pie.tsx`/`PhonePieSheet.tsx` unchanged) — never its two pie BUILDERS.
import type { BeamReceivedEntry, RemotePeer, SharedEntry } from "../ipc";
import { kindOf } from "../render/kind";
import { formatRemoteAddress } from "../utils/remote-address";
import { BUILTIN_RECEIVED_ID, secsToMs, sharedPieId } from "./derived-pies";
import type { DerivedPie, DerivedPieFile } from "./derived-pies";
import { byRow } from "./pie-census";

/**
 * One derived pie over one list of sender-described entries — the single
 * body behind both exported builders below, which differ only in their id,
 * their name, and how an entry yields a path and a timestamp.
 *
 * THE KIND COMES FROM `e.name`, NEVER FROM THE PATH. `name` is the only
 * field defined to be the SENDER's own filename: a beam's landed path can
 * carry a disambiguating `-2`/`-3` suffix (`beam.rs`'s `unique_name`), and a
 * shared member's path is a foreign host path this side must not parse at
 * all (`SharedEntry`'s own doc comment). That is also why `name` is carried
 * into the row: it is the same name the phone's "Received" list shows, so
 * one file never reads under two names on one screen.
 *
 * `fresh`/`census` are left unset, and never set anywhere below: a derived
 * pie has no `seen_at`, so `Pie.tsx` draws no `+N` pill on it — the M6
 * brief's "no pill" decision, held by construction rather than by a
 * runtime check.
 */
function pieOf<E extends { name: string }>(
  id: string,
  name: string,
  entries: E[],
  toPath: (entry: E) => string,
  atSecs: (entry: E) => number,
): DerivedPie {
  return {
    id,
    name,
    files: entries.map((e) => ({
      path: toPath(e),
      name: e.name,
      kind: kindOf(e.name),
      mtime: secsToMs(atSecs(e)),
    })),
  };
}

/** The band's Received pie — every past beam under the phone's own
 *  `received/` tree. */
export function receivedPie(entries: BeamReceivedEntry[]): DerivedPie {
  return pieOf(
    BUILTIN_RECEIVED_ID,
    "Received",
    entries,
    (e) => e.path,
    (e) => e.received_at,
  );
}

/** One "Shared from &lt;device&gt;" pie for a single online peer's offers.
 *  `peer` is the node id (the address authority — `formatRemoteAddress`);
 *  `device` is its display label. Member paths are
 *  `skypie-remote://<peer><host-path>` — a REMOTE address, never a local
 *  filesystem path, so a pie built here must never reach
 *  `derived-pies.ts`'s builders or any code that calls
 *  `fs`/`ipc.canonicalizePath` on a pie's own files (this file's header
 *  comment). */
export function sharedPie(peer: string, device: string, entries: SharedEntry[]): DerivedPie {
  return pieOf(
    sharedPieId(peer),
    `Shared from ${device}`,
    entries,
    (e) => formatRemoteAddress(peer, e.path),
    (e) => e.shared_at,
  );
}

/** `PhonePieSheet.tsx`'s row order — `pie-census.ts`'s own `byRow`, the
 *  comparator the desktop plate's layer list already sorts with, so the row
 *  a beam or a share just added is on top on both platforms for the same
 *  reason. Pulled out of the component: there is no jsdom in `ui/`, so a
 *  sort living inside a component is only reachable from e2e, while a plain
 *  export is something `ios-pies.test.ts` can call directly. */
export function pieRows(pie: DerivedPie): DerivedPieFile[] {
  return [...pie.files].sort(byRow);
}

/** One peer's shared-list fetch, already resolved to a display label —
 *  `ios-pies-context.tsx` collects these from its own `remoteListShared`
 *  fan-out, so this module never has to look a peer up itself. */
export interface IosSharedSource {
  peer: string;
  device: string;
  entries: SharedEntry[];
}

/** What each online peer has offered this phone, keyed by node id. A RECORD
 *  rather than an array: one peer's slot is written without reading any
 *  other's, which is what lets one device's fetch land — or one device drop
 *  off — without disturbing the rest. */
export type SharedByPeer = Record<string, SharedEntry[]>;

/** One peer's fetch result written into the map. REPLACES that peer's array
 *  (a second fetch for the same device must not append its list twice) and
 *  leaves every other peer's array identical BY REFERENCE, so a neighbour's
 *  pie is not rebuilt. Pure, and exported so that guarantee is testable —
 *  it lives inside a `setShared` updater otherwise, where `ui/` (no jsdom)
 *  cannot reach it. */
export function withPeerEntries(
  prev: SharedByPeer,
  peer: string,
  entries: SharedEntry[],
): SharedByPeer {
  return { ...prev, [peer]: entries };
}

/** One peer dropped. Returns `prev` ITSELF when the peer is not in the map,
 *  so an unmount for a device that never answered schedules no re-render. */
export function withoutPeer(prev: SharedByPeer, peer: string): SharedByPeer {
  if (!(peer in prev)) return prev;
  const next = { ...prev };
  delete next[peer];
  return next;
}

/** The `iosPies` input, resolved from the fetched map plus the paired-device
 *  list. A peer absent from `peers` is DROPPED rather than labelled with its
 *  raw node id: that pairing is gone, and a pie titled "Shared from
 *  k51qzi5u…" names nothing a person recognises. This is reachable for the
 *  render between a peer leaving `peers` and its fetch slot being cleaned
 *  up. */
export function sharedSourcesOf(shared: SharedByPeer, peers: RemotePeer[]): IosSharedSource[] {
  const deviceOf = new Map(peers.map((p) => [p.node_id, p.device]));
  return Object.entries(shared)
    .filter(([peer]) => deviceOf.has(peer))
    .map(([peer, entries]) => ({ peer, device: deviceOf.get(peer)!, entries }));
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
