import { describe, expect, it } from "vitest";
import { iosPies, receivedPie, sharedPie } from "./ios-pies";
import type { BeamReceivedEntry, SharedEntry } from "../ipc";

describe("receivedPie", () => {
  it("converts received_at seconds to ms", () => {
    const entries: BeamReceivedEntry[] = [
      { path: "/state/received/2026-09-17/pricing.html", name: "pricing.html", size: 100, received_at: 1_700_000_000 },
    ];
    const pie = receivedPie(entries);
    expect(pie.id).toBe("builtin:received");
    expect(pie.name).toBe("Received");
    expect(pie.files).toEqual([
      { path: "/state/received/2026-09-17/pricing.html", kind: "html", mtime: 1_700_000_000_000 },
    ]);
  });

  it("derives kind from the sender-supplied name, not the on-disk path", () => {
    // beam.rs's own unique_name can disambiguate the ON-DISK filename
    // (a collision-avoiding "-2" suffix) while `name` stays the sender's
    // original — the kind must follow `name`, not the path that landed.
    const entries: BeamReceivedEntry[] = [
      { path: "/state/received/2026-09-17/pricing-2.dat", name: "pricing.html", size: 1, received_at: 1 },
    ];
    expect(receivedPie(entries).files[0].kind).toBe("html");
  });

  it("leaves fresh/newestFreshPath/census unset — no freshness pill on a derived pie", () => {
    const pie = receivedPie([{ path: "/a", name: "a.md", size: 1, received_at: 1 }]);
    expect(pie.fresh).toBeUndefined();
    expect(pie.newestFreshPath).toBeUndefined();
    expect(pie.census).toBeUndefined();
  });

  it("is empty for no entries", () => {
    expect(receivedPie([]).files).toEqual([]);
  });
});

describe("sharedPie", () => {
  it("builds a skypie-remote:// member address and converts shared_at to ms", () => {
    const entries: SharedEntry[] = [{ path: "/Users/mac/report.html", name: "report.html", shared_at: 1_700_000_100 }];
    const pie = sharedPie("peer-1", "Alvaro's Mac", entries);
    expect(pie.id).toBe("builtin:shared:peer-1");
    expect(pie.name).toBe("Shared from Alvaro's Mac");
    expect(pie.files).toEqual([
      { path: "skypie-remote://peer-1/Users/mac/report.html", kind: "html", mtime: 1_700_000_100_000 },
    ]);
  });

  it("derives kind from the sender-supplied name, not the host path — a remote address is not a local path", () => {
    const entries: SharedEntry[] = [{ path: "/Users/mac/odd-2.dat", name: "notes.md", shared_at: 1 }];
    expect(sharedPie("peer-1", "Mac", entries).files[0].kind).toBe("md");
  });

  it("is empty for no entries", () => {
    expect(sharedPie("peer-1", "Mac", []).files).toEqual([]);
  });
});

describe("iosPies", () => {
  const received: BeamReceivedEntry[] = [{ path: "/r/a.html", name: "a.html", size: 1, received_at: 1 }];

  it("puts Received first, then one pie per peer sorted by device label", () => {
    const shared = [
      { peer: "peer-b", device: "Zed's Mac", entries: [{ path: "/b.md", name: "b.md", shared_at: 1 }] },
      { peer: "peer-a", device: "Alvaro's Mac", entries: [{ path: "/a.md", name: "a.md", shared_at: 1 }] },
    ];
    const pies = iosPies(received, shared);
    expect(pies.map((p) => p.id)).toEqual(["builtin:received", "builtin:shared:peer-a", "builtin:shared:peer-b"]);
    expect(pies.map((p) => p.name)).toEqual(["Received", "Shared from Alvaro's Mac", "Shared from Zed's Mac"]);
  });

  it("drops a pie with zero files — an empty Received and a peer with no offers", () => {
    const shared = [{ peer: "peer-a", device: "Alvaro's Mac", entries: [] }];
    expect(iosPies([], shared)).toEqual([]);
  });

  it("drops only the empty pie, keeping a non-empty one beside it", () => {
    const shared = [{ peer: "peer-a", device: "Mac", entries: [{ path: "/a", name: "a.txt", shared_at: 1 }] }];
    const pies = iosPies([], shared);
    expect(pies.map((p) => p.id)).toEqual(["builtin:shared:peer-a"]);
  });

  it("with no online peer, no builtin:shared: pie appears at all", () => {
    const pies = iosPies(received, []);
    expect(pies.map((p) => p.id)).toEqual(["builtin:received"]);
  });

  it("one pie per peer even when a peer offers several files", () => {
    const shared = [
      {
        peer: "peer-a",
        device: "Mac",
        entries: [
          { path: "/a.md", name: "a.md", shared_at: 1 },
          { path: "/b.html", name: "b.html", shared_at: 2 },
        ],
      },
    ];
    const pies = iosPies([], shared);
    expect(pies).toHaveLength(1);
    expect(pies[0].files).toHaveLength(2);
  });

  it("order is stable regardless of input order", () => {
    const shared = [
      { peer: "p3", device: "C", entries: [{ path: "/c", name: "c.md", shared_at: 1 }] },
      { peer: "p1", device: "A", entries: [{ path: "/a", name: "a.md", shared_at: 1 }] },
      { peer: "p2", device: "B", entries: [{ path: "/b", name: "b.md", shared_at: 1 }] },
    ];
    expect(iosPies([], shared).map((p) => p.name)).toEqual(["Shared from A", "Shared from B", "Shared from C"]);
  });
});
