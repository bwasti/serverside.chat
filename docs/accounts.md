# Accounts and room policy

Accounts are host-owned records in `.data/accounts.sqlite`. Service JavaScript cannot read or mutate this database. A durable user may eventually have several identities—SSH keys, Google, Apple, or scoped agent credentials—all resolving to one internal user ID. Display handles are not credentials.

## SSH enrollment

The server verifies every SSH public-key signature. A known fingerprint resolves to its account; an unknown verified key receives a stable anonymous principal for that key. On a fresh local install, keys from `~/.ssh/*.pub` (or `SSH_BOOTSTRAP_KEYS`) are enrolled to the initial owner.

An admin creates an invite with `/invite admin|contributor|viewer`. The token is random, stored only as a hash, expires after 24 hours, and is single-use. An anonymous user can connect with their own key and run `/redeem <token>`, or redeem and enter directly with `ssh -t -p 2222 serverside.chat invite '<token>'`. Redemption atomically creates an account, binds that exact key, creates the room membership, consumes the invite, and switches the live TUI into the invited room. Existing accounts gain the membership without changing identity, and redemption never downgrades a role they already hold. Later SSH connections with the key resolve directly to that account.

The browser TUI presents a **sign in** button while read-only. Clicking it creates a random ten-minute pairing code and a 256-bit session token held in a Secure, HttpOnly, SameSite cookie. The user approves the code from an authenticated SSH account with `ssh -p 2222 serverside.chat approve <code>` or `/approve <code>` inside the TUI. Only hashes of both values are stored. Approval consumes the pairing code, binds the browser session to that durable user for 30 days, and causes the browser to reconnect with the user's room permissions. Sessions are revocable.

Google and Apple are modeled as additional `(provider, provider_subject)` identities. Their callback and account-linking UI are intentionally not implemented yet; they should attach to the same user and issue the same kind of host-owned web session instead of creating a separate permission system.

## Independent room controls

| Control | Values | Effect |
| --- | --- | --- |
| Visibility | `public`, `private` | Public rooms allow anonymous reading; private rooms require membership. |
| Contributions | `members`, `admins`, `disabled` | Members means owner/admin/contributor; admins means owner/admin; disabled blocks normal chat for everyone. |
| Agent | `passive`, `explicit`, `disabled` | Passive reviews permitted chat; explicit runs only for `/agent`; disabled rejects all agent invocation. |

Owner and admin can inspect or change these controls with `/permissions`. Disabling contributions does not lock administrators out of the host policy commands.

## Enforcement boundaries

- Room visibility is checked before an SSH room is listed and before HTTP execution or WebSocket upgrade.
- Chat authorization is checked before persistence, broadcast, typing presence, or model routing.
- The model receives only messages the host marked agent-visible at insertion time.
- Agent invocation requires both contribution authority and a non-disabled agent policy.
- Canonical promotion requires the owner identity and an explicit `/agent` run; prompt text cannot grant it.
- Policy changes, logins, invitation creation, and redemption are written to `audit_events`.

Before pairing, the browser TUI uses a stable source-IP principal to distinguish approximate people from concurrent connections, but remains read-only; it does not pretend that an IP address is an authenticated account. After SSH approval, HTTP pages, service WebSockets, and the browser TUI resolve the session cookie to the same durable account. Private resources therefore use the normal room membership check rather than a special invitation URL.
