# wherry-push fixtures

APNs payloads for `xcrun simctl push`, in exactly the shape the server's
`ApnsSender` sends (docs/prompts/native-push-plan.md §4.4): a fixed,
nameless alert body chosen by kind, `thread-id` equal to the per-device
opaque reference, and `w = { k: kind, r: ref }`.

```
xcrun simctl push booted app.wherry client/src-tauri/plugins/wherry-push/fixtures/message.apns
```

The reference in both files, `AAAAAAAAAAAAAAAAAAAAAA`, is a placeholder of
the right length (22 base64url characters, 16 bytes). A row that must open a
real conversation (I-41, I-42) substitutes that conversation's reference,
computed by `scripts/push/ref.ts <refKey> <conversationId>` (stage P4), in a
copy of the file:

```
sed "s/AAAAAAAAAAAAAAAAAAAAAA/$REF/g" message.apns > /tmp/message.apns
```

## Clearing without a page (debug builds)

`clear`'s code can run with no page, no server and nobody to answer the
permission prompt (row I-44 on a simulator). A debug build launched with
`WHERRY_DEBUG_CLEAR=<ref>` asks for provisional permission if none was
given, and runs the clear for that reference each time the app becomes
active:

```
xcrun simctl install <udid> client/src-tauri/gen/apple/build/arm64-sim/Wherry.app
SIMCTL_CHILD_WHERRY_DEBUG_CLEAR=AAAAAAAAAAAAAAAAAAAAAA xcrun simctl launch <udid> app.wherry
xcrun simctl launch <udid> com.apple.Preferences     # Wherry to the background
xcrun simctl push <udid> app.wherry client/src-tauri/plugins/wherry-push/fixtures/message.apns   # twice
xcrun simctl launch <udid> app.wherry                # back in front: the clear runs
xcrun simctl spawn <udid> log show --last 1m --style compact \
  --predicate 'process == "Wherry" AND (eventMessage BEGINSWITH "[wherry-push" OR eventMessage CONTAINS "delivered notifications")'
```

A working run reads `[wherry-push] delivered id=... thread=<ref> r=<ref>
push=1` once per notification, then `cleared 2 of 2 delivered
(debug-active)`, next to UserNotifications' own `Got 2 delivered
notifications`. `WHERRY_DEBUG_CLEAR_AFTER` (seconds, default 1),
`WHERRY_DEBUG_CLEAR_ON=foreground` and `WHERRY_DEBUG_CLEAR_BADGE=<n>` vary
the timing and set the badge first. `simctl push` cannot send an
`apns-collapse-id`, so a simulator shows two notifications where a phone,
sent the server's collapse id, shows one.
