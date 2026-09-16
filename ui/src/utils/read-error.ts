// Turning a backend read failure into something a reader can act on.
import type { LoadErrorKind } from "../ipc";

/** A pull that failed because the two devices are not paired — either the
 *  peer said so (`unpaired`) or this side never dialed (`local`). */
export function isUnpairedKind(kind: LoadErrorKind): boolean {
  return kind === "remote-unpaired" || kind === "remote-local";
}

/** A pull the host ANSWERED and turned down — this one file, or the session
 *  itself. Not asleep, so "wake it" is the wrong advice. */
export function isRefusedKind(kind: LoadErrorKind): boolean {
  return kind === "remote-denied" || kind === "remote-refused";
}

/**
 * The load path stamps a local failure as kind "Io" and carries the real
 * message in `reason`, so that classification has to come from the text. A
 * pull carries its cause in the kind itself, and the text never decides it.
 *
 * The backend renders paths with `{:?}`, which quotes them, and a path can
 * contain any word we match on — `.../pages/NotFound.tsx` is a real filename —
 * so quoted segments are stripped before matching. Order matters after that:
 * `path is out of root: "…"` must not be read as a permission failure.
 */
export function readErrorTitle(kind: LoadErrorKind, reason: string): string {
  if (kind.startsWith("remote-")) {
    if (isUnpairedKind(kind)) return "Not a paired device";
    if (isRefusedKind(kind)) return "The device refused this file";
    return "Device unreachable";
  }
  const text = `${kind} ${reason}`.replace(/"[^"]*"/g, " ").toLowerCase();
  if (text.includes("out of root")) return "Outside the workspace";
  if (text.includes("permission") || text.includes("denied")) return "Permission denied";
  if (text.includes("not found") || text.includes("no such file")) return "File not found";
  return "Could not read this file";
}
