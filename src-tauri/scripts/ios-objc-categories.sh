#!/bin/sh
# Hand edit 11's script half (docs/prompts/regen-hand-edits.md).
#
# Pulls the Objective-C *category* objects out of the Rust crate's static
# library into a small archive of their own, which the Xcode link then
# force-loads (`-Wl,-force_load`). It exists because `-ObjC` cannot be used on
# libapp.a itself:
#
# - Without `-ObjC`, libwebrtc's categories are not linked (their objects
#   export no symbol anything references), and the app dies at launch in a
#   static initialiser: `+[NSString stringForStdString:]: unrecognized
#   selector` (read 2026-10-03, simulator).
# - With `-ObjC`, every Swift object that carries Objective-C metadata is
#   force-loaded too, and libapp.a holds one copy of Tauri's Swift API per
#   plugin (`Tauri.o` and `SwiftRs.o`, six each): 423 duplicate symbols, which
#   Xcode 27's linker has no flag to allow (`-allow_duplicate_symbols` is
#   unknown to it).
#
# So: only the members that have a category list (`__objc_catlist`), and never
# the Swift packages' own. Those members are then defined once, from here;
# libapp.a's copies are never needed, so nothing is defined twice. A build
# without the `phone-media` feature has none and gets an empty archive.
#
#   ios-objc-categories.sh <libapp.a> <output archive>
set -eu

lib="$1"
out="$2"

# Up to date: nothing to do. (Checked by modification time, as make does.)
if [ -f "$out" ] && [ ! "$lib" -nt "$out" ]; then
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/wherry-objc-categories.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
ar x "$lib"

keep=""
for member in *.o; do
  [ -e "$member" ] || continue
  case "$member" in
    Tauri.o | SwiftRs.o) continue ;;
  esac
  if otool -l "$member" 2>/dev/null | grep -q '__objc_catlist'; then
    keep="$keep $member"
  fi
done

rm -f "$out"
if [ -z "$keep" ]; then
  # `ar` will not make an archive of nothing; this is one (the magic and no
  # members), which the linker's -force_load takes as loading nothing.
  printf '!<arch>\n' > "$out"
else
  # shellcheck disable=SC2086
  ar rcs "$out" $keep
fi
echo "ios-objc-categories: $(echo $keep | wc -w | tr -d ' ') category object(s) -> $out"
