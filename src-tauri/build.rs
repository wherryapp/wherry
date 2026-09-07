fn main() {
  // libwebrtc's static archive carries Objective-C categories (+[NSString
  // stringForStdString:] among them) that the linker drops unless -ObjC is
  // passed at the *final* link, and a dependency's own rustc-link-arg does
  // not reach that link -- the 2026-09-06 probe crashed at load until the
  // consumer crate said it (docs/prompts/native-media-plan.md §1.4). Here
  // rather than .cargo/config.toml because a rustflag re-fingerprints every
  // crate of every target, and this line only exists on the one target
  // that links libwebrtc. iOS is `target_vendor = "apple"` too and never
  // sees it: the crate is not in the mobile graph (Cargo.toml).
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rustc-link-arg=-ObjC");
  }
  tauri_build::build()
}
