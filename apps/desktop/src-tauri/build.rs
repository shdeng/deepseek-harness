fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_pick_directory",
            "desktop_ipc_request",
            "desktop_ipc_cancel",
        ]),
    ))
    .expect("failed to build the Tauri application manifest")
}
