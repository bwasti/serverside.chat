# Abuse limits and backoff

One host-owned `AdaptiveRateLimiter` covers the public HTTP server, browser and room WebSockets, SSH connection/auth/session setup, TUI input, chat and commands, explicit clanker work, the capability shell, and SFTP. WebDAV also crosses the HTTP gate before its scoped credential is evaluated. Room code cannot inspect, relax, or reset these controls.

Authenticated traffic is not unlimited. It receives a larger interactive burst, then a finite refill rate. Anonymous traffic is keyed by the host-derived client address and is deliberately tighter; authenticated traffic is keyed by the canonical account wherever that identity is available. Reconnecting does not create a fresh bucket. On each over-limit attempt, cooldown doubles up to the listed ceiling. Sustained well-behaved traffic refills tokens and gradually clears strikes.

| Surface | Burst | Sustained refill | First cooldown | Maximum cooldown |
| --- | ---: | ---: | ---: | ---: |
| Anonymous HTTP | 30 | 1 per 2s | 2s | 5m |
| Authenticated HTTP / WebDAV | 120 | 2 per second | 1s | 1m |
| Anonymous socket or TUI input | 30 | 15 per second | 5s | 5m |
| Authenticated socket or TUI input | 80 | 40 per second | 1s | 1m |
| Anonymous lobby chat | 2 | 1 per 30s | 30s | 15m |
| Authenticated chat | 8 | 1 per 3s | 3s | 2m |
| Authenticated host commands | 12 | 1 per second | 1s | 1m |
| Clanker requests | 2 | 1 per 30s | 30s | 10m |
| SSH connection, auth, or session setup | 10 | 1 per 15s | 15s | 10m |
| Capability-shell or SFTP operations | 120 | 30 per second | 1s | 1m |

These are inner budgets. Existing outer bounds still apply: anonymous lobby posts also pass the 600-byte, per-minute, per-hour, global, concurrency, and fail-closed clanker moderation gate; WebSockets retain per-connection frame and origin checks; rooms retain connection, concurrency, hourly egress, database, filesystem, file-size, log, and realtime-publish quotas; the host process caps aggregate service executions and sockets; authentication endpoints retain their account-creation and OAuth-attempt ceilings. Chunked and declared request bodies are cancelled at their byte ceilings rather than buffered without limit.

HTTP rejections use status `429` and `Retry-After`. Interactive interfaces show a short retry message; abusive WebSockets may close with code `1013`. A rejected chat submission stays in the composer so the user can retry rather than losing work.

## Deployment boundary

Adaptive bucket state is intentionally in process for the current single application instance. It survives reconnects but resets on a service restart. Before running multiple application replicas, move the bucket and cooldown counters to a shared atomic store (for example Redis) and key anonymous identities from a trusted proxy-supplied address. The existing durable audit log is not a rate-limit datastore.
