// `tauri-build` runs in the app shells (skypie-desktop, skypie-ios), which own
// tauri.conf.json. This library still gates code on the `mobile` / `desktop`
// cfgs that `tauri-build` would set, so it derives them from the target here.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "ios" || os == "android" {
        println!("cargo:rustc-cfg=mobile");
    } else {
        println!("cargo:rustc-cfg=desktop");
    }
}
