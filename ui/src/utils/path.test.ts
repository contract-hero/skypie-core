import { describe, expect, it } from "vitest";
import { basename, dirname, displayDir, displayPath, isUnderRoot, normalizePathBarInput } from "./path";

describe("basename / dirname", () => {
  it("splits regular paths", () => {
    expect(basename("/a/b/c.html")).toBe("c.html");
    expect(dirname("/a/b/c.html")).toBe("/a/b");
  });
  it("handles root-level paths", () => {
    expect(basename("/file")).toBe("file");
    expect(dirname("/file")).toBe("/");
  });
  // The phone title band leans on this: the strip is greedy, so a
  // `skypie-remote://` address yields the filename as seen on the HOST
  // without anyone having to parse the scheme first.
  it("yields the host-side filename of a remote address", () => {
    expect(basename("skypie-remote://abc123/home/v/report.html")).toBe("report.html");
    expect(basename("skypie-remote://nopath")).toBe("nopath");
  });
});

describe("isUnderRoot", () => {
  it("matches the root itself and children, not prefix-sibling dirs", () => {
    expect(isUnderRoot("/foo/bar", "/foo/bar")).toBe(true);
    expect(isUnderRoot("/foo/bar/x.md", "/foo/bar")).toBe(true);
    expect(isUnderRoot("/foo/barn/x.md", "/foo/bar")).toBe(false);
    expect(isUnderRoot("/anything", null)).toBe(false);
  });
});

describe("normalizePathBarInput", () => {
  it("passes raw absolute paths through literally (no decoding)", () => {
    expect(normalizePathBarInput("/tmp/a.html")).toEqual({ kind: "ok", path: "/tmp/a.html" });
    // Real files can contain % — pasting from Finder/pwd must not decode.
    expect(normalizePathBarInput("/tmp/100%.md")).toEqual({ kind: "ok", path: "/tmp/100%.md" });
    expect(normalizePathBarInput("/tmp/a%20b.md")).toEqual({ kind: "ok", path: "/tmp/a%20b.md" });
  });

  it("decodes file:// URLs exactly once", () => {
    expect(normalizePathBarInput("file:///tmp/a%20b.html")).toEqual({
      kind: "ok",
      path: "/tmp/a b.html",
    });
  });

  it("decodes the skypie:// path param exactly once", () => {
    expect(normalizePathBarInput("skypie://open?path=%2Ftmp%2Fa%20b.md")).toEqual({
      kind: "ok",
      path: "/tmp/a b.md",
    });
    // Double-encoded input stays single-encoded after one decode — matching
    // dispatch_deep_link, a file literally named "a%20b.md" is addressable.
    expect(normalizePathBarInput("skypie://open?path=%2Ftmp%2Fa%2520b.md")).toEqual({
      kind: "ok",
      path: "/tmp/a%20b.md",
    });
  });

  it("does not form-decode + to a space (Rust parser parity)", () => {
    expect(normalizePathBarInput("skypie://open?path=/tmp/a+b.md")).toEqual({
      kind: "ok",
      path: "/tmp/a+b.md",
    });
  });

  it("ignores other params and accepts reveal", () => {
    expect(normalizePathBarInput("skypie://open?path=/tmp/x.md&line=42")).toEqual({
      kind: "ok",
      path: "/tmp/x.md",
    });
    expect(normalizePathBarInput("skypie://reveal?path=/tmp/x.md")).toEqual({
      kind: "ok",
      path: "/tmp/x.md",
    });
  });

  it("rejects malformed inputs", () => {
    expect(normalizePathBarInput("").kind).toBe("error");
    expect(normalizePathBarInput("   ").kind).toBe("error");
    expect(normalizePathBarInput("relative/path.md").kind).toBe("error");
    expect(normalizePathBarInput("skypie://open").kind).toBe("error");
    expect(normalizePathBarInput("skypie://open?foo=1").kind).toBe("error");
    expect(normalizePathBarInput("skypie://open?path=%ZZ").kind).toBe("error");
    expect(normalizePathBarInput("skypie://open?path=/tmp/a%00b").kind).toBe("error");
  });
});

describe("displayDir", () => {
  it("shows a path relative to the workspace root", () => {
    expect(displayDir("/w/skypie/src/components/a.tsx", "/w/skypie")).toBe("src/components");
  });

  it("shows nothing for a file sitting at the root", () => {
    expect(displayDir("/w/skypie/README.md", "/w/skypie")).toBe("");
  });

  it("never fakes a relative path for a prefix sibling", () => {
    // `/w/skypie-worktrees/x` is NOT inside `/w/skypie`. Without the trailing
    // slash in the prefix test this returns "worktrees/x", a path that does
    // not exist. Git worktrees produce exactly this layout.
    expect(displayDir("/w/skypie-worktrees/x/a.md", "/w/skypie")).toBe("/w/skypie-worktrees/x");
  });

  it("falls back to the absolute directory outside the root or with no root", () => {
    expect(displayDir("/tmp/a.md", "/w/skypie")).toBe("/tmp");
    expect(displayDir("/w/skypie/src/a.md", null)).toBe("/w/skypie/src");
  });
});

describe("displayPath", () => {
  it("shows a workspace file relative to the root", () => {
    expect(displayPath("/w/skypie/src/a.md", "/w/skypie")).toBe("src/a.md");
  });

  it("keeps absolute form outside the root, with no root, or for the root itself", () => {
    expect(displayPath("/tmp/a.md", "/w/skypie")).toBe("/tmp/a.md");
    expect(displayPath("/w/skypie/src/a.md", null)).toBe("/w/skypie/src/a.md");
    expect(displayPath("/w/skypie", "/w/skypie")).toBe("/w/skypie");
  });

  it("never relativizes a prefix sibling (worktree layout)", () => {
    expect(displayPath("/w/skypie-worktrees/x/a.md", "/w/skypie")).toBe("/w/skypie-worktrees/x/a.md");
  });

  it("tolerates a root that already ends in a slash", () => {
    expect(displayPath("/w/skypie/src/a.md", "/w/skypie/")).toBe("src/a.md");
  });

  it("relativizes against the filesystem root", () => {
    expect(displayPath("/Users/x/a.md", "/")).toBe("Users/x/a.md");
  });
});
