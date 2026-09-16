// The poll policy for comments on a pulled tab.
//
// The wire is one response per request with no events (decision of
// 2026-09-12), so the reader asks. This module decides HOW OFTEN, as a pure
// function the hook in `state/remote-comment-sync.ts` obeys, so the policy is
// testable without a timer or a DOM.

/** The interval between two passes while the host answers. */
export const BASE_SYNC_MS = 10_000;

/** The ceiling on the backoff: a closed host is re-dialed at most this
 * often while the tab stays visible unattended. */
export const MAX_SYNC_MS = 120_000;

/** The gap under which a second wake-up trigger (focus right after
 * visibility, or the reverse) is the same event and runs no second pass. */
export const WAKE_GAP_MS = 2_000;

/**
 * How long to wait before the next pass, given how many passes in a row have
 * failed (0 = the last one succeeded).
 *
 * Exponential with a ceiling: 10 s, 20 s, 40 s, 80 s, then 120 s. A pass
 * against a closed host costs a full dial timeout on this side, so a flat
 * 10 s meant one dial every ~40 s for as long as the tab was open. A focus
 * or visibility change still triggers an immediate pass, so the ceiling only
 * bounds the UNATTENDED case; a reopened host is seen the moment the reader
 * comes back to the window.
 */
export function nextSyncDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_SYNC_MS, BASE_SYNC_MS * 2 ** consecutiveFailures);
}
