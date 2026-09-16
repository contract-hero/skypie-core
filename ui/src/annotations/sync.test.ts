import { describe, expect, it } from "vitest";
import { BASE_SYNC_MS, MAX_SYNC_MS, nextSyncDelayMs } from "./sync";

describe("nextSyncDelayMs", () => {
  it("polls at the base rate while the host answers", () => {
    expect(nextSyncDelayMs(0)).toBe(BASE_SYNC_MS);
  });

  it("doubles per failure up to the ceiling", () => {
    expect(nextSyncDelayMs(1)).toBe(20_000);
    expect(nextSyncDelayMs(2)).toBe(40_000);
    expect(nextSyncDelayMs(3)).toBe(80_000);
    expect(nextSyncDelayMs(4)).toBe(MAX_SYNC_MS);
    // Past 1024 the power alone is Infinity; the ceiling keeps it finite.
    expect(nextSyncDelayMs(2000)).toBe(MAX_SYNC_MS);
  });
});
