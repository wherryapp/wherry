#!/usr/bin/env bash
# Runs the iOS half's pure pieces (RingEnvelope.swift, RingMessage.swift) on
# the Mac: compiles them with Tests/main.swift and runs the result. Needs
# Xcode's swiftc; nothing else, and no mobile build first.
#
#   client/src-tauri/plugins/wherry-calls/ios/Tests/run-tests.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sources="$here/../Sources/WherryCalls"
out="$(mktemp -d "${TMPDIR:-/tmp}/wherry-calls-tests.XXXXXX")"
trap 'rm -rf "$out"' EXIT

xcrun swiftc -O -o "$out/ring-tests" \
  "$sources/RingEnvelope.swift" \
  "$sources/RingMessage.swift" \
  "$here/main.swift"
"$out/ring-tests"
