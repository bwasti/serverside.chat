# Identity, permissions, and capability accounting

The durable security context for every invocation is:

```text
room identity × immutable deployment commit × authenticated principal
```

The room identity selects the SQLite database, scratch filesystem, realtime topic, quotas, and repository. The commit selects immutable `worker.js` and assets. The authenticated principal selects role and spend authority. None of these values may come from guest JavaScript, URL parameters, SQL, filesystem paths, or WebSocket payloads.

## Implemented room roles

- `owner`: manage invitations and room policy; contribute under member/admin policy; exclusively authorize canonical promotion.
- `admin`: manage invitations and room policy; contribute under member/admin policy; cannot promote canonical.
- `contributor`: chat and invoke the agent when contribution and agent policies allow it.
- `viewer`: read a visible room; no chat or agent authority.
- `anonymous`: browse public rooms and pages; no durable chat, typing presence, or agent visibility.

Canonical promotion is owner-only and is granted to the agent only during an explicit owner `/agent` invocation. Passive transcript text never supplies promotion authority. A stronger future approval should be signed, expiring, and bound to the exact room and candidate commit.

## Browser and socket identity

SSH public-key signatures are verified and mapped to persistent users. Unknown verified keys receive anonymous authority and can bind themselves to a new account using a one-use, hashed, expiring room invite. The requested SSH username is never used as proof of identity.

HTTP and WebSocket requests currently receive anonymous authority. Public pages and sockets are available; private rooms return 404, and existing anonymous sockets are closed if a room becomes private. Production sessions should use a host-issued Secure, HttpOnly, SameSite cookie after Google/Apple login. WebSocket upgrades must inherit and validate that session before joining a room topic.

## Outbound network accounting

Network policy and counters live in the host. Each operation is charged to `(room, principal)` for request bytes, response bytes, calls, concurrency, and wall time. Service-wide ceilings provide a second bound. Owner-approved agents receive their own principal and budget, so one collaborator cannot silently spend another collaborator's allowance.

Before outbound fetch is enabled, the host must enforce HTTPS, permitted ports, DNS resolution and revalidation, private/link-local/loopback/cloud-metadata denial, redirect limits, decompressed-response limits, header filtering, timeouts, and audit logs. The worker receives no raw socket capability.

## Current state

QuickJS Wasm isolation, room SQLite, room scratch storage, bounded structured logs, immutable assets, host-owned realtime sockets, SSH public-key identities, durable room memberships, hashed invitations, and host-enforced chat/agent policies are implemented. The database also reserves records for provider identities, web sessions, scoped agent credentials, and audit events. Google/Apple login, authenticated HTTP/socket sessions, agent credential issuance, outbound fetch, account recovery, and user-facing membership management are not yet wired. Until those land, the service should remain on a trusted network and outbound internet access stays disabled.

The prototype currently enforces 128 aggregate live SSH/browser connections, 100 WebSockets, 32 concurrent HTTP executions, and 64 MiB of response egress per rolling hour per room. These room-wide limits will become outer ceilings once authenticated per-principal sub-budgets are implemented.
