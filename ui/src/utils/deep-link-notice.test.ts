import { describe, expect, it } from "vitest";
import { deepLinkNotice } from "./deep-link-notice";

describe("deepLinkNotice — what a rejected link tells the reader", () => {
  it("points an unpaired device's link at the Devices pane", () => {
    const text = deepLinkNotice({
      reason: "not paired with the device this link comes from (cccccccccc)",
      url: "skypie://open?path=%2Fw%2Fa.html&from=ccc",
      unpaired_from: "cccccccccc",
    });
    expect(text).toBe(
      "This link comes from a device you haven't paired (cccccccccc…). " +
        "Pair it in Settings → Devices, then open the link again.",
    );
  });

  it("keeps the backend's own reason for everything else", () => {
    expect(deepLinkNotice({ reason: "malformed url", url: "skypie://open" })).toBe(
      "Deep link rejected: malformed url (skypie://open)",
    );
  });
});
