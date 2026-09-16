// Tauri picks the iOS Swift package up from `ios/`; the commands listed here
// become the permission set the app's capabilities file grants.
const COMMANDS: &[&str] = &["entitlement", "offerings", "purchase", "restore", "refresh"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
