// In-app purchase for the Sky Pie iOS companion.
//
// ── Why this crate exists ──────────────────────────────────────────────────
//
// RevenueCat has no Tauri SDK and has said on its community forum that one is
// not planned. Three paths were open: a community Tauri plugin over a
// community Rust reimplementation, a StoreKit 2 plugin plus RevenueCat's REST
// API, or about two hundred lines of Swift over the OFFICIAL `purchases-ios`.
//
// This is the third. It is the only one where "the purchase is powered by the
// RevenueCat SDK" is unarguable, and it depends on the SDK Apple's own review
// process sees every day rather than on a single-maintainer bridge.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// Rust owns the surface and the platform split; Swift owns the SDK calls. The
// webview never talks to StoreKit and never sees a receipt: it asks for an
// `Entitlement` and gets a boolean plus a reason.
//
// On macOS there is no purchase at all. The desktop app, the MCP server and
// the plugin are free by decision, so `entitlement()` there is a constant
// `true` with the reason `platform-free`. That is not a stub to be filled in
// later — it is the business model, and writing it as a fake purchase flow
// would invite someone to "finish" it.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

// The entitlement identifier — "comments" — is declared ONCE, in
// `ios/Sources/SkyPieIap/SkyPieIapPlugin.swift`, because Swift is the only side
// that ever compares it against what RevenueCat returns. A matching Rust
// constant was carried here briefly and never read; two declarations of one
// identifier that no compiler can keep in step is the failure mode this note
// exists to prevent. It must match the identifier in the RevenueCat
// dashboard, or every paying customer reads as "never subscribed".

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Plugin(String),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Whether this install may use the paid features, and why.
///
/// `reason` is carried so the UI never has to guess why a paywall appeared.
/// "The trial ran out" and "we could not reach the store" call for completely
/// different screens, and a single boolean cannot tell them apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub active: bool,
    /// `platform-free` | `subscribed` | `trial` | `expired` | `never` |
    /// `unknown` (store unreachable) | `store-error` (the bridge broke).
    pub reason: String,
    /// Unix seconds when the current period ends, when the store said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// The product the user is on, for the "manage subscription" row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
}

impl Entitlement {
    /// macOS: free by decision, not by omission. See the module header.
    pub fn platform_free() -> Self {
        Self {
            active: true,
            reason: "platform-free".into(),
            expires_at: None,
            product_id: None,
        }
    }

    /// What to report when the store cannot be reached.
    ///
    /// `active` stays TRUE. A subscriber on a plane must not lose the feature
    /// because the network is down, and the downside is bounded: the worst
    /// case is a non-subscriber using comments offline until the app can ask
    /// again. Losing a paying customer's access is the far worse failure, and
    /// the reason string keeps the state honest for the UI.
    pub fn unknown() -> Self {
        Self {
            active: true,
            reason: "unknown".into(),
            expires_at: None,
            product_id: None,
        }
    }

    /// The bridge itself broke — a renamed Swift method, a payload this build
    /// cannot deserialize.
    ///
    /// Separate from `unknown` because the "subscriber on a plane" argument
    /// does NOT cover it. That argument is about a store this device cannot
    /// reach right now; this is a build-integration fault that would be
    /// permanent for everyone who installed it, and folding the two together
    /// would hand the paid feature to every user with nothing anywhere saying
    /// so. Access still stays on — a broken bridge is not the user's fault —
    /// but the reason makes it visible instead of indistinguishable.
    pub fn unreadable() -> Self {
        Self {
            active: true,
            reason: "store-error".into(),
            expires_at: None,
            product_id: None,
        }
    }
}

/// One purchasable product, as the paywall renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub title: String,
    pub description: String,
    /// Already localized by StoreKit — never format a price in the app.
    /// A price the app formatted itself is a rejected App Store submission.
    pub price: String,
    /// `monthly` | `annual` | `lifetime` | `unknown`.
    pub period: String,
    /// Free-trial length in days, when the product offers one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial_days: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offerings {
    pub products: Vec<Product>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseArgs {
    pub product_id: String,
}

/// The outcome of one purchase attempt.
///
/// A user cancelling is NOT an error: it is the most common outcome of
/// showing a paywall, and surfacing it as a failure would put a red toast in
/// front of somebody who simply changed their mind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOutcome {
    pub cancelled: bool,
    pub entitlement: Entitlement,
}

// ────────────────────────────────────────────────────────────────────────────
// The platform split
// ────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_skypie_iap);

