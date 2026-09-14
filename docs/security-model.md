# Identity, permissions, and capability accounting

The durable security context for every invocation is:

```text
room identity × immutable deployment commit × authenticated principal
```

The room identity selects the SQLite database, scratch filesystem, realtime topic, quotas, and repository. The commit selects immutable `worker.js` and assets. The authenticated principal selects role and spend authority. None of these values may come from guest JavaScript, URL parameters, SQL, filesystem paths, or WebSocket payloads.

## Implemented site and room roles

Site roles govern lifecycle and moderation authority: `admin` can view, moderate, create, and manage rooms globally, while `member` can create and manage only rooms it owns. Plans govern owned-room ceilings independently: `free` is capped at five; `pro` is reserved for later and has no user-facing upgrade path. The bootstrap owner is promoted to site admin by server configuration, not by a browser-supplied handle.

Room roles govern participation:

- `owner`: manage invitations and room policy; contribute under member/admin policy; exclusively authorize canonical promotion.
- `admin`: manage invitations and room policy; contribute under member/admin policy; cannot promote canonical.
- `contributor`: chat and invoke the clanker when contribution and clanker policies allow it.
- `viewer`: read a visible room; no chat or clanker authority.
- `anonymous`: browse public rooms and pages; no normal-room chat, typing presence, or clanker visibility. The host-managed lobby alone accepts bounded, rate-limited messages after a separate clanker moderation decision.

Room creation, rename, archive, and restoration are host operations. Names and host-generated archive identifiers are validated before database or filesystem access. Rename carries the database authority records and room-owned storage together. Deletion removes live routing but atomically snapshots ownership, policy, and memberships while moving storage to a bounded server-owned archive; old bearer credentials are deliberately not restored. Restoration requires the original owner or a site admin, an unused original name, available active-room quota, and the matching archived storage. Active clanker work blocks rename and deletion. Persisted-message deletion is a separate audited operation available to the room owner, room admins, and site admins; the client cannot grant itself that authority.

Canonical promotion is owner-only and is granted to the clanker only during an explicit owner `/clanker` invocation. Passive transcript text never supplies promotion authority. A stronger future approval should be signed, expiring, and bound to the exact room and candidate commit.

## Browser and socket identity

The canonical authority is an internal account ID. Google/GitHub identities, browser cookies, and SSH keys are credentials mapped to that account; handles and emails are not authentication factors. SSH public-key signatures are verified before lookup. Unknown verified keys receive anonymous authority and a random, expiring HTTPS link; only a browser authenticated to a canonical account can attach the key. A key cannot create an account or reassign itself from another account. The requested SSH username is never proof of identity.

HTTP and WebSocket requests without a valid session receive anonymous authority. Public pages and service sockets remain readable; private rooms return 404, and existing unauthorized sockets are closed if a room becomes private. The browser TUI permits anonymous composition only in `lobby`. Each message is capped at 600 bytes, checked against per-identity and global rate limits, and persisted or shown to the guide only after a fail-closed clanker moderator returns a schema-constrained `ALLOW` verdict. The browser uses xterm.js only as a renderer connected directly to the constrained TUI—it never receives a PTY or system shell.

Personal room ordering is stored by canonical user ID and contains room names only; it grants no visibility or membership. Every render intersects that preference with current host authorization. The room settings screen is likewise only a client affordance over the same host-owned `updateRoomPolicy` check used by slash commands.

The collaboration UI and canonical account cookies live only on `serverside.chat`; room sites live on distinct `ROOM.serverside.chat` origins. Room JavaScript cannot read the host-only `__Host-` control cookies. Proxy identity headers are removed before guest invocation, legacy path routing strips cookies and authorization, and a room response may not set a parent-domain cookie. A room can implement separate site-local authentication without becoming a credential for the control plane.

Google OpenID Connect and GitHub OAuth use exact callbacks, 256-bit state bound to a short-lived HttpOnly browser cookie, PKCE S256, and one-use database flow records. Google ID tokens are verified by signature, issuer, audience, and nonce. GitHub access tokens are used only for an immediate authenticated `/user` lookup and are not stored. Provider subjects resolve to canonical accounts and issue 256-bit browser sessions in Secure, HttpOnly, SameSite cookies; only session hashes are stored. OAuth identities are never merged by email or handle.

The temporary development login deliberately provides no external identity proof or recovery. It is labeled in the UI and can be disabled with `DEVELOPMENT_AUTH=false`; it is only for exercising the account and key-link flows before provider credentials are installed.

## Outbound network accounting

Network policy and counters live in the host. Each operation is charged to `(room, principal)` for request bytes, response bytes, calls, concurrency, and wall time. Service-wide ceilings provide a second bound. Owner-approved clankers receive their own principal and budget, so one collaborator cannot silently spend another collaborator's allowance.

Before outbound fetch is enabled, the host must enforce HTTPS, permitted ports, DNS resolution and revalidation, private/link-local/loopback/cloud-metadata denial, redirect limits, decompressed-response limits, header filtering, timeouts, and audit logs. The worker receives no raw socket capability.

## Source editing capabilities

An authenticated SSH key may request `shell <room>` or the SFTP subsystem. The host resolves that key to the canonical account before selecting visible rooms and granting read or contribution capabilities. The shell is a predefined command interpreter rather than an OS process. SFTP exposes a virtual room namespace rather than a host directory. `/mount` can additionally mint a random, hashed-at-rest, room-scoped WebDAV credential for Finder; it expires, rotates, can be revoked, and rechecks the canonical account's current room policy on every request. Basic authentication is accepted only at the HTTPS WebDAV route. None of these interfaces permits `.git`, traversal outside a room, symlinks, devices, arbitrary executables, environment access, or raw network access.

The host remains the version authority. Clients invoke bounded operations such as status, commit, preview, rebase, and publish; only host-constructed argument arrays reach Git. All mutations are audited, files and trees remain quota-bound, long-lived file writes use optimistic revisions, promotion is owner-only, and canonical history remains fast-forward and merge-free. Website workers never receive source-editing or version capabilities.

## Current state

QuickJS Wasm isolation, room SQLite, room scratch storage, bounded structured logs, immutable assets, host-owned realtime sockets, canonical accounts, Google/GitHub OAuth flows, browser sessions, browser-authorized multi-key SSH linking, durable room memberships, hashed invitations, host-enforced chat/clanker policies, a constrained room shell, virtual SFTP source access, and scoped WebDAV mounts are implemented. Real OAuth buttons appear when provider credentials are configured. Per-user source overlays, clanker credential issuance, outbound fetch, account recovery, and broader user-facing credential/membership management are not yet wired.

The prototype enforces 128 aggregate live SSH/browser connections, 100 service WebSockets and 32 concurrent HTTP executions per room, plus process-wide ceilings of 4,096 service WebSockets and 256 service executions. Guest realtime fanout is bounded per execution. Adaptive per-principal or per-address token buckets additionally cover every public protocol and costly chat action; repeated violations receive exponentially longer cooldowns. These buckets are shared across reconnects within one server process and remain bounded in memory. Browser WebSockets require a matching origin and realtime envelopes carry opaque host-derived client identity. The exact policies and the horizontal-scaling boundary are documented in [`rate-limits.md`](rate-limits.md).
