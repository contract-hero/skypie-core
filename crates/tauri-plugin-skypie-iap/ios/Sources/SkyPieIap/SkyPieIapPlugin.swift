// The Swift half of the IAP plugin: the only place StoreKit or a receipt is
// ever touched.
//
// Everything the webview can ask for is a question about ENTITLEMENT, never
// about a transaction. The webview cannot read a receipt, cannot see a
// transaction id, and cannot be talked into believing it is entitled by
// anything it renders — the answer always comes from the SDK.
//
// ── Configuration ──────────────────────────────────────────────────────────
//
// The RevenueCat public SDK key is read from the app bundle's Info.plist
// under `RevenueCatAPIKey`, injected at build time from the environment. It
// is NOT hardcoded here: a key in the source is a key in every fork of the
// repository, and rotating it would mean shipping a new binary.
//
// A missing key is not a crash. The app opens, reading works, and the paywall
// says the store is unavailable — losing the whole app to a build-config
// mistake would be a far worse outcome than losing the purchase screen.

import Foundation
import RevenueCat
import Tauri
import UIKit
import WebKit  // `load(webview:)` takes a `WKWebView`.

/// Must match `ENTITLEMENT_ID` in the Rust half.
private let entitlementID = "comments"

/// How the paywall labels a product. `Package`'s own type is richer than the
/// UI needs; this is the part a person reads.
private func periodName(_ product: StoreProduct) -> String {
  guard let period = product.subscriptionPeriod else { return "lifetime" }
  switch (period.unit, period.value) {
  case (.month, 1): return "monthly"
  case (.year, 1): return "annual"
  default: return "unknown"
  }
}

/// Free-trial length in days, when the product has an introductory offer that
/// is actually free. A discounted intro price is not a trial and must not be
/// advertised as one.
private func trialDays(_ product: StoreProduct) -> Int? {
  guard let intro = product.introductoryDiscount, intro.price == 0 else { return nil }
  switch intro.subscriptionPeriod.unit {
  case .day: return intro.subscriptionPeriod.value
  case .week: return intro.subscriptionPeriod.value * 7
  case .month: return intro.subscriptionPeriod.value * 30
  case .year: return intro.subscriptionPeriod.value * 365
  @unknown default: return nil
  }
}

private struct EntitlementPayload: Encodable {
  let active: Bool
  let reason: String
  let expiresAt: UInt64?
  let productId: String?
}

private struct ProductPayload: Encodable {
  let id: String
  let title: String
  let description: String
  let price: String
  let period: String
  let trialDays: Int?
}

private struct OfferingsPayload: Encodable {
  let products: [ProductPayload]
}

private struct PurchaseOutcomePayload: Encodable {
  let cancelled: Bool
  let entitlement: EntitlementPayload
}

private struct PurchaseArgs: Decodable {
  let productId: String
}

/// Read one `CustomerInfo` into the shape the app uses.
///
/// The four reasons are distinct on purpose. "Never subscribed" gets a
/// paywall, "expired" gets a renew screen, "trial" gets a countdown, and
/// "subscribed" gets nothing at all — one boolean could not tell them apart.
private func entitlementOf(_ info: CustomerInfo) -> EntitlementPayload {
  guard let e = info.entitlements[entitlementID] else {
    let everLapsed = info.entitlements.all[entitlementID] != nil
    return EntitlementPayload(
      active: false,
      reason: everLapsed ? "expired" : "never",
      expiresAt: nil,
      productId: nil
    )
  }
  let expires = e.expirationDate.map { UInt64(max(0, $0.timeIntervalSince1970)) }
  if !e.isActive {
    return EntitlementPayload(
      active: false, reason: "expired", expiresAt: expires, productId: e.productIdentifier)
  }
  // `periodType == .trial` is what makes the countdown honest: a user in a
  // free trial has not paid yet, and telling them otherwise is how a
  // surprise charge becomes a refund request.
  let reason = e.periodType == .trial ? "trial" : "subscribed"
  return EntitlementPayload(
    active: true, reason: reason, expiresAt: expires, productId: e.productIdentifier)
}

/// What to report when the store cannot be reached. Mirrors
/// `Entitlement::unknown` in the Rust half — `active` stays true so a
/// subscriber on a plane keeps the feature.
private func unknownEntitlement() -> EntitlementPayload {
  EntitlementPayload(active: true, reason: "unknown", expiresAt: nil, productId: nil)
}

class SkyPieIapPlugin: Plugin {
  /// False when no API key was configured. Every call then answers
  /// "unknown" instead of talking to an unconfigured SDK.
  private var configured = false

  override func load(webview: WKWebView) {
    guard
      let key = Bundle.main.object(forInfoDictionaryKey: "RevenueCatAPIKey") as? String,
      !key.isEmpty,
      !key.hasPrefix("$(")  // an uninterpolated build setting
    else {
      NSLog("skypie-iap: no RevenueCatAPIKey in Info.plist; purchases are unavailable")
      return
    }
    // `appUserID: nil` keeps RevenueCat's anonymous id. Sky Pie has no
    // accounts — identity here is the device's iroh node — so there is no
    // stable user id to hand over, and inventing one from a device
    // identifier would tie a purchase to hardware the user may replace.
    Purchases.configure(with: Configuration.Builder(withAPIKey: key).build())
    configured = true
  }

