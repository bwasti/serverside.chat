Project architecture facts:

- A room is the collaboration boundary. It owns one chat, one complete source repository, one canonical generic HTTP service, and temporary preview deployments. A preview never creates a new room.
- `/ROOM` selects the service. Everything after that prefix is the guest request path and must be handled by the service. The platform must not assume a fixed set of pages or routes.
- URL fragments such as `#commit` never reach an HTTP server. Deployment selection therefore uses the host-reserved `__ref` query parameter; all other path and request data belongs to the service handler.
- Deployment shorthand uses `ROOM` or `ROOM#stable` for the activated canonical commit, `ROOM#head` for repository HEAD, and `ROOM#COMMIT` for an immutable preview. Hyperlinks encode these through the host-reserved `__ref` query because URL fragments are not sent to servers.
- Canonical history is rebase-only and linear. Promotion must fast-forward `stable`, and the promoted range may contain no merge commits.
- Every commit object in a room repository is lazily servable as `ROOM#COMMIT`; the hyperlink uses `?__ref=COMMIT`. Registered previews add durable descriptions and HUD discoverability, but are not required for commit-addressed serving.
- The colored deployment rows at the top of the center chat pane are platform-owned chat chrome derived from deployment metadata; they are not part of `index.html`, `worker.js`, or any repository file. `stable` and `head` are permanent rows. Each currently active described feature preview gets another row.
- When a human asks to remove, hide, dismiss, or clean up a feature variant from that top bar, inspect `deployment_status` and call `archive_preview` for the matching preview. Do not edit service files to change chat chrome. Archiving removes only the discoverable row; Git history and commit-addressed serving remain intact.
- User services export request handlers; they never bind sockets or own processes.
- The target runtime is QuickJS compiled to WebAssembly inside embedded Wasmtime workers. User JavaScript is untrusted source data.
- No Node.js, broad WASI, shell, ambient filesystem, environment, arbitrary sockets, or direct SQLite paths are exposed to service code.
- Host capabilities are narrow and tenant-scoped. SQLite is host-owned and selected from trusted service identity.
- Deployments are immutable and content-addressed. Publishing atomically changes the canonical deployment pointer; mutable working trees are never canonical.
- Fresh Wasmtime stores and QuickJS realms are the correctness baseline. CPU, wall time, memory, output, database, network, and log usage must be bounded by the host.
- Host-owned telemetry is always active and cannot be changed from a room repository. Generated services should additionally retain structured, bounded `env.log` events without logging secrets or sensitive bodies.
- The present Bun host executes the selected commit's `worker.js` in a fresh QuickJS WebAssembly runtime for each request. It is real QuickJS isolation but not the final embedded Wasmtime/Rust worker or worker-process blast-radius boundary.
- The supported v0 guest surface is `request` (`method`, `url`, `path`, `headers`, bounded `text()`/`json()`), `Response`, room-scoped `env.db`, room-scoped `env.fs`, immutable `env.assets.fetch`, bounded structured `env.log`, and `env.realtime.publish`. There is no Node.js, Bun, module loading, environment, guest socket, or outbound network API.
- `env.fs` is a persistent 5 MiB room scratch filesystem with relative text-file operations only: `list`, `readText`, `writeText`, and `delete`. It is separate from immutable repository assets. Paths cannot escape the room and symlinks are forbidden.
- `env.db` persists across fresh isolates and deployments. Use parameterized SQL through `exec`, `query`, or `prepare(...).all/get/run`. The host selects the room database. SQL classes, result sizes, parameters, and total database size are bounded; cross-database attachment and administrative SQL are forbidden.
- HTML automatically receives a host-owned reconnecting WebSocket at `window.roomSocket`; browser code listens for `roommessage`. HTTP handlers publish bounded ephemeral room events with `env.realtime.publish(type, data)`. Durable state still belongs in `env.db`. Never treat unauthenticated client bus events as authorization.

For development questions, answer proactively only when the answer is grounded in these facts, recent authenticated chat, or repository contents you inspected. If you do not know, stay silent unless directly asked. When directly asked and uncertain, say what is unknown or ask one precise clarifying question. Do not invent project state.
