# Vendored crates

One published crate carried as a copy with one fix, wired in by
`[patch.crates-io]` in `../Cargo.toml`. It was found on 2026-09-28, on the
first **release build for a device** under Xcode 27: every earlier iOS row
ran a simulator debug build, which hides the fault. Everything else in the
directory is the published crate byte for byte (the `.crate` Cargo fetched,
minus `.cargo-ok` and `.github/`; swift-rs's own `.gitignore` also keeps its
`Cargo.lock` out of git, which Cargo never reads for a dependency), so
`diff -r` against `~/.cargo/registry/src/*/<name>-<version>` shows only the
hunk below.

**Drop a copy** when the published crate carries the fix and the version
Tauri pins has moved to it: delete the directory and its `[patch]` line, run
a device release build, and read I-75 on a phone. File it upstream
(`docs/upstream/`).

A second copy, `tao/` 0.35.3, went with the move to tauri 2.12. Its
`configuration_for_connecting_scene_session` returned a freed
`UISceneConfiguration`, so every device release build crashed at launch.
tao 0.36.0 fixed that upstream (tauri-apps/tao#1245), and tauri-runtime-wry
2.12 requires tao 0.37, which returns `Retained::autorelease_ptr(config)`
(`platform_impl/ios/view.rs`). The copy and its note are in this
directory's git history.

## `swift-rs/` — 1.0.8

`src-rs/build.rs`, `globalize_cdecl_symbols`. Xcode 27's SwiftPM leaves
`@_cdecl` functions local in static products, and swift-rs promotes them
back to global with `llvm-objcopy`, only for symbols in the package's own
object member, because every archive embeds copies of its dependencies and
promoting those everywhere crashes Xcode 27's `ld` on duplicates. SwiftRs's
own runtime (`retain_object`, `release_object`, `data_from_bytes`,
`string_from_bytes`) is one of those embedded copies, in **every** archive,
so nothing ever promotes it and the app's link fails with those symbols
undefined (the simulator debug layout keeps them global, so only the device
build hits it).

The fix: when the package is `Tauri`, the `SwiftRs` member counts as its own.
That gives exactly one global definition, in the archive every Tauri app links.

Unrelated to the patch but found beside it: that promotion needs
`llvm-objcopy` from `rustup component add llvm-tools`, and without it
swift-rs only warns. `docs/mobile-setup.md`'s prerequisites carry it.
