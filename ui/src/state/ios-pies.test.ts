import { describe, expect, it } from "vitest";
import {
  iosPies,
  pieRows,
  receivedPie,
  sharedPie,
  sharedSourcesOf,
  withPeerEntries,
  withoutPeer,
} from "./ios-pies";
import type { BeamReceivedEntry, RemotePeer, SharedEntry } from "../ipc";
import type { DerivedPie } from "./derived-pies";

describe("receivedPie", () => {
  it("converts received_at seconds to ms", () => {
    const entries: BeamReceivedEntry[] = [
      { path: "/state/received/2026-09-17/pricing.html", name: "pricing.html", size: 100, received_at: 1_700_000_000 },
    ];
    const pie = receivedPie(entries);
    expect(pie.id).toBe("builtin:received");
    expect(pie.name).toBe("Received");
    expect(pie.files).toEqual([
      {
        path: "/state/received/2026-09-17/pricing.html",
        kind: "html",
        mtime: 1_700_000_000_000,
        name: "pricing.html",
      },
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

  it("leaves fresh/census unset — no freshness pill on a derived pie", () => {
    const pie = receivedPie([{ path: "/a", name: "a.md", size: 1, received_at: 1 }]);
    expect(pie.fresh).toBeUndefined();
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
      {
        path: "skypie-remote://peer-1/Users/mac/report.html",
        kind: "html",
        mtime: 1_700_000_100_000,
        name: "report.html",
      },
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

describe("pieRows", () => {
  it("sorts newest first", () => {
    const pie: DerivedPie = {
      id: "builtin:received",
      name: "Received",
      files: [
        { path: "/a", name: "a", kind: "html", mtime: 10 },
        { path: "/b", name: "b", kind: "html", mtime: 30 },
        { path: "/c", name: "c", kind: "html", mtime: 20 },
      ],
    };
    expect(pieRows(pie).map((f) => f.path)).toEqual(["/b", "/c", "/a"]);
  });

  it("is a stable sort for equal mtimes — ties keep their original relative order", () => {
    const pie: DerivedPie = {
      id: "builtin:received",
      name: "Received",
      files: [
        { path: "/first", name: "first", kind: "html", mtime: 10 },
        { path: "/second", name: "second", kind: "html", mtime: 10 },
        { path: "/third", name: "third", kind: "html", mtime: 10 },
      ],
    };
    expect(pieRows(pie).map((f) => f.path)).toEqual(["/first", "/second", "/third"]);
  });

  it("does not mutate pie.files", () => {
    const files = [
      { path: "/a", name: "a", kind: "html" as const, mtime: 10 },
      { path: "/b", name: "b", kind: "html" as const, mtime: 30 },
    ];
    const pie: DerivedPie = { id: "builtin:received", name: "Received", files };
    pieRows(pie);
    expect(files.map((f) => f.path)).toEqual(["/a", "/b"]);
  });
  it("puts a `missing` row last, whatever its mtime", () => {
    // `byRow` sorts every row that no longer resolves to the bottom, so the
    // newest-first rule never floats a dead member above a live file.
    const pie: DerivedPie = {
      id: "builtin:received",
      name: "Received",
      files: [
        { path: "/old", name: "old", kind: "html", mtime: 10 },
        { path: "/dead", name: "dead", kind: "html", mtime: 99, missing: true },
        { path: "/new", name: "new", kind: "html", mtime: 30 },
      ],
    };
    expect(pieRows(pie).map((f) => f.path)).toEqual(["/new", "/old", "/dead"]);
  });
});

describe("withPeerEntries / withoutPeer", () => {
  const a: SharedEntry[] = [{ path: "/a", name: "a.md", shared_at: 1 }];
  const b: SharedEntry[] = [{ path: "/b", name: "b.md", shared_at: 2 }];

  it("writing peer B leaves A's array identical by reference", () => {
    const prev = { "peer-a": a };
    const next = withPeerEntries(prev, "peer-b", b);
    expect(next["peer-a"]).toBe(a);
    expect(next["peer-b"]).toBe(b);
  });

  it("a second fetch for A replaces its list, never appends to it", () => {
    const again: SharedEntry[] = [{ path: "/a2", name: "a2.md", shared_at: 3 }];
    const next = withPeerEntries({ "peer-a": a }, "peer-a", again);
    expect(next["peer-a"]).toEqual(again);
    expect(Object.keys(next)).toEqual(["peer-a"]);
  });

  it("withoutPeer drops only that peer", () => {
    const next = withoutPeer({ "peer-a": a, "peer-b": b }, "peer-a");
    expect(Object.keys(next)).toEqual(["peer-b"]);
    expect(next["peer-b"]).toBe(b);
  });

  it("withoutPeer on an absent peer returns the SAME object — no re-render", () => {
    const prev = { "peer-a": a };
    expect(withoutPeer(prev, "peer-z")).toBe(prev);
  });
});

describe("sharedSourcesOf", () => {
  const peer = (node_id: string, device: string): RemotePeer => ({
    node_id,
    device,
    paired_at: 0,
    last_seen: 0,
  });
  const entries: SharedEntry[] = [{ path: "/a", name: "a.md", shared_at: 1 }];

  it("drops a peer that is no longer in the paired list", () => {
    // Real for the render between a device leaving `peers` and its fetch
    // slot being cleaned up — a pie titled with a raw node id names nothing.
    const sources = sharedSourcesOf({ "peer-a": entries, "peer-gone": entries }, [
      peer("peer-a", "Alvaro's Mac"),
    ]);
    expect(sources.map((s) => s.peer)).toEqual(["peer-a"]);
    expect(sources[0].device).toBe("Alvaro's Mac");
  });

  it("resolves each peer's own label, and iosPies orders the band by it", () => {
    const sources = sharedSourcesOf({ "peer-z": entries, "peer-a": entries }, [
      peer("peer-z", "Zed's Mac"),
      peer("peer-a", "Alvaro's Mac"),
    ]);
    expect(iosPies([], sources).map((p) => p.name)).toEqual([
      "Shared from Alvaro's Mac",
      "Shared from Zed's Mac",
    ]);
  });

  it("is empty when nothing has been fetched", () => {
    expect(sharedSourcesOf({}, [peer("peer-a", "Mac")])).toEqual([]);
  });
});
