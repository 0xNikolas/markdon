fn main() {
    // cargo does not otherwise track ../dist: generate_context!() embeds it only in
    // release (custom-protocol) builds, and the non-codegen tauri_build::build() emits
    // no rerun-if-changed for frontendDist. Fold dist into this crate's fingerprint so a
    // changed frontend forces a recompile + re-embed. Directory rerun-if-changed resolves
    // via recursive mtime, and Vite's content-hashed filenames also mutate the dir listing,
    // so any content change advances the fingerprint. Guard on existence to mirror tauri's
    // own codegen and avoid cargo's nonexistent-path warning on dev/fresh-clone builds
    // where dist is absent (and embedding does not happen anyway).
    if std::path::Path::new("../dist").exists() {
        println!("cargo:rerun-if-changed=../dist");
    }
    tauri_build::build()
}
