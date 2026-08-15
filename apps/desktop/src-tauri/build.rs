fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_ipc_request",
            "desktop_ipc_cancel",
            "desktop_boot_manifest",
        ]),
    ))
    .expect("failed to build the Tauri application manifest")
}
