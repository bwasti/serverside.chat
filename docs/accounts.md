# Accounts and room policy

Accounts are host-owned records in `.data/accounts.sqlite`. Service JavaScript cannot read or mutate this database. The internal user ID is canonical; Google/GitHub provider subjects, browser sessions, SSH keys, and future scoped agent credentials are separate credentials that resolve to it. Display handles and email addresses are never credentials.

## SSH enrollment

The server verifies every SSH public-key signature. A known fingerprint resolves to its account; an unknown verified key receives a stable anonymous principal for that key. The read-only TUI renders a short-lived, clickable HTTPS link containing a random hashed-at-rest key-link token. The user signs into their canonical account in the browser and explicitly attaches that verified key. The live SSH session notices the completed link and adopts the account without reconnecting. Any number of keys can be attached to one account, and a key already owned by another account cannot be reassigned through this flow.

An admin creates an invite with `/invite admin|contributor|viewer`. The token is random, stored only as a hash, expires after 24 hours, and is single-use. `ssh -t -p 2222 serverside.chat invite '<token>'` carries the intended membership through the browser account/key-link flow, consumes it for the canonical account, and switches the live TUI into the invited room. An invite never creates an account from an SSH key. Existing accounts gain membership without changing identity, and redemption never downgrades a stronger role.

## Browser and OAuth credentials

The browser TUI presents blue, clickable **sign in** text while read-only. Google OpenID Connect and GitHub OAuth use 256-bit state, a browser-bound HttpOnly OAuth-flow cookie, PKCE S256, exact callbacks, one-use flow records, and ten-minute expiry. Google ID tokens are verified against Google's signing keys, issuer, audience, and nonce. GitHub's exchanged access token is used only to revalidate `/user` and is not persisted. A successful identity resolves or creates the canonical internal account, then issues a random 256-bit browser session held in a Secure, HttpOnly, SameSite cookie for 30 days; only its hash is stored.

Until provider credentials are configured, the UI exposes a conspicuously labeled development login. It creates a real canonical account and session but has no recovery or external identity proof, so it must be disabled before production authentication is considered complete.

OAuth identities from different providers are never merged by matching email or handle. An already authenticated account may explicitly attach another provider identity; the flow records the initiating internal user ID, and refuses an identity already owned by another account.

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
