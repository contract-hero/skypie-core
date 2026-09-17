// IPC surface between the React frontend and the Rust Tauri core.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { parseRemoteAddress } from "./utils/remote-address";
import type {
  Annotation,
  AnnotationIndexEntry,
  Selector,
  Status as AnnotationStatus,
} from "./annotations/types";
// Re-exported so a consumer of the IPC surface imports the shapes it
// returns from the same module, as it already does for RecentEntry.
export type { Annotation, AnnotationIndexEntry, Selector };

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FilePayload {
  path: string;
  size: number;
  mtime: number;
  is_binary: boolean;
  oversized: boolean;
  /** How `content` is encoded: UTF-8 text or base64 (raster images). */
  encoding?: "text" | "base64";
  content: string | null;
  /** Authored by another machine — a beam landing under `received/`, or a
   * file pulled from a paired device under `cache/`. The renderer isolates
   * it. Set by the Rust reader, so the trust decision never races an async
   * lookup. */
  untrusted?: boolean;
}

/** Flat recursive file index returned by `list_files_recursive` (⌘P). */
export interface FileIndex {
  root: string;
  /** Paths relative to `root`, BFS (shallow-first) order. */
  files: string[];
  truncated: boolean;
}

export interface RecentEntry {
  path: string;
  opened_at: number;
}

export interface BookmarkEntry {
  path: string;
  bookmarked_at: number;
}

// ── User pies (M2, spec section 9) ──────────────────────────────────────────
// All timestamps here are MS epoch — `app/src/pies.rs` writes
// `SystemTime::as_millis`. This is deliberately a different clock than
// `RecentEntry`/`BookmarkEntry` above (seconds, `as_secs`): those are
// unrelated persisted documents with their own established on-disk shape,
// and `derived-pies.ts` converts them to ms at the UI boundary instead of
// this store being "unified" onto their resolution.

/** Where a member came from — the picker, a file-menu "Add to pie…", a
 *  Finder drop (M4) or an agent over the socket (M5). Optional: M2 only
 *  ever sends "picker" or "menu". */
export type PieMemberSource = "picker" | "menu" | "finder" | "agent";

/** What a pie member IS on disk. Named rather than inlined because
 *  `addPieMember` takes it as an OPTIONAL argument — see there. */
export type PieMemberKind = "file" | "folder";

export interface PieMemberOrigin {
  session_id?: string;
  prompt_id?: string;
  cwd?: string;
}

export interface PieMember {
  kind: PieMemberKind;
  /** Absolute, canonical — `pies::add_member` runs `fs::canonicalize`
   *  before storing, so this always matches the watcher's own paths. */
  path: string;
  added_at: number;
  source?: PieMemberSource;
  origin?: PieMemberOrigin;
}

export interface Pie {
  id: string;
  name: string;
  created_at: number;
  /** Set on every plate open (`touchPieSeen`); freshness (`mtime >
   *  seen_at`, the +N pill) is M3. */
  seen_at: number;
  members: PieMember[];
}

// ── Folder census (M3, spec sections 6/9) ───────────────────────────────────
// Mirrors `app/src/workspace.rs`'s `CensusFile`/`PieCensus` field for field
// (snake_case throughout, matching every other Rust-shaped interface in this
// file). Deliberately no `kind` here — `kindOf` (render/kind.ts) stays the
// single kind table; `pie-census.ts`'s `censusToFiles` adds `kind` when it
// adapts this into a `DerivedPieFile`.

export interface CensusFile {
  path: string;
  /** ms epoch — `metadata.modified()` converted in Rust, same clock as
   *  every other pies timestamp. */
  mtime: number;
  size: number;
  /** The folder MEMBER this file was found under (always that member's own
   *  canonical path, never an intermediate subdirectory) — absent for a
   *  direct FILE member. */
  folder?: string;
}

