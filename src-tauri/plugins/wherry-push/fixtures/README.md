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
