import { describe, expect, it } from "vitest";
import { paywallTitle, priceLine, renewalLine } from "./entitlement";
import type { Entitlement, Product } from "./entitlement";
import { orderProducts } from "../components/Paywall";

const annual: Product = {
  id: "skypie.comments.annual",
  title: "Comments, yearly",
  description: "",
  price: "12,99 €",
  period: "annual",
  trialDays: 7,
};
const monthly: Product = {
  id: "skypie.comments.monthly",
  title: "Comments, monthly",
  description: "",
  price: "1,99 €",
  period: "monthly",
};
const lifetime: Product = {
  id: "skypie.comments.lifetime",
  title: "Comments, forever",
  description: "",
  price: "29,99 €",
  period: "lifetime",
};

describe("priceLine", () => {
  it("leads with the free trial when the product has one", () => {
    expect(priceLine(annual)).toBe("7 days free, then 12,99 €/year");
  });

  it("names the period for a subscription without a trial", () => {
    expect(priceLine(monthly)).toBe("1,99 €/month");
  });

  it("adds no period to a one-time purchase", () => {
    expect(priceLine(lifetime)).toBe("29,99 €");
  });

  it("never re-formats the store's own price string", () => {
    // A price the app formats itself is a rejected App Store submission:
    // currency, separator and placement are the store's to decide.
    expect(priceLine({ ...monthly, price: "US$1.99" })).toContain("US$1.99");
    expect(priceLine({ ...monthly, price: "￥300" })).toContain("￥300");
  });

  it("treats a zero-day trial as no trial", () => {
    expect(priceLine({ ...annual, trialDays: 0 })).toBe("12,99 €/year");
  });
});

describe("orderProducts", () => {
  it("puts the cheapest per day first", () => {
    const got = orderProducts([lifetime, monthly, annual]);
    expect(got.map((p) => p.period)).toEqual(["annual", "monthly", "lifetime"]);
  });

  it("does not mutate the input", () => {
    const input = [lifetime, annual];
    orderProducts(input);
    expect(input[0]).toBe(lifetime);
  });

  it("keeps an unrecognised period last rather than dropping it", () => {
    const odd: Product = { ...monthly, id: "x", period: "unknown" };
    expect(orderProducts([odd, monthly]).map((p) => p.id)).toEqual([monthly.id, "x"]);
  });
});

describe("paywallTitle", () => {
  it("distinguishes a lapsed subscription from a first look", () => {
    expect(paywallTitle("expired")).toBe("Your subscription has ended");
    expect(paywallTitle("never")).toBe("Comment on your artifacts");
  });

  it("has a title for every reason, including the store being unreachable", () => {
    for (const reason of ["platform-free", "subscribed", "trial", "unknown"] as const) {
      expect(paywallTitle(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("renewalLine", () => {
  const withDate = (reason: Entitlement["reason"]): Entitlement => ({
    active: true,
    reason,
    expiresAt: 1_789_296_131,
  });

  it("says renews for a live subscription", () => {
    expect(renewalLine(withDate("subscribed"))).toMatch(/^Renews /);
  });

  it("says the trial ends rather than renews", () => {
    // A user in a free trial has not paid yet; telling them otherwise is how
    // a surprise charge becomes a refund request.
    expect(renewalLine(withDate("trial"))).toMatch(/^Trial ends /);
  });

  it("says ended for a lapsed one", () => {
    expect(renewalLine(withDate("expired"))).toMatch(/^Ended /);
  });

  it("says nothing when the store gave no date", () => {
    expect(renewalLine({ active: true, reason: "platform-free" })).toBeNull();
    expect(renewalLine({ active: true, reason: "unknown", expiresAt: Number.NaN })).toBeNull();
  });
});