export interface PieCensus {
  files: CensusFile[];
  /** Member paths that no longer resolve — a `NotFound` error, or a path
   *  that is now the wrong kind of thing. Any OTHER I/O failure lands in
   *  `unreadable`, not here. */
  missing: string[];
  /** Member paths that exist (or may exist) but could not be read —
   *  captioned "can't read this folder" in the plate. Omitted on the wire
   *  when empty, which is the normal case. */
  unreadable?: string[];
  /** Member paths not under the canonical workspace root — captioned "not
   *  live" in the plate; these only refresh on sky show / plate open. */
  outside_root: string[];
  /** Files the walk found but could not `stat`: they are in none of the
   *  lists above, so this count is the only thing that says the pie is
   *  short by that many. */
  skipped: number;
  truncated: boolean;
  /** The canonical PATH of the member cut by the 20,000 cap — a path, not
   *  an index, because the receiver's own member list is read at a
   *  different moment and an index into it can name the wrong member.
   *  `missing`/`unreadable`/`outside_root` stay COMPLETE on a truncated
   *  census; only `files` is partial. */
  truncated_at?: string;
  // No `fresh`: spec section 9 lists one, but the server cannot compute it
  // correctly. `touchPieSeen` moves `seen_at` OPTIMISTICALLY on the client
  // the instant a plate opens, so a count measured against the server's
  // `seen_at` is already stale when it arrives — `pie-census.ts`'s
  // `freshCount` derives it from `files` instead. See `PieCensus` in
  // app/src/workspace.rs.
}

/** The persisted `pies` document (`state.json`'s `"pies"` key). An unknown
 *  `v` means an older build is reading a newer build's document: `list()`
 *  then returns no pies and no write ever replaces the key (app/src/pies.rs). */
export interface PiesDoc {
  v: 1;
  pies: Pie[];
}

/** What `listPies` and `skypie://pies-updated` carry: the pies, plus the
 *  reason there are none when this build cannot read the document. An empty
 *  `pies` array alone is ambiguous — "you have no pies" and "your pies are
 *  on disk and unreadable by this build" looked identical in the band.
 *  `usePies` raises `warning` as one notice (`pies::PiesList`). */
export interface PiesList {
  pies: Pie[];
  warning?: string;
}

export interface SettingsState {
  schema_version: number;
  roots: string[];
  recents?: RecentEntry[];
  bookmarks?: BookmarkEntry[];
  panes?: {
    sidebar_px?: number;
    preview_px?: number;
    sidebar_visible?: boolean;
    /** The Sky band (⌘⇧B), default false. No Rust field required: the
     *  in-memory state document is a raw serde_json::Value and PaneSizes has
     *  no deny_unknown_fields, so this nested key round-trips unchanged. */
    sky_visible?: boolean;
    /** The reading session: open tabs, their history and zoom. */
    tabs?: unknown;
  };
  preferences: {
    ignore_globs: string[];
    drag_out_mode: "file" | "url";
    slack_target?: string | null;
    beam_ttl_hours?: number;
    /** Accept paired devices at launch (default on). */
    remote_listen?: boolean;
  };
}

/** Anchor rect for the native share popover, from getBoundingClientRect(). */
export interface ShareAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One active Beam offer (this instance is serving the staged blob). */
export interface BeamOffer {
  /** Offer id == the blob's BLAKE3 hash (hex). */
  id: string;
  path: string;
  name: string;
  size: number;
  ticket: string;
  /** The shareable `skypie://receive?…` deep link. */
  link: string;
  created_at: number;
  expires_at: number;
  fetches: number;
}

/** A completed receive: where the verified blob landed. */
export interface BeamReceivedFile {
  path: string;
  name: string;
  size: number;
  hash: string;
}

/** One past beam in the received/ tree. */
export interface BeamReceivedEntry {
  path: string;
  name: string;
  size: number;
  received_at: number;
}

// ── Paired devices ──────────────────────────────────────────────────────────

/** One trusted, paired peer — one of the user's own devices. */
export interface RemotePeer {
  node_id: string;
  device: string;
  paired_at: number;
  last_seen: number;
}

