// EntitlementProvider — one answer to "may this install comment?".
//
// The gate is deliberately ONE boolean read from ONE place. Scattering
// `if (subscribed)` through the rail, the sheet and the composer is how a
// paywall ends up with a hole in it, and how a paying customer ends up
// blocked by a stale copy of the flag.
//
// macOS is free by decision: the plugin answers `platform-free` there, so the
// desktop build takes the same code path and simply never sees a paywall.

import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { messageOf } from "../utils/error-message";

export type EntitlementReason =
  /** macOS: the desktop app is free. */
  | "platform-free"
  | "subscribed"
  | "trial"
  | "expired"
  /** Never subscribed — a first-run paywall, not a renewal one. */
  | "never"
  /** The store could not be reached. Access is granted; see below. */
  | "unknown"
  /** The Rust-to-Swift bridge broke — a build fault, not a network one.
   * Access is granted, but this one is somebody's bug to fix. */
  | "store-error";

export interface Entitlement {
  active: boolean;
  reason: EntitlementReason;
  expiresAt?: number;
  productId?: string;
}

export interface Product {
  id: string;
  title: string;
  description: string;
  /** Already localized by StoreKit. Never re-format it. */
  price: string;
  period: "monthly" | "annual" | "lifetime" | "unknown";
  trialDays?: number;
}

export interface EntitlementContextValue {
  entitlement: Entitlement;
  products: Product[];
  /** True while the first entitlement read is in flight. */
  loading: boolean;
  error: string | null;
  /** Whether the paid features are usable right now. */
  canComment: boolean;
  /** Whether a paywall can even be shown (there is something to sell). */
  sellable: boolean;
  buy(productId: string): Promise<boolean>;
  restore(): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * The starting value, and the value a non-Tauri environment keeps.
 *
 * `active: true`. A bug in the entitlement path must not lock the app's main
 * feature; the store is the authority and it will say no soon enough.
 */
const UNKNOWN: Entitlement = { active: true, reason: "unknown" };

const EntitlementContext = React.createContext<EntitlementContextValue>({
  entitlement: UNKNOWN,
  products: [],
  loading: false,
  error: null,
  canComment: true,
  sellable: false,
  async buy() {
    return false;
  },
  async restore() {},
  async refresh() {},
});

export function useEntitlement(): EntitlementContextValue {
  return React.useContext(EntitlementContext);
}

export function EntitlementProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [entitlement, setEntitlement] = React.useState<Entitlement>(UNKNOWN);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const read = React.useCallback(async (command: "entitlement" | "refresh" | "restore") => {
    try {
      const got = await invoke<Entitlement>(`plugin:skypie-iap|${command}`);
      setEntitlement(got);
      setError(null);
      return got;
    } catch (e: unknown) {
      // Never downgrade the entitlement on a failed read: the last known
      // answer is better evidence than an exception.
      setError(messageOf(e, "the store could not be reached"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void read("entitlement");
  }, [read]);

  // The offerings list is only needed to RENDER a paywall, so it is fetched
  // once. Its failure IS surfaced: the paywall still appears without it and
  // has to be able to say why it has nothing to sell.
  React.useEffect(() => {
    invoke<{ products: Product[] }>("plugin:skypie-iap|offerings")
      .then((o) => setProducts(o.products))
      .catch((e: unknown) => {
        // The Swift side writes these messages for a person to read — "The
        // store is unavailable on this build", "No products are configured
        // for this app yet". Swallowing them left an unentitled user tapping
        // Comment with no paywall, no error and no way to buy.
        console.error("skypie: failed to read the store offerings", e);
        setProducts([]);
        setError(messageOf(e, "the store could not be reached"));
      });
  }, []);

  // A subscription can lapse — or be bought in the App Store app — while this
  // one is asleep, so the entitlement is re-read on every foreground.
  React.useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void read("refresh");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [read]);

  const buy = React.useCallback(
    async (productId: string): Promise<boolean> => {
      try {
        const outcome = await invoke<{ cancelled: boolean; entitlement: Entitlement }>(
          "plugin:skypie-iap|purchase",
          { productId },
        );
        // Cancelling is not a failure and must not raise an error banner:
        // changing your mind at a paywall is the normal thing to do.
        //
        // It also carries NO information about the entitlement. RevenueCat
        // returns no customer info when a purchase does not complete, so the
        // payload's entitlement is a placeholder — believing it logged a live
        // subscriber out of the feature they had already paid for.
        if (!outcome.cancelled) setEntitlement(outcome.entitlement);
        setError(null);
        return !outcome.cancelled && outcome.entitlement.active;
      } catch (e: unknown) {
        setError(messageOf(e, "the store could not be reached"));
        return false;
      }
    },
    [],
  );

  const restore = React.useCallback(async () => {
    await read("restore");
  }, [read]);

  const refresh = React.useCallback(async () => {
    await read("refresh");
  }, [read]);

  const value = React.useMemo(
    () => ({
      entitlement,
      products,
      loading,
      error,
      canComment: entitlement.active,
      sellable: products.length > 0,
      buy,
      restore,
      refresh,
    }),
    [entitlement, products, loading, error, buy, restore, refresh],
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

/** The headline a paywall shows, given why it appeared. */
export function paywallTitle(reason: EntitlementReason): string {
  switch (reason) {
    case "expired":
      return "Your subscription has ended";
    case "trial":
      return "Your trial is running";
    default:
      return "Comment on your artifacts";
  }
}

/** "7 days free, then 1,99 €/month" — the line under a product. */
export function priceLine(product: Product): string {
  const per =
    product.period === "monthly"
      ? "/month"
      : product.period === "annual"
        ? "/year"
        : "";
  if (product.trialDays && product.trialDays > 0) {
    return `${product.trialDays} days free, then ${product.price}${per}`;
  }
  return `${product.price}${per}`;
}

/** "Renews 13 Sep 2026", or null when the store gave no date. */
export function renewalLine(entitlement: Entitlement): string | null {
  if (!entitlement.expiresAt) return null;
  const at = new Date(entitlement.expiresAt * 1000);
  if (Number.isNaN(at.getTime())) return null;
  const when = at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (entitlement.reason === "expired") return `Ended ${when}`;
  if (entitlement.reason === "trial") return `Trial ends ${when}`;
  return `Renews ${when}`;
}
