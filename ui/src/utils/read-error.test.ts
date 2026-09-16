import { describe, expect, it } from "vitest";
import { readErrorTitle } from "./read-error";

// The strings below are the real `thiserror` Display output from
// src-tauri/src/reader.rs and crates/skypie-remote/src/security.rs, not invented text.
describe("readErrorTitle", () => {
  it("names the common failures", () => {
    expect(readErrorTitle("Io", 'not found: "/w/report.html"')).toBe("File not found");
    expect(
      readErrorTitle("Io", 'io error at "/w/report.html": Permission denied (os error 13)'),
    ).toBe("Permission denied");
    expect(readErrorTitle("Io", 'path is out of root: "/etc/passwd"')).toBe(
      "Outside the workspace",
    );
  });

  it("classifies on the failure, never on the path text", () => {
    // A quoted path can contain any word we match on. `NotFound.tsx` is a
    // very common filename; reporting it as missing while it sits on disk
    // would be worse than the generic fallback.
    expect(
      readErrorTitle(
        "Io",
        'io error at "/repo/src/pages/NotFound.tsx": Permission denied (os error 13)',
      ),
    ).toBe("Permission denied");
    expect(readErrorTitle("Io", 'not found: "/repo/permission-denied/a.md"')).toBe(
      "File not found",
    );
  });

  it("prefers the more specific classification when both could match", () => {
    // "out of root" must win over the "denied" substring.
    expect(readErrorTitle("Io", 'path is out of root: "/denied/x.md"')).toBe(
      "Outside the workspace",
    );
  });

  it("falls back rather than guessing", () => {
    expect(readErrorTitle("Io", "")).toBe("Could not read this file");
    expect(readErrorTitle("Io", "some unmapped backend failure")).toBe(
      "Could not read this file",
    );
  });

  it("classifies a pulled file by the typed cause, never by the sentence", () => {
    expect(readErrorTitle("remote-unpaired", "not a paired peer")).toBe("Not a paired device");
    expect(readErrorTitle("remote-local", "not a paired device")).toBe("Not a paired device");
    expect(readErrorTitle("remote-unreachable", "peer offline")).toBe("Device unreachable");
    expect(readErrorTitle("remote-unknown", "")).toBe("Device unreachable");
    // A host that ANSWERED is not asleep: refusing the session or the file
    // must not send the reader to wake it.
    expect(readErrorTitle("remote-refused", "session cap")).toBe("The device refused this file");
    expect(readErrorTitle("remote-denied", "path not found or out of root")).toBe(
      "The device refused this file",
    );
    // The words alone never decide it.
    expect(readErrorTitle("remote-unreachable", "not a paired peer")).toBe("Device unreachable");
  });
});