/** `remote_pair_begin` — the link + fingerprint material for the host face. */
export interface RemotePairInvite {
  ticket: string;
  /** `skypie://pair?ticket=…` */
  link: string;
  node_id: string;
  device: string;
  expires_at: number;
}

/** A pairing that reached the fingerprint step, on EITHER side. */
export interface RemotePendingPair {
  node_id: string;
  device: string;
  /** The six words both screens must show. */
  fingerprint: string[];
  role: "host" | "guest";
  created_at: number;
}

/** `remote_share_link` — a `skypie://open?path=…&from=<this node>` link for a
 * local file, which any device paired with this one can open. */
export interface RemoteShareLink {
  link: string;
  node_id: string;
  device: string;
  path: string;
  name: string;
  size: number;
}

/** One file a paired device has offered this install. Metadata only: the
 *  bytes still arrive through `remoteGet` when the reader taps it. */
export interface SharedEntry {
  /** Absolute path on the HOST. What `remoteGet` is called with. */
  path: string;
  /** Basename, sent by the host so this side never parses a foreign path. */
  name: string;
  /** Unix seconds. The list arrives newest-first. */
  shared_at: number;
}

/** Why `remote_get` failed — the word the tab switches on. */
export type RemoteGetCause = "unpaired" | "unreachable" | "refused" | "local" | "denied";
export interface RemoteGetError {
  cause: RemoteGetCause;
  reason: string;
}

/** The reducer's error kind: a local read, or a pull with its typed cause. */
export type LoadErrorKind = "Io" | "remote-unknown" | `remote-${RemoteGetCause}`;

/** A verified artifact fetched from a peer, landed in the local
 * content-addressed cache. `path` is the LOCAL file the render pipeline
 * reads; `remote_path` is the identity on the host. */
export interface RemoteArtifact {
  peer: string;
  remote_path: string;
  path: string;
  hash: string;
  size: number;
  mtime: number;
  warn: boolean;
}

/** `skypie://remote-presence`. */
export interface RemotePresenceEvent {
  peer: string;
  state: "connecting" | "online" | "offline";
  device: string | null;
  reason: string | null;
}

/** `skypie://remote-event` — tagged on `kind`, fields stay snake_case (the
 * wire shape the backend emits verbatim). */
export type RemoteEvent =
  /** A `skypie://open?…&from=<paired device>` link arrived. The file lives on
   * `peer`; opening a tab at its remote address pulls it. */
  | {
      kind: "open-remote";
      peer: string;
      device: string;
      path: string;
      line: number | null;
      intent: "open" | "reveal";
    }
  | {
      kind: "pair-pending";
      peer: string;
      device: string;
      fingerprint: string[];
      role: "host" | "guest";
    }
  | { kind: "pair-link"; peer: string; peer_short: string; device: string; ticket: string }
  | { kind: "peers-updated" }
  /** iOS put the app back in front of the user. The backend has already
   * dropped every session it held, so nothing this side cached about a live
   * connection is true any more. */
  | { kind: "resumed" };

/** `platform_info` — the one signal the frontend uses to tell the desktop
 * and iOS builds apart (PRODUCT.md Operating Context). Optional: older
 * builds / test doubles without it fall back to macOS (see
 * `state/platform.tsx`). */
export interface PlatformInfo {
  os: "macos" | "ios";
}

export interface IpcSurface {
  listProjects(): Promise<ProjectEntry[] | string[]>;
  listDir(projectPath: string): Promise<TreeEntry[]>;
  readFile(path: string): Promise<FilePayload>;
  setWorkspaceRoot?(path: string): void;
  watchRoot?(path: string): Promise<void>;
  refreshProject?(projectPath: string): Promise<void>;
  getState?(): Promise<SettingsState>;
  setStateField?(key: string, value: unknown): Promise<void>;
  pickDirectory?(): Promise<string | null>;
  pickFile?(): Promise<string | null>;
  listRecents?(): Promise<RecentEntry[]>;
  pushRecent?(path: string): Promise<void>;
  listBookmarks?(): Promise<BookmarkEntry[]>;
  addBookmark?(path: string): Promise<void>;
  removeBookmark?(path: string): Promise<void>;
  reorderBookmarks?(paths: string[]): Promise<void>;

