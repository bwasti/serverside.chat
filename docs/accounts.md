# Accounts and room policy

Accounts are host-owned records in `.data/accounts.sqlite`. Service JavaScript cannot read or mutate this database. The internal user ID is canonical; Google/GitHub provider subjects, browser sessions, SSH keys, and future scoped clanker credentials are separate credentials that resolve to it. Display handles and email addresses are never credentials.

## Site roles, plans, and room ownership

Site roles and room roles are independent:

- A site `admin` may view, chat in, and moderate every room regardless of its visibility or contribution policy, and may create, rename, or delete rooms globally. The configured bootstrap owner receives this role. This host authority does not create a room-membership row or transfer room ownership.
- A site `member` may create, rename, and delete rooms they own.
- Every authenticated account can create rooms explicitly from the room bar; signing in does not create one automatically. Room names are globally unique URL slugs using 1–32 lowercase letters, numbers, and dashes.
- `lobby` is a public, host-managed system room. It is the default landing room, every authenticated account receives contributor membership, and it does not consume an ownership slot. It cannot be renamed, deleted, or reconfigured through room commands.
- A `free` account may own at most five rooms. The data model reserves a 25-room `pro` allowance, but no upgrade or billing path is enabled. Site admins retain a hard 100-room ceiling.

Room deletion requires typing the current room's exact name. Pressing Delete on a highlighted sidebar room opens the confirmation screen; the equivalent command is `/room delete <current-name>`. Active clients are moved to another visible room, while the repository, SQLite database, scratch files, transcript, deployment state, policy, ownership, and membership graph are archived under `.data/.trash/rooms/` plus host-owned metadata. Existing invites, clanker credentials, and mount credentials are revoked rather than revived later. Owners and site admins can discover archives with `/room archives` and restore the latest matching archive with `/room restore <name>`, provided the name remains free and the owner remains within its active-room quota. Free accounts may retain ten deleted rooms, pro accounts fifty, and site-admin owners two hundred; reaching that bound blocks further deletion instead of silently purging data. Renaming atomically moves the complete active room state and updates HTTP/Wasm routing for the new URL.

## SSH enrollment

The server verifies every SSH public-key signature. A known fingerprint resolves to its account; an unknown verified key receives a stable anonymous principal for that key. The anonymous TUI renders a short-lived, clickable HTTPS link containing a random hashed-at-rest key-link token. The user signs into their canonical account in the browser and explicitly attaches that verified key. The live SSH session notices the completed link and adopts the account without reconnecting. Any number of keys can be attached to one account, and a key already owned by another account cannot be reassigned through this flow.

An admin creates a contributor invite with `/invite`; `/invite admin` and `/invite viewer` select another role. The command returns a complete `https://serverside.chat/invite/<token>` URL. Opening it signs an anonymous visitor in when necessary, redeems the invitation into their canonical account, and enters the room. The token is random, stored only as a hash, expires after 24 hours, and is single-use. The lower-level `ssh -t -p 2222 serverside.chat invite '<token>'` flow remains available for terminal enrollment. An invite never creates an account from an SSH key. Existing accounts gain membership without changing identity, and redemption never downgrades a stronger role.

## Browser and OAuth credentials

The browser TUI presents blue, clickable **sign in** text to anonymous visitors. Google OpenID Connect and GitHub OAuth use 256-bit state, a browser-bound HttpOnly OAuth-flow cookie, PKCE S256, exact callbacks, one-use flow records, and ten-minute expiry. Google ID tokens are verified against Google's signing keys, issuer, audience, and nonce. GitHub's exchanged access token is used only to revalidate `/user` and is not persisted. A successful identity resolves or creates the canonical internal account, then issues a random 256-bit browser session held in a Secure, HttpOnly, SameSite cookie for 30 days; only its hash is stored.

Until provider credentials are configured, the UI exposes a conspicuously labeled development login. It creates a real canonical account and session but has no recovery or external identity proof, so it must be disabled before production authentication is considered complete.

OAuth identities from different providers are never merged by matching email or handle. An already authenticated account may explicitly attach another provider identity; the flow records the initiating internal user ID, and refuses an identity already owned by another account.

The rooms sidebar treats the bottom `@handle` row as a selectable account destination. Anonymous sessions can open the canonical OAuth flow there. Authenticated sessions can inspect their site role, plan, room allowance, linked provider names, and active SSH-key count; they can also update their display name or create a short-lived account-bound link for attaching another Google or GitHub identity. These changes remain host-owned and are recorded in the account audit log.

