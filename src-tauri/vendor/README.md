# Vendored crates

Two published crates carried as copies, each with one fix, wired in by
`[patch.crates-io]` in `../Cargo.toml`. Both were found on 2026-09-28, on
the first **release build for a device** under Xcode 27: every earlier iOS
row ran a simulator debug build, which hides both faults. Everything else in
each directory is the published crate byte for byte (the `.crate` Cargo
fetched, minus `.cargo-ok`, and minus `.github/` in swift-rs; swift-rs's own
`.gitignore` also keeps its `Cargo.lock` out of git, which Cargo never reads
for a dependency), so
`diff -r` against `~/.cargo/registry/src/*/<name>-<version>` shows only the
hunks below.

**Drop a copy** when the published crate carries the fix and the version
Tauri pins has moved to it: delete the directory and its `[patch]` line, run
a device release build, and read I-75 on a phone. File both upstream
(`docs/upstream/`).

## `tao/` — 0.35.3 (the version `tauri` 2.11.5 pins)

`src/platform_impl/ios/view.rs`, `configuration_for_connecting_scene_session`.
Upstream returns `Retained::as_ptr(&config)` and then drops `config`, so
UIKit receives a freed `UISceneConfiguration`. On a device release build that
is `EXC_BAD_ACCESS` in `objc_retain` under
`-[UIApplication _connectUISceneFromFBSScene:transitionContext:]`, at every
launch, on iOS 26.6.2 (the maintainer's iPhone 16 Pro Max). A simulator debug
build survived it (I-75, 2026-09-27), believed because the object was still
held by the autorelease pool. The path exists only because of hand edit 14
(`UIApplicationSupportsMultipleScenes`), which iOS 27 requires, so there is
no build that launches on both without this fix.

The fix: `Retained::autorelease_return(config)`: the selector returns +0,
and the pool keeps the object alive until UIKit has retained it.

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
