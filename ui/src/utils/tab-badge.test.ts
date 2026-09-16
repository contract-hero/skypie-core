import { describe, expect, it } from "vitest";
import { tabBadge } from "./tab-badge";

const PEER = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const RECEIVED = "/Users/me/Library/Application Support/SkyPie/received";

describe("tabBadge — where a tab's file came from", () => {
  it("names the device a pulled file came from", () => {
    const badge = tabBadge(`skypie-remote://${PEER}/w/a.html`, true, RECEIVED, (p) =>
      p === PEER ? "Mac Studio" : p.slice(0, 10),
    );
    expect(badge).toEqual({
      kind: "from",
      label: "from Mac Studio",
      title: "Opened from Mac Studio — a read-only copy in this app's cache",
    });
  });

  it("labels with whatever the provider answers, short id included", () => {
    const badge = tabBadge(`skypie-remote://${PEER}/w/a.html`, true, RECEIVED, (p) => p.slice(0, 10));
    expect(badge?.label).toBe("from abcdef0123");
  });

  it("says beamed for a file under the received folder", () => {
    expect(tabBadge(`${RECEIVED}/2026-09-12/a.html`, true, RECEIVED, () => "x")?.kind).toBe(
      "beamed",
    );
  });

  it("says external for a local file outside the workspace, and nothing in it", () => {
    expect(tabBadge("/tmp/a.html", true, RECEIVED, () => "x")?.kind).toBe("external");
    expect(tabBadge("/w/a.html", false, RECEIVED, () => "x")).toBeNull();
    // No received dir known yet: an external file is still external.
    expect(tabBadge("/tmp/a.html", true, null, () => "x")?.kind).toBe("external");
  });

  it("treats a malformed remote address as a plain path", () => {
    // No slash after the peer: not a remote address, so the ordinary rules
    // apply.
    expect(tabBadge("skypie-remote://nopath", true, null, () => "x")?.kind).toBe("external");
  });
});