Room-bar ordering is a canonical-account preference, not shared room state. While the sidebar is focused, Shift-Up and Shift-Down move the selected room and persist the complete visible ordering for that account; new or newly visible rooms append without disturbing it. Anonymous sessions keep the default order. Shift-Enter opens the selected room's settings. Room admins may edit visibility, contribution, and clanker policy; site admins additionally edit per-room connection, concurrent-request, database, source, scratch, hourly egress, and hourly clanker-output limits. The host rechecks authority when settings open and save.

Prototype owner accounts that existed before OAuth can run `ssh -p 2222 serverside.chat account`. The server returns a random, hashed-at-rest, single-use HTTPS link valid for ten minutes. Choosing Google or GitHub consumes that bootstrap token, binds the verified provider subject to the existing internal account, and issues the normal browser session. This is a migration path, not the routine browser sign-in flow.

## Room mount credentials

`/mount` uses the already-authenticated canonical account to create a WebDAV app credential for the current room. It does not reuse or disclose a GitHub access token, browser cookie, or SSH private key. The random username locates the credential record and the independent 256-bit password is stored only as a hash. Issuing a replacement revokes and removes the previous active credential for that account and room; `/mount revoke` disables it explicitly. Credentials expire after 90 days.

Finder sends the credential through HTTP Basic authentication only over the existing HTTPS origin. The WebDAV request then resolves to the internal user ID and re-evaluates the current room policy for every filesystem operation. The credential is therefore a scoped transport credential, not a durable room role. SFTP and SSHFS use a linked SSH public key instead, but converge on the same user ID and capability checks.

## Independent room controls

| Control | Values | Effect |
| --- | --- | --- |
| Visibility | `public`, `private` | Public rooms allow anonymous reading; private rooms require membership. |
| Contributions | `members`, `authenticated`, `admins`, `disabled` | Members means invited owner/admin/contributor. Authenticated allows any signed-in account that can view the room to chat, edit source, and invoke its configured clanker; the UI marks this as dangerous. Admins means owner/admin; disabled blocks normal chat for everyone. |
| Clanker | `passive`, `explicit`, `disabled` | Passive reviews permitted chat; explicit runs only for `/clanker`; disabled rejects all clanker invocation. |

Room `owner` and room `admin` can inspect or change these controls with `/permissions`. Only a room owner or site admin can rename or delete a room. Disabling contributions does not lock administrators out of the host policy commands.

Per-room resource limits default to 128 connections, 32 concurrent requests, 5 MiB each of SQLite/source/scratch storage, 64 MiB of hourly response egress, and one million hourly clanker output tokens. Only a site admin can change these values, from the same Shift-Enter settings screen. Host-wide process limits and the fixed Wasm safety boundary remain outside room settings.

Room owners, room admins, and site admins can moderate persisted chat messages. With an empty composer, Up selects a message; Enter creates a durable reply reference, P pins or unpins it, and Delete opens a keyboard confirmation before removal. Up to five non-system messages can remain pinned above each room transcript. Pin changes persist in host-owned room state and are audited; the clanker can request the same operation by stable message ID, but the host applies the triggering user's current admin authority. Deletion is also saved immediately and audited. Reply references retain a bounded author/excerpt snapshot so a discussion remains intelligible if its target is later removed.

## Enforcement boundaries

- Room visibility is checked before an SSH room is listed and before HTTP execution or WebSocket upgrade.
- Chat authorization is checked before persistence, broadcast, typing presence, or model routing.
- The model receives only messages the host marked clanker-visible at insertion time.
- Clanker invocation requires both contribution authority and a non-disabled clanker policy.
- Message deletion requires room-admin authority (which includes the room owner and a site admin) and is audited.
- Canonical promotion requires the owner identity and an explicit `/clanker` run; prompt text cannot grant it.
- Policy changes, logins, invitation creation and redemption, mount credential lifecycle, and remote filesystem mutations are written to `audit_events`.

Before pairing, the browser TUI uses a stable source-IP principal to distinguish approximate people from concurrent connections; it does not pretend that an IP address is an authenticated account. That principal can browse public rooms and submit messages only to the host-managed lobby moderation gate. After SSH approval, HTTP pages, service WebSockets, and the browser TUI resolve the session cookie to the same durable account. Private resources therefore use the normal room membership check rather than a special invitation URL.