/// The handle the commands go through. On desktop it holds nothing: every
/// answer is a constant.
pub struct Iap<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R`, not a bare `R`: Tauri's `Runtime` is not itself `Send +
    // Sync`, and `Manager::manage` requires both. The function-pointer form
    // is unconditionally `Send + Sync` and still pins the parameter.
    #[cfg(not(mobile))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Iap<R> {
    pub fn entitlement(&self) -> Result<Entitlement> {
        #[cfg(mobile)]
        {
            Ok(self
                .handle
                .run_mobile_plugin::<Entitlement>("entitlement", ())
                // A bridge failure is NOT an unreachable store: the Swift
                // side answers "unknown" itself for that. Reaching here means
                // the call or its payload broke, which `unreadable` names so
                // a misconfigured build is not silently free for everyone.
                .unwrap_or_else(|e| {
                    eprintln!("skypie-iap: entitlement bridge failed: {e}");
                    Entitlement::unreadable()
                }))
        }
        #[cfg(not(mobile))]
        {
            Ok(Entitlement::platform_free())
        }
    }

    pub fn offerings(&self) -> Result<Offerings> {
        #[cfg(mobile)]
        {
            Ok(self.handle.run_mobile_plugin::<Offerings>("offerings", ())?)
        }
        #[cfg(not(mobile))]
        {
            // Nothing is for sale on macOS, so the paywall has nothing to
            // render and never mounts.
            Ok(Offerings { products: Vec::new() })
        }
    }

    pub fn purchase(&self, product_id: String) -> Result<PurchaseOutcome> {
        #[cfg(mobile)]
        {
            Ok(self
                .handle
                .run_mobile_plugin::<PurchaseOutcome>("purchase", PurchaseArgs { product_id })?)
        }
        #[cfg(not(mobile))]
        {
            let _ = product_id;
            Err(Error::Plugin(
                "there is nothing to buy on this platform".into(),
            ))
        }
    }

    /// Restore purchases. Apple REQUIRES a visible restore affordance in any
    /// app with a non-consumable or a subscription; an app without one is
    /// rejected under guideline 3.1.1.
    pub fn restore(&self) -> Result<Entitlement> {
        #[cfg(mobile)]
        {
            Ok(self.handle.run_mobile_plugin::<Entitlement>("restore", ())?)
        }
        #[cfg(not(mobile))]
        {
            Ok(Entitlement::platform_free())
        }
    }

    /// Re-read the entitlement from the store, ignoring any cached answer.
    /// Called when the app returns to the foreground: a subscription can
    /// lapse, or be bought in the App Store app, while this one is asleep.
    pub fn refresh(&self) -> Result<Entitlement> {
        #[cfg(mobile)]
        {
            Ok(self
                .handle
                .run_mobile_plugin::<Entitlement>("refresh", ())
                .unwrap_or_else(|e| {
                    eprintln!("skypie-iap: refresh bridge failed: {e}");
                    Entitlement::unreadable()
                }))
        }
        #[cfg(not(mobile))]
        {
            Ok(Entitlement::platform_free())
        }
    }
}

pub trait IapExt<R: Runtime> {
    fn iap(&self) -> &Iap<R>;
}

impl<R: Runtime, T: Manager<R>> IapExt<R> for T {
    fn iap(&self) -> &Iap<R> {
        self.state::<Iap<R>>().inner()
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn entitlement<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Entitlement> {
    app.iap().entitlement()
}

#[tauri::command]
async fn offerings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Offerings> {
    app.iap().offerings()
}

#[tauri::command]
async fn purchase<R: Runtime>(
    app: tauri::AppHandle<R>,
    product_id: String,
) -> Result<PurchaseOutcome> {
    app.iap().purchase(product_id)
}

#[tauri::command]
async fn restore<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Entitlement> {
    app.iap().restore()
}

#[tauri::command]
async fn refresh<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Entitlement> {
    app.iap().refresh()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("skypie-iap")
        .invoke_handler(tauri::generate_handler![
            entitlement,
            offerings,
            purchase,
            restore,
            refresh
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_skypie_iap)?;

            app.manage(Iap::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_is_free_by_decision_and_says_so() {
        let e = Entitlement::platform_free();
        assert!(e.active);
        assert_eq!(e.reason, "platform-free");
    }

    #[test]
    fn an_unreachable_store_never_locks_a_subscriber_out() {
        let e = Entitlement::unknown();
        assert!(e.active, "a paying user on a plane keeps the feature");
        assert_eq!(e.reason, "unknown", "and the UI can still tell it is a guess");
    }

    #[test]
    fn the_entitlement_shape_is_camel_case_on_the_wire() {
        // The frontend reads `expiresAt`; serde's default would send
        // `expires_at` and the paywall would read undefined forever.
        let e = Entitlement {
            active: true,
            reason: "trial".into(),
            expires_at: Some(1_789_296_131),
            product_id: Some("skypie.comments.annual".into()),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["expiresAt"], 1_789_296_131u64);
        assert_eq!(v["productId"], "skypie.comments.annual");
    }

    #[test]
    fn an_absent_expiry_is_omitted_rather_than_sent_as_null() {
        let v = serde_json::to_value(Entitlement::platform_free()).unwrap();
        assert!(v.get("expiresAt").is_none());
    }

    #[test]
    fn a_cancelled_purchase_is_an_outcome_not_an_error() {
        let outcome = PurchaseOutcome {
            cancelled: true,
            entitlement: Entitlement {
                active: false,
                reason: "never".into(),
                expires_at: None,
                product_id: None,
            },
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["cancelled"], true);
        assert_eq!(v["entitlement"]["active"], false);
    }

    #[test]
    fn a_product_round_trips_with_the_store_formatted_price() {
        let p = Product {
            id: "skypie.comments.annual".into(),
            title: "Comments, yearly".into(),
            description: "Comment on artifacts and send the feedback back.".into(),
            price: "12,99 €".into(),
            period: "annual".into(),
            trial_days: Some(7),
        };
        let back: Product = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
        assert_eq!(back.price, "12,99 €", "the store's own string, never re-formatted");
    }
}
