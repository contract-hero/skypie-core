import { describe, expect, it } from "vitest";
import { expiresIn, formatAgo, formatLastSeen, humanBytes, mtimeAgo } from "./beam-format";

describe("humanBytes", () => {
  it("scales through the units", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(482_133)).toBe("471 KB");
    expect(humanBytes(1_300_000)).toBe("1.2 MB");
    expect(humanBytes(250 * 1024 * 1024)).toBe("250 MB");
  });

  it("rejects garbage", () => {
    expect(humanBytes(-1)).toBe("?");
    expect(humanBytes(Number.NaN)).toBe("?");
  });
});

describe("expiresIn", () => {
  const now = 1_000_000;
  it("coarsens by magnitude", () => {
    expect(expiresIn(now + 23 * 3600, now)).toBe("23 h");
    expect(expiresIn(now + 45 * 60, now)).toBe("45 min");
    expect(expiresIn(now + 30, now)).toBe("<1 min");
    expect(expiresIn(now, now)).toBe("expired");
    expect(expiresIn(now - 5, now)).toBe("expired");
  });
});

describe("formatLastSeen", () => {
  const now = 1_800_000_000;
  it("reads as a status caption for a device row", () => {
    expect(formatLastSeen(0, now)).toBe("Never connected");
    expect(formatLastSeen(now - 5, now)).toBe("Last seen just now");
    expect(formatLastSeen(now - 5 * 60, now)).toBe("Last seen 5 min ago");
    expect(formatLastSeen(now - 3 * 3600, now)).toBe("Last seen 3 h ago");
    expect(formatLastSeen(now - 2 * 86400, now)).toBe("Last seen 2 d ago");
  });
  it("never counts a clock skew as the future", () => {
    expect(formatLastSeen(now + 60, now)).toBe("Last seen just now");
  });
});

describe("formatAgo", () => {
  const now = 1_700_000_000;
  it("carries no prefix, so a filename keeps the row", () => {
    expect(formatAgo(now - 10, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60, now)).toBe("5 min");
    expect(formatAgo(now - 3 * 3600, now)).toBe("3 h");
    expect(formatAgo(now - 2 * 86400, now)).toBe("2 d");
  });
  it("never reads as negative when the host clock is ahead", () => {
    expect(formatAgo(now + 500, now)).toBe("just now");
  });
});

// `mtimeAgo` was the same six lines in PiePlate.tsx (the desktop plate) and
// ios-pies.ts (the phone sheet), each with its own test. One function beside
// `formatAgo`, whose "just now" contract is the only reason it exists, and
// one test file.
describe("mtimeAgo", () => {
  const now = 1_700_000_100;

  it("says 'just now' without appending ' ago'", () => {
    expect(mtimeAgo(1_700_000_100_000, now)).toBe("just now");
    expect(mtimeAgo(1_700_000_070_000, now)).toBe("just now");
  });

  it("appends ' ago' once the age reaches a minute", () => {
    // Exactly 60s old — formatAgo's own >= 60 branch.
    expect(mtimeAgo(1_700_000_040_000, now)).toBe("1 min ago");
  });

  it("appends ' ago' to every longer phrase too", () => {
    expect(mtimeAgo(1_700_000_100_000 - 5 * 60_000, now)).toBe("5 min ago");
    expect(mtimeAgo(1_700_000_000_000, 1_700_010_000)).toBe("3 h ago");
    expect(mtimeAgo(1_700_000_100_000 - 2 * 86_400_000, now)).toBe("2 d ago");
  });

  it("defaults to the real clock, so a render site passes no second argument", () => {
    expect(mtimeAgo(Date.now())).toBe("just now");
    expect(mtimeAgo(Date.now() - 3 * 3_600_000)).toBe("3 h ago");
  });
});
