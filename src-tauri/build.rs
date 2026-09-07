fn main() {
  // Stage 0 of docs/prompts/native-media-plan.md only. libwebrtc's static
  // archive carries Objective-C categories (+[NSString stringForStdString:]
  // among them) that the linker drops unless -ObjC is passed at the *final*
  // link, and a dependency's own rustc-link-arg does not reach that link --
  // the 2026-09-06 probe crashed at load until the consumer crate said it
  // (the plan's §1.4). Gated on the feature so the ordinary shell build is
  // untouched. Stage 2 moves this to .cargo/config.toml, beside the
  // Windows +crt-static entry the plan calls for.
  if std::env::var_os("CARGO_FEATURE_MEDIA_SPIKE").is_some()
    && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
  {
    println!("cargo:rustc-link-arg=-ObjC");
  }
  tauri_build::build()
}
