## Default Permission

Everything the page needs to drive native push: read the state, obtain and
forget the token, consume a notification tap, clear delivered notifications,
set the icon badge, open the system settings page, write the label map a
push is named from, and listen for the `token`, `opened` and `received`
events. docs/prompts/native-push-plan.md §5.1,
docs/prompts/notification-names-plan.md §4.

#### This default permission set includes the following:

- `allow-status`
- `allow-register`
- `allow-unregister`
- `allow-take-open`
- `allow-clear`
- `allow-set-badge`
- `allow-open-settings`
- `allow-set-labels`
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

`wherry-push:allow-clear`

</td>
<td>

Enables the clear command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-clear`

</td>
<td>

Denies the clear command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-open-settings`

</td>
<td>

Enables the open_settings command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-open-settings`

</td>
<td>

Denies the open_settings command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-register`

</td>
<td>

Enables the register command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-register`

</td>
<td>

Denies the register command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-set-badge`

</td>
<td>

Enables the set_badge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-set-badge`

</td>
<td>

Denies the set_badge command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-set-labels`

</td>
<td>

Enables the set_labels command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-set-labels`

</td>
<td>

Denies the set_labels command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-status`

</td>
<td>

Enables the status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-status`

</td>
<td>

Denies the status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-take-open`

</td>
<td>

Enables the take_open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-take-open`

</td>
<td>

Denies the take_open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:allow-unregister`

</td>
<td>

Enables the unregister command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`wherry-push:deny-unregister`

</td>
<td>

Denies the unregister command without any pre-configured scope.

</td>
</tr>
</table>