  /// Answer one entitlement question. An unconfigured build and an
  /// unreachable store answer the same way — see `unknownEntitlement`.
  private func resolveEntitlement(_ invoke: Invoke) {
    guard configured else {
      invoke.resolve(unknownEntitlement())
      return
    }
    Purchases.shared.getCustomerInfo { info, error in
      if let error = error {
        // Access still stays on — see `unknownEntitlement`. But the CAUSE
        // must not be thrown away: `configured` only proves a key string
        // exists, so a present-but-WRONG key passes `load()` and then fails
        // every call here. Every install would answer "unknown" -> active,
        // giving the paid feature away to everyone, and the only place that
        // would show up is the revenue graph.
        NSLog("skypie-iap: getCustomerInfo failed: \(error.localizedDescription)")
      }
      invoke.resolve(info.map(entitlementOf) ?? unknownEntitlement())
    }
  }

  @objc public func entitlement(_ invoke: Invoke) {
    resolveEntitlement(invoke)
  }

  /// Force a fresh read. Called on foreground: a subscription can lapse — or
  /// be bought in the App Store app — while this app is asleep.
  @objc public func refresh(_ invoke: Invoke) {
    // Only meaningful once configured; harmless before, and the shared
    // resolver still answers "unknown" in that case.
    if configured {
      Purchases.shared.invalidateCustomerInfoCache()
    }
    resolveEntitlement(invoke)
  }

  @objc public func offerings(_ invoke: Invoke) {
    guard configured else {
      invoke.reject("The store is unavailable on this build.")
      return
    }
    Purchases.shared.getOfferings { offerings, error in
      if let error = error {
        invoke.reject(error.localizedDescription)
        return
      }
      guard let current = offerings?.current else {
        // A configured project with no current offering is a dashboard
        // mistake, and it must read as one rather than as an empty paywall.
        invoke.reject("No products are configured for this app yet.")
        return
      }
      let products = current.availablePackages.map { pkg -> ProductPayload in
        let p = pkg.storeProduct
        return ProductPayload(
          id: p.productIdentifier,
          title: p.localizedTitle,
          description: p.localizedDescription,
          // StoreKit's own localized string. Never formatted here: a price
          // the app formats itself is a rejected submission.
          price: p.localizedPriceString,
          period: periodName(p),
          trialDays: trialDays(p)
        )
      }
      invoke.resolve(OfferingsPayload(products: products))
    }
  }

  @objc public func purchase(_ invoke: Invoke) {
    guard configured else {
      invoke.reject("The store is unavailable on this build.")
      return
    }
    let args: PurchaseArgs
    do {
      args = try invoke.parseArgs(PurchaseArgs.self)
    } catch {
      invoke.reject("purchase needs a productId")
      return
    }
    Purchases.shared.getOfferings { offerings, error in
      if let error = error {
        invoke.reject(error.localizedDescription)
        return
      }
      guard
        let pkg = offerings?.current?.availablePackages.first(where: {
          $0.storeProduct.productIdentifier == args.productId
        })
      else {
        invoke.reject("That product is not for sale.")
        return
      }
      Purchases.shared.purchase(package: pkg) { _, info, error, userCancelled in
        if userCancelled {
          // Not an error. Changing your mind at a paywall is the most common
          // thing that happens at a paywall.
          //
          // And NOT evidence of anything: RevenueCat returns no customer info
          // when the purchase does not complete, so there is nothing here to
          // report. Fabricating "never subscribed" for that case told the
          // host a paying subscriber had no entitlement, and the host
          // believed it. `unknownEntitlement()` says what is true — we do not
          // know — and the host ignores it for a cancellation anyway.
          invoke.resolve(
            PurchaseOutcomePayload(
              cancelled: true,
              entitlement: info.map(entitlementOf) ?? unknownEntitlement()
            ))
          return
        }
        if let error = error {
          invoke.reject(error.localizedDescription)
          return
        }
        invoke.resolve(
          PurchaseOutcomePayload(
            cancelled: false,
            entitlement: info.map(entitlementOf) ?? unknownEntitlement()
          ))
      }
    }
  }

  /// Required by App Store guideline 3.1.1: an app selling a subscription
  /// must offer a visible way to restore it on a new device.
  @objc public func restore(_ invoke: Invoke) {
    guard configured else {
      // REJECT, like `offerings` and `purchase` do in this state. Resolving
      // with an active entitlement made the host clear its error banner, so
      // the user tapped "Restore purchases", watched the error vanish, and
      // concluded their subscription was back. Nothing had been restored.
      invoke.reject("The store is unavailable on this build.")
      return
    }
    Purchases.shared.restorePurchases { info, error in
      if let error = error {
        invoke.reject(error.localizedDescription)
        return
      }
      invoke.resolve(info.map(entitlementOf) ?? unknownEntitlement())
    }
  }
}

@_cdecl("init_plugin_skypie_iap")
func initPlugin() -> Plugin {
  return SkyPieIapPlugin()
}