  /** User pies, in stored (band) order, plus a `warning` when the document
   *  could not be read at all — see `PiesList`. */
  listPies?(): Promise<PiesList>;
  /** Create (`id` omitted) or rename (`id` given) a pie; resolves to the
   *  resulting `Pie` so a fresh create's real (server-minted) id comes
   *  back. */
  upsertPie?(id: string | null, name: string): Promise<Pie>;
  removePie?(id: string): Promise<void>;
  /** Adds `path` to pie `id`. Rejects if `path` cannot be canonicalized
   *  (i.e. does not exist), and also when `id` names no pie — a file added
   *  to a pie another window just deleted is an error, not a silent drop.
   *
   *  `kind` is OPTIONAL: omit it and the backend reads it off the
   *  canonical path it has just resolved (`is_dir()`). Callers that
   *  already know pass it through unchanged — the picker only ever adds a
   *  file, the "Add folder…" menu item only ever a folder. A Finder drop
   *  omits it: the drop carries no such promise, and probing for one from
   *  the UI cost an extra IPC round trip per dropped path. */
  addPieMember?(id: string, path: string, kind?: PieMemberKind, source?: PieMemberSource): Promise<void>;
  removePieMember?(id: string, path: string): Promise<void>;
  relocatePieMember?(id: string, oldPath: string, newPath: string): Promise<void>;
  /** Stamp `seen_at` to now — called on every plate open for a user pie. */
  touchPieSeen?(id: string): Promise<void>;
  /** M3: walk pie `id`'s members and report every file they hold, plus
   *  each member's state (`missing`/`unreadable`/`outside_root`).
   *  Freshness is NOT reported — `pie-census.ts`'s `freshCount` derives it
   *  client-side, see `PieCensus`. `root` is the
   *  current workspace root (or `null` with none open) — used only to
   *  classify `outside_root`. An unknown id resolves to an empty census,
   *  never a rejection (`pie_census_for`'s own contract). */
  pieCensus?(id: string, root: string | null): Promise<PieCensus>;
  /** Resolves `path` to its canonical form (`std::fs::canonicalize`) —
   *  called before comparing a caller-supplied path (a tab entry, a tree
   *  row) against a pie's stored (always-canonical) members, e.g.
   *  `PiePicker`'s checkmark. Runs the same canonicalisation gate the add
   *  itself runs, and rejects the same way when the path cannot be
   *  resolved. */
  canonicalizePath?(path: string): Promise<string>;

  listFilesRecursive?(root: string): Promise<FileIndex>;
  /**
   * Replace the set of individually watched out-of-root files (open external
   * tabs). Empty array clears the watcher. Changes arrive as
   * `skypie://file-changed` events.
   */
  watchExternalPaths?(paths: string[]): Promise<void>;
  shareFile?(paths: string[], anchor: ShareAnchor): Promise<void>;
  /**
   * Hand a `skypie://` link (a pairing or beam ticket) to the native share
   * sheet, anchored like `shareFile`. macOS only — the iOS companion shares
   * links through the WKWebView Web Share API instead, because this build
   * carries no UIKit bindings.
   */
  shareLink?(link: string, anchor: ShareAnchor): Promise<void>;
  /** Stage a file and mint its beam ticket (boots the endpoint lazily). */
  beamOffer?(path: string): Promise<BeamOffer>;
  /** Revoke an active offer — the ticket dies instantly. */
  beamStop?(offerId: string): Promise<void>;
  /** Active offers. Never boots the endpoint. */
  beamListOffers?(): Promise<BeamOffer[]>;
  /** Post-confirm fetch; progress arrives as `skypie://beam-progress`. */
  beamReceive?(ticket: string, name?: string): Promise<BeamReceivedFile>;
  /** Where received artifacts land (badge prefix check). */
  beamReceivedDir?(): Promise<string>;
  /** Past beams, newest first. */
  beamListReceived?(): Promise<BeamReceivedEntry[]>;

