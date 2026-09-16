// This install's human-readable name, as it appears on the OTHER device's
// screen: in the pairing sheet, in Settings -> Devices, and in the `from
// <Device>` badge on every pulled tab.
//
// `skypie_remote::device_name()` answers with `gethostname`, which is right on
// macOS and wrong on iOS: under the simulator it returns the HOST Mac's name,
// so a paired simulator announced itself as "Alvaros-MacBook-Pro" and sat in
// the device list indistinguishable from the Mac it was paired to
// (STATUS.md, "Known gap"). On a physical iPhone it answers with a name the
// user never chose either.
//
// The name is NOT a security boundary. Pairing is confirmed by comparing six
// fingerprint words on both screens, and `proto::sanitize_device` already
// strips anything hostile out of a name that arrives over the wire. This is
// purely about a person recognising their own device in a list.

/// The name this install announces in every handshake.
///
/// macOS keeps the hostname. iOS asks UIKit, on the simulator AND on
/// hardware, because `gethostname` is wrong on both — differently:
///
///   Simulator: it returns the HOST Mac's name, so a paired simulator
///       announced "Alvaros-MacBook-Pro" and sat in the device list
///       indistinguishable from the Mac it was paired to.
///
///   Physical iPhone: it returns "localhost". MEASURED, not assumed — an
///       iPhone 17 Pro on iOS 26.6.1 paired to this Mac and announced
///       exactly that. The `iPhone-de-Alvaro.coredevice.local` name
///       `devicectl` prints is a CoreDevice/mDNS name and is NOT what
///       `gethostname` answers inside the app sandbox.
///
/// UIKit answers "iPhone" without the
/// `com.apple.developer.device-information.user-assigned-device-name`
/// entitlement, and the full model ("iPhone 17 Pro") on the simulator. Both
/// beat "localhost" and both beat naming the wrong machine. The cost is that
/// two iPhones of the SAME model are indistinguishable; the entitlement is
/// what would fix that, and it needs a paid account and a review
/// justification.
pub fn announced_name() -> String {
    #[cfg(target_os = "ios")]
    {
        if let Some(name) = ios_device_name() {
            return skypie_remote::proto::sanitize_device(&name);
        }
    }
    skypie_remote::device_name()
}

#[cfg(target_os = "ios")]
fn ios_device_name() -> Option<String> {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::UIDevice;

    // `UIDevice::currentDevice` is main-thread-only and objc2 enforces that in
    // the TYPE system, so the marker is the proof rather than a comment. Off
    // the main thread there is no name to read and this falls through to the
    // hostname instead of asserting. Neither call is `unsafe`: objc2-ui-kit
    // exposes both as safe fns.
    let mtm = MainThreadMarker::new()?;
    let name = UIDevice::currentDevice(mtm).name().to_string();

    let trimmed = name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
