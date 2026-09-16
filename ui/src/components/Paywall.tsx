// Paywall — the one screen that asks for money.
//
// It is shown only where the free app stops: the user has read the artifact,
// selected a passage, and tried to say something about it. That is the moment
// the value is obvious, and it is the only moment this screen appears. It is
// never a launch screen and never a nag.
//
// It also carries "Restore purchases", which App Store guideline 3.1.1
// requires any app selling a subscription to offer — a submission without one
// is rejected.

import * as React from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import {
  paywallTitle,
  priceLine,
  renewalLine,
  useEntitlement,
} from "../state/entitlement";
import type { Product } from "../state/entitlement";

/** Annual first, then monthly, then lifetime — cheapest per day at the top. */
export function orderProducts(products: Product[]): Product[] {
  const rank: Record<string, number> = { annual: 0, monthly: 1, lifetime: 2, unknown: 3 };
  return [...products].sort((a, b) => (rank[a.period] ?? 3) - (rank[b.period] ?? 3));
}

export default function Paywall({ onClose }: { onClose: () => void }): React.ReactElement {
  const { entitlement, products, error, buy, restore } = useEntitlement();
  const [busy, setBusy] = React.useState<string | null>(null);
  const ordered = React.useMemo(() => orderProducts(products), [products]);

  const purchase = async (id: string): Promise<void> => {
    setBusy(id);
    const ok = await buy(id);
    setBusy(null);
    // Only close on success. A cancelled purchase leaves the screen up, which
    // is what a person who mis-tapped expects.
    if (ok) onClose();
  };

  const renewal = renewalLine(entitlement);

  return (
    <div className="paywall" role="dialog" aria-label="Subscribe to comments">
      <div className="paywall-head">
        <MessageSquare size={22} strokeWidth={1.6} aria-hidden />
        <h2 className="paywall-title">{paywallTitle(entitlement.reason)}</h2>
        <p className="paywall-sub">
          Leave feedback on a line, a paragraph or a spot on an image — and send it
          straight back to the agent that wrote it.
        </p>
        {renewal ? <p className="paywall-renewal">{renewal}</p> : null}
      </div>

      {error ? <p className="paywall-error">{error}</p> : null}

      {ordered.length === 0 ? (
        <p className="paywall-error">
          The store is not reachable right now. Try again in a moment.
        </p>
      ) : (
        <ul className="paywall-products">
          {ordered.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="paywall-product"
                disabled={busy !== null}
                onClick={() => void purchase(p.id)}
              >
                <span className="paywall-product-title">{p.title}</span>
                <span className="paywall-product-price">{priceLine(p)}</span>
                {busy === p.id ? <span className="paywall-busy">…</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="paywall-actions">
        <button type="button" className="comment-action" onClick={() => void restore()}>
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden />
          Restore purchases
        </button>
        <button type="button" className="comment-action" onClick={onClose}>
          Not now
        </button>
      </div>

      <p className="paywall-fine">
        Reading stays free, always. Payment is charged to your Apple Account and renews
        unless cancelled at least 24 hours before the period ends. Manage it in Settings
        on your device.
      </p>
    </div>
  );
}
