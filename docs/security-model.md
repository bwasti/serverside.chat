# Identity, permissions, and capability accounting

The durable security context for every invocation is:

```text
room identity × immutable deployment commit × authenticated principal
```

The room identity selects the SQLite database, scratch filesystem, realtime topic, quotas, and repository. The commit selects immutable `worker.js` and assets. The authenticated principal selects role and spend authority. None of these values may come from guest JavaScript, URL parameters, SQL, filesystem paths, or WebSocket payloads.

## Proposed room roles

- `owner`: manage invitations and permissions; approve canonical promotion; authorize high-cost capabilities.
- `editor`: chat, run agents, create commits and previews, write service data within policy.
- `viewer`: read chat/site and receive realtime events; no repository mutation or canonical promotion.
- `agent`: a scoped machine identity delegated by an owner/editor, with explicit expiry, repository permissions, and capability budget.

Canonical promotion remains owner-only. A future owner grant should be a signed, expiring approval bound to the exact room and candidate commit—not a phrase copied into chat.

## Browser and socket identity

The current LAN prototype has no real authentication. Production HTTP sessions should use a host-issued, Secure, HttpOnly, SameSite cookie. WebSocket upgrades inherit and validate that session before joining a room topic. Invite tokens should be single-purpose, expiring, revocable, and exchanged for a session rather than retained in URLs.

## Outbound network accounting

Network policy and counters live in the host. Each operation is charged to `(room, principal)` for request bytes, response bytes, calls, concurrency, and wall time. Service-wide ceilings provide a second bound. Owner-approved agents receive their own principal and budget, so one collaborator cannot silently spend another collaborator's allowance.

Before outbound fetch is enabled, the host must enforce HTTPS, permitted ports, DNS resolution and revalidation, private/link-local/loopback/cloud-metadata denial, redirect limits, decompressed-response limits, header filtering, timeouts, and audit logs. The worker receives no raw socket capability.

## Current state

QuickJS Wasm isolation, room SQLite, room scratch storage, bounded structured logs, immutable assets, and host-owned realtime sockets are implemented. Authentication, signed invitations, roles on HTTP requests, agent credentials, authenticated socket upgrades, and outbound fetch are not. Until those land, the service must remain on a trusted network and outbound internet access stays disabled.
