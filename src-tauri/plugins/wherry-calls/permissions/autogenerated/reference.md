## Default Permission

Everything the page's bridge (client/src/voice/phone-bridge.ts) calls.
Granted to the phone shells' main window by capabilities/calls-mobile.json.
`debug_incoming` is included because a capability cannot differ by build
profile; the native side refuses it outside debug builds.

#### This default permission set includes the following:

- `allow-capabilities`
- `allow-configure`
- `allow-set-labels`
- `allow-push-token`
- `allow-report-incoming`
- `allow-set-active`
- `allow-report-ended`
- `allow-start-outgoing`
- `allow-take-pending-actions`
- `allow-debug-incoming`
- `allow-register-listener`
- `allow-remove-listener`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`wherry-calls:allow-capabilities`

</td>
<td>

Enables the capabilities command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-capabilities`

</td>
<td>

Denies the capabilities command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-configure`

</td>
<td>

Enables the configure command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-configure`

</td>
<td>

Denies the configure command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-debug-incoming`

</td>
<td>

Enables the debug_incoming command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-debug-incoming`

</td>
<td>

Denies the debug_incoming command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-push-token`

</td>
<td>

Enables the push_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-push-token`

</td>
<td>

Denies the push_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-report-ended`

</td>
<td>

Enables the report_ended command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-report-ended`

</td>
<td>

Denies the report_ended command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-report-incoming`

</td>
<td>

Enables the report_incoming command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-report-incoming`

</td>
<td>

Denies the report_incoming command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-set-active`

</td>
<td>

Enables the set_active command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-set-active`

</td>
<td>

Denies the set_active command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-set-labels`

</td>
<td>

Enables the set_labels command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-set-labels`

</td>
<td>

Denies the set_labels command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-start-outgoing`

</td>
<td>

Enables the start_outgoing command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-start-outgoing`

</td>
<td>

Denies the start_outgoing command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:allow-take-pending-actions`

</td>
<td>

Enables the take_pending_actions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-calls:deny-take-pending-actions`

</td>
<td>

Denies the take_pending_actions command without any pre-configured scope.

</td>
</tr>
</table>
