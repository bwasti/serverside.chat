# Identity, permissions, and capability accounting

The durable security context for every invocation is:

```text
room identity × immutable deployment commit × authenticated principal
```

The room identity selects the SQLite database, scratch filesystem, realtime topic, quotas, and repository. The commit selects immutable `worker.js` and assets. The authenticated principal selects role and spend authority. None of these values may come from guest JavaScript, URL parameters, SQL, filesystem paths, or WebSocket payloads.

## Implemented site and room roles

Site roles govern lifecycle authority: `admin` can create and manage rooms globally, while `member` can create and manage only rooms it owns. Plans govern owned-room ceilings independently: `free` is capped at five; `pro` is reserved for later and has no user-facing upgrade path. The bootstrap owner is promoted to site admin by server configuration, not by a browser-supplied handle.

Room roles govern participation:

- `owner`: manage invitations and room policy; contribute under member/admin policy; exclusively authorize canonical promotion.
- `admin`: manage invitations and room policy; contribute under member/admin policy; cannot promote canonical.
- `contributor`: chat and invoke the agent when contribution and agent policies allow it.
- `viewer`: read a visible room; no chat or agent authority.
- `anonymous`: browse public rooms and pages; no durable chat, typing presence, or agent visibility.

Room creation, rename, and deletion are host operations. Names are validated before database or filesystem access. Rename carries the database authority records and room-owned storage together. Delete removes live routing and authority records but moves storage to a server-owned trash directory so an operator can recover it. Active agent work blocks rename and delete.

Canonical promotion is owner-only and is granted to the agent only during an explicit owner `/agent` invocation. Passive transcript text never supplies promotion authority. A stronger future approval should be signed, expiring, and bound to the exact room and candidate commit.

## Browser and socket identity

The canonical authority is an internal account ID. Google/GitHub identities, browser cookies, and SSH keys are credentials mapped to that account; handles and emails are not authentication factors. SSH public-key signatures are verified before lookup. Unknown verified keys receive anonymous authority and a random, expiring HTTPS link; only a browser authenticated to a canonical account can attach the key. A key cannot create an account or reassign itself from another account. The requested SSH username is never proof of identity.

HTTP and WebSocket requests without a valid session receive anonymous authority. Public pages, service sockets, and the read-only browser TUI are available; private rooms return 404, and existing unauthorized sockets are closed if a room becomes private. The browser uses xterm.js only as a renderer connected directly to the constrained TUI—it never receives a PTY or system shell.

Google OpenID Connect and GitHub OAuth use exact callbacks, 256-bit state bound to a short-lived HttpOnly browser cookie, PKCE S256, and one-use database flow records. Google ID tokens are verified by signature, issuer, audience, and nonce. GitHub access tokens are used only for an immediate authenticated `/user` lookup and are not stored. Provider subjects resolve to canonical accounts and issue 256-bit browser sessions in Secure, HttpOnly, SameSite cookies; only session hashes are stored. OAuth identities are never merged by email or handle.

The temporary development login deliberately provides no external identity proof or recovery. It is labeled in the UI and can be disabled with `DEVELOPMENT_AUTH=false`; it is only for exercising the account and key-link flows before provider credentials are installed.

## Outbound network accounting

Network policy and counters live in the host. Each operation is charged to `(room, principal)` for request bytes, response bytes, calls, concurrency, and wall time. Service-wide ceilings provide a second bound. Owner-approved agents receive their own principal and budget, so one collaborator cannot silently spend another collaborator's allowance.

Before outbound fetch is enabled, the host must enforce HTTPS, permitted ports, DNS resolution and revalidation, private/link-local/loopback/cloud-metadata denial, redirect limits, decompressed-response limits, header filtering, timeouts, and audit logs. The worker receives no raw socket capability.

## Current state

QuickJS Wasm isolation, room SQLite, room scratch storage, bounded structured logs, immutable assets, host-owned realtime sockets, canonical accounts, Google/GitHub OAuth flows, browser sessions, browser-authorized multi-key SSH linking, durable room memberships, hashed invitations, and host-enforced chat/agent policies are implemented. Real OAuth buttons appear when provider credentials are configured. Agent credential issuance, outbound fetch, account recovery, and user-facing credential/membership management are not yet wired.

The prototype currently enforces 128 aggregate live SSH/browser connections, 100 WebSockets, 32 concurrent HTTP executions, and 64 MiB of response egress per rolling hour per room. These room-wide limits will become outer ceilings once authenticated per-principal sub-budgets are implemented.
