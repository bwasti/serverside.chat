# Accounts and room policy

Accounts are host-owned records in `.data/accounts.sqlite`. Service JavaScript cannot read or mutate this database. The internal user ID is canonical; Google/GitHub provider subjects, browser sessions, SSH keys, and future scoped agent credentials are separate credentials that resolve to it. Display handles and email addresses are never credentials.

## Site roles, plans, and room ownership

Site roles and room roles are independent:

- A site `admin` may create rooms and rename or delete any room. The configured bootstrap owner receives this role.
- A site `member` may create, rename, and delete rooms they own.
- Every authenticated account receives one owned starter room named from its handle. Room names are globally unique URL slugs using 1–32 lowercase letters, numbers, and dashes.
- `lobby` is a public, host-managed system room. It is the default landing room, every authenticated account receives contributor membership, and it does not consume an ownership slot. It cannot be renamed, deleted, or reconfigured through room commands.
- A `free` account may own at most five rooms. The data model reserves a 25-room `pro` allowance, but no upgrade or billing path is enabled. Site admins retain a hard 100-room ceiling.

Room deletion requires typing the current room's exact name. Its database records are removed, active clients are moved or disconnected, and its repository, SQLite database, scratch files, transcript, and deployment state are moved under `.data/.trash/rooms/` for operator recovery. Renaming atomically moves this complete room-owned state and updates HTTP/Wasm routing for the new URL.

## SSH enrollment

The server verifies every SSH public-key signature. A known fingerprint resolves to its account; an unknown verified key receives a stable anonymous principal for that key. The anonymous TUI renders a short-lived, clickable HTTPS link containing a random hashed-at-rest key-link token. The user signs into their canonical account in the browser and explicitly attaches that verified key. The live SSH session notices the completed link and adopts the account without reconnecting. Any number of keys can be attached to one account, and a key already owned by another account cannot be reassigned through this flow.

An admin creates an invite with `/invite admin|contributor|viewer`. The token is random, stored only as a hash, expires after 24 hours, and is single-use. `ssh -t -p 2222 serverside.chat invite '<token>'` carries the intended membership through the browser account/key-link flow, consumes it for the canonical account, and switches the live TUI into the invited room. An invite never creates an account from an SSH key. Existing accounts gain membership without changing identity, and redemption never downgrades a stronger role.

## Browser and OAuth credentials

The browser TUI presents blue, clickable **sign in** text to anonymous visitors. Google OpenID Connect and GitHub OAuth use 256-bit state, a browser-bound HttpOnly OAuth-flow cookie, PKCE S256, exact callbacks, one-use flow records, and ten-minute expiry. Google ID tokens are verified against Google's signing keys, issuer, audience, and nonce. GitHub's exchanged access token is used only to revalidate `/user` and is not persisted. A successful identity resolves or creates the canonical internal account, then issues a random 256-bit browser session held in a Secure, HttpOnly, SameSite cookie for 30 days; only its hash is stored.

Until provider credentials are configured, the UI exposes a conspicuously labeled development login. It creates a real canonical account and session but has no recovery or external identity proof, so it must be disabled before production authentication is considered complete.

OAuth identities from different providers are never merged by matching email or handle. An already authenticated account may explicitly attach another provider identity; the flow records the initiating internal user ID, and refuses an identity already owned by another account.

Prototype owner accounts that existed before OAuth can run `ssh -p 2222 serverside.chat account`. The server returns a random, hashed-at-rest, single-use HTTPS link valid for ten minutes. Choosing Google or GitHub consumes that bootstrap token, binds the verified provider subject to the existing internal account, and issues the normal browser session. This is a migration path, not the routine browser sign-in flow.

## Independent room controls

| Control | Values | Effect |
| --- | --- | --- |
| Visibility | `public`, `private` | Public rooms allow anonymous reading; private rooms require membership. |
| Contributions | `members`, `admins`, `disabled` | Members means owner/admin/contributor; admins means owner/admin; disabled blocks normal chat for everyone. |
| Agent | `passive`, `explicit`, `disabled` | Passive reviews permitted chat; explicit runs only for `/agent`; disabled rejects all agent invocation. |

Room `owner` and room `admin` can inspect or change these controls with `/permissions`. Only a room owner or site admin can rename or delete a room. Disabling contributions does not lock administrators out of the host policy commands.

## Enforcement boundaries

- Room visibility is checked before an SSH room is listed and before HTTP execution or WebSocket upgrade.
- Chat authorization is checked before persistence, broadcast, typing presence, or model routing.
- The model receives only messages the host marked agent-visible at insertion time.
- Agent invocation requires both contribution authority and a non-disabled agent policy.
- Canonical promotion requires the owner identity and an explicit `/agent` run; prompt text cannot grant it.
- Policy changes, logins, invitation creation, and redemption are written to `audit_events`.

Before pairing, the browser TUI uses a stable source-IP principal to distinguish approximate people from concurrent connections; it does not pretend that an IP address is an authenticated account. That principal can browse public rooms and submit messages only to the host-managed lobby moderation gate. After SSH approval, HTTP pages, service WebSockets, and the browser TUI resolve the session cookie to the same durable account. Private resources therefore use the normal room membership check rather than a special invitation URL.