  /** Trusted peers, newest pairing first. Never boots the endpoint. */
  remoteListPeers?(): Promise<RemotePeer[]>;
  /** Mint a one-time pairing ticket + link. Boots the endpoint. */
  remotePairBegin?(): Promise<RemotePairInvite>;
  /** Open a pairing ticket and park at the fingerprint step. */
  remotePairComplete?(ticket: string): Promise<RemotePendingPair>;
  /** Resolve a parked pairing after the human compares the six words. */
  remotePairConfirm?(nodeId: string, accept: boolean): Promise<RemotePeer | null>;
  /** Revoke a peer. Never boots. */
  remoteUnpair?(nodeId: string): Promise<void>;
  /** Dial a paired device so its presence is known. Boots the endpoint. */
  remoteConnect?(peer: string): Promise<void>;
  /** Fetch an artifact from a peer into the local cache. */
  remoteGet?(peer: string, path: string): Promise<RemoteArtifact>;
  /** What `peer` has offered this device. Empty when it cannot be asked. */
  remoteListShared?(peer: string): Promise<SharedEntry[]>;
  /** Reconcile the comments on a pulled tab with the host, both ways.
   * `source` is the tab's `skypie-remote://` address — the store key the
   * rail reads, passed through so the backend never rebuilds it. */
  remoteSyncAnnotations?(peer: string, path: string, source: string): Promise<void>;
  /** A `skypie://open?…&from=<this node>` link for a local file. Boots. */
  remoteShareLink?(path: string): Promise<RemoteShareLink>;

  /** Every comment on one file, replies included, oldest first. */
  annotationsList?(source: string): Promise<Annotation[]>;
  /** Files that have comments, newest activity first — the sidebar badges. */
  annotationsIndex?(): Promise<AnnotationIndexEntry[]>;
  /** Create a root comment. An empty body makes it a bare highlight. */
  annotationsAdd?(
    source: string,
    body: string,
    selector: Selector[],
    session?: string | null,
  ): Promise<Annotation>;
  /** Reply inside a thread. */
  annotationsReply?(source: string, parentId: string, body: string): Promise<Annotation>;
  /** Mark a thread addressed, reopened, or won't-fix. */
  annotationsSetStatus?(
    source: string,
    id: string,
    status: AnnotationStatus,
    note?: string | null,
  ): Promise<Annotation>;
  /** Write the feedback beside the file, on explicit request only. */
  annotationsExport?(source: string): Promise<string>;

  /** Which shell this build runs in — macOS desktop or the iOS companion. */
  platformInfo?(): Promise<PlatformInfo>;
}

const WORKSPACE_ROOT_KEY = "skypie.workspaceRoot";

function loadWorkspaceRoot(): string | null {
  try {
    return globalThis.localStorage?.getItem(WORKSPACE_ROOT_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveWorkspaceRoot(path: string): void {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_ROOT_KEY, path);
  } catch {
    // ignore
  }
}

class TauriIpc implements IpcSurface {
  private workspaceRoot: string | null = loadWorkspaceRoot();

  setWorkspaceRoot(path: string): void {
    this.workspaceRoot = path;
    saveWorkspaceRoot(path);
  }

  async listProjects(): Promise<ProjectEntry[]> {
    if (!this.workspaceRoot) {
      throw new Error("NO_WORKSPACE_ROOT");
    }
    return await invoke<ProjectEntry[]>("list_workspace_roots", {
      path: this.workspaceRoot,
    });
  }

  async listDir(projectPath: string): Promise<TreeEntry[]> {
    return await invoke<TreeEntry[]>("list_dir", { path: projectPath });
  }

  async readFile(path: string): Promise<FilePayload> {
    // A `skypie-remote://<peer>/abs/path` tab address: fetch the verified
    // artifact into the local content-addressed cache, then read THAT file
    // for bytes — `read_file` is deliberately ungated (see reader.rs), and
    // the cache path is our own app-data file, not attacker-controlled. The
    // returned payload's `path` is overwritten back to the remote address:
    // that address, not the hash-addressed cache file, is the stable
    // identity scroll memory and tab reload key off, and it must survive a
    // reload landing at a NEW cache path.
    const remote = parseRemoteAddress(path);
    if (remote) {
      const artifact = await this.remoteGet(remote.peer, remote.path);
      const payload = await invoke<FilePayload>("read_file", { path: artifact.path });
      return { ...payload, path };
    }
    return await invoke<FilePayload>("read_file", { path });
  }

  async watchRoot(path: string): Promise<void> {
    await invoke<void>("set_workspace_root", { path });
  }

  async pickDirectory(): Promise<string | null> {
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose workspace folder",
    });
    if (typeof result === "string") return result;
    return null;
  }

  async pickFile(): Promise<string | null> {
    const result = await openDialog({
      directory: false,
      multiple: false,
      title: "Open file",
    });
    if (typeof result === "string") return result;
    return null;
  }

  async getState(): Promise<SettingsState> {
    return await invoke<SettingsState>("get_state");
  }

  async setStateField(key: string, value: unknown): Promise<void> {
    await invoke<void>("set_state_field", { key, value });
  }

  async listRecents(): Promise<RecentEntry[]> {
    return await invoke<RecentEntry[]>("list_recents");
  }

  async pushRecent(path: string): Promise<void> {
    await invoke<void>("push_recent", { path });
  }

  async listBookmarks(): Promise<BookmarkEntry[]> {
    return await invoke<BookmarkEntry[]>("list_bookmarks");
  }

  async addBookmark(path: string): Promise<void> {
    await invoke<void>("add_bookmark", { path });
  }

  async removeBookmark(path: string): Promise<void> {
    await invoke<void>("remove_bookmark", { path });
  }

  async reorderBookmarks(paths: string[]): Promise<void> {
    await invoke<void>("reorder_bookmarks", { paths });
  }

  async listPies(): Promise<PiesList> {
    return await invoke<PiesList>("list_pies");
  }

  async upsertPie(id: string | null, name: string): Promise<Pie> {
    return await invoke<Pie>("upsert_pie", { id, name });
  }

  async removePie(id: string): Promise<void> {
    await invoke<void>("remove_pie", { id });
  }

  async addPieMember(
    id: string,
    path: string,
    kind?: PieMemberKind,
    source?: PieMemberSource,
  ): Promise<void> {
    await invoke<void>("add_pie_member", { id, path, kind, source });
  }

  async removePieMember(id: string, path: string): Promise<void> {
    await invoke<void>("remove_pie_member", { id, path });
  }

  async relocatePieMember(id: string, oldPath: string, newPath: string): Promise<void> {
    await invoke<void>("relocate_pie_member", { id, old: oldPath, new: newPath });
  }

  async touchPieSeen(id: string): Promise<void> {
    await invoke<void>("touch_pie_seen", { id });
  }

  async pieCensus(id: string, root: string | null): Promise<PieCensus> {
    return await invoke<PieCensus>("pie_census", { id, root });
  }

  async canonicalizePath(path: string): Promise<string> {
    return await invoke<string>("canonicalize_path", { path });
  }

  async listFilesRecursive(root: string): Promise<FileIndex> {
    return await invoke<FileIndex>("list_files_recursive", { path: root });
  }

  async watchExternalPaths(paths: string[]): Promise<void> {
    await invoke<void>("watch_external_paths", { paths });
  }

  async shareFile(paths: string[], anchor: ShareAnchor): Promise<void> {
    await invoke<void>("share_file", { paths, anchor });
  }

  async shareLink(link: string, anchor: ShareAnchor): Promise<void> {
    await invoke<void>("share_link", { link, anchor });
  }

  async beamOffer(path: string): Promise<BeamOffer> {
    return await invoke<BeamOffer>("beam_offer", { path });
  }

  async beamStop(offerId: string): Promise<void> {
    await invoke<void>("beam_stop", { offerId });
  }

  async beamListOffers(): Promise<BeamOffer[]> {
    return await invoke<BeamOffer[]>("beam_list_offers");
  }

  async beamReceive(ticket: string, name?: string): Promise<BeamReceivedFile> {
    return await invoke<BeamReceivedFile>("beam_receive", { ticket, name });
  }

  async beamReceivedDir(): Promise<string> {
    return await invoke<string>("beam_received_dir");
  }

  async beamListReceived(): Promise<BeamReceivedEntry[]> {
    return await invoke<BeamReceivedEntry[]>("beam_list_received");
  }

  async remoteListPeers(): Promise<RemotePeer[]> {
    return await invoke<RemotePeer[]>("remote_list_peers");
  }

  async remotePairBegin(): Promise<RemotePairInvite> {
    return await invoke<RemotePairInvite>("remote_pair_begin");
  }

  async remotePairComplete(ticket: string): Promise<RemotePendingPair> {
    return await invoke<RemotePendingPair>("remote_pair_complete", { ticket });
  }

  async remotePairConfirm(nodeId: string, accept: boolean): Promise<RemotePeer | null> {
    return await invoke<RemotePeer | null>("remote_pair_confirm", { nodeId, accept });
  }

  async remoteUnpair(nodeId: string): Promise<void> {
    await invoke<void>("remote_unpair", { nodeId });
  }

  async remoteConnect(peer: string): Promise<void> {
    await invoke<void>("remote_connect", { peer });
  }

  async remoteListShared(peer: string): Promise<SharedEntry[]> {
    return await invoke<SharedEntry[]>("remote_list_shared", { peer });
  }

  async remoteGet(peer: string, path: string): Promise<RemoteArtifact> {
    return await invoke<RemoteArtifact>("remote_get", { peer, path });
  }

  async remoteSyncAnnotations(peer: string, path: string, source: string): Promise<void> {
    await invoke<void>("remote_sync_annotations", { peer, path, source });
  }

  async remoteShareLink(path: string): Promise<RemoteShareLink> {
    return await invoke<RemoteShareLink>("remote_share_link", { path });
  }

  async annotationsList(source: string): Promise<Annotation[]> {
    return await invoke<Annotation[]>("annotations_list", { source });
  }

  async annotationsIndex(): Promise<AnnotationIndexEntry[]> {
    return await invoke<AnnotationIndexEntry[]>("annotations_index");
  }

  async annotationsAdd(
    source: string,
    body: string,
    selector: Selector[],
    session?: string | null,
  ): Promise<Annotation> {
    return await invoke<Annotation>("annotations_add", {
      source,
      body,
      selector,
      session: session ?? null,
    });
  }

  async annotationsReply(source: string, parentId: string, body: string): Promise<Annotation> {
    return await invoke<Annotation>("annotations_reply", { source, parentId, body });
  }

  async annotationsSetStatus(
    source: string,
    id: string,
    status: AnnotationStatus,
    note?: string | null,
  ): Promise<Annotation> {
    return await invoke<Annotation>("annotations_set_status", {
      source,
      id,
      status,
      note: note ?? null,
    });
  }

  async annotationsExport(source: string): Promise<string> {
    return await invoke<string>("annotations_export", { source });
  }

  async platformInfo(): Promise<PlatformInfo> {
    return await invoke<PlatformInfo>("platform_info");
  }
}

export const tauriIpc: IpcSurface = new TauriIpc();

export const defaultIpc: IpcSurface = {
  async listProjects() {
    throw new Error("ipc.listProjects: not wired");
  },
  async listDir(_p) {
    throw new Error("ipc.listDir: not wired");
  },
  async readFile(_p) {
    throw new Error("ipc.readFile: not wired");
  },
};
