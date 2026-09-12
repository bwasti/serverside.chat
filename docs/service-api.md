# Room Service API v0

Each immutable deployment supplies `worker.js`. The host starts a fresh QuickJS Wasm runtime for every HTTP request and evaluates the selected commit inside it. JavaScript receives no Node.js, Bun, shell, filesystem, environment, socket, module-loading, or direct SQLite access.

```js
export default {
  async fetch(request, env) {
    return new Response("Hello", { status: 200 });
  },
};
```

## Request

`request.method`, `request.url`, `request.path`, `request.headers`, and the bounded body string are available. `await request.text()` returns the body and `await request.json()` parses it. Bodies are limited to 64 KiB. A request for `https://hello-world.serverside.chat/api/items` reaches that room's worker as `/api/items`. The host consumes only `__ref`; other paths and query parameters belong to the service. Room sites have isolated origins and may use their own host-only cookies or authorization headers. The host strips proxy identity headers, rejects parent-domain cookies, and never forwards serverside.chat control-plane credentials through the legacy path route.

## Response

Return `new Response(body, { status, headers })`, `Response.json(value, init)`, or a plain `{ status, headers, body }` record. Status must be 100–599, header names and values are validated, and response bodies are limited to 512 KiB. Streaming is intentionally absent in v0.

## `env.db`

`env.db` is an opaque handle to one host-selected SQLite database per room. Guest code never supplies a tenant ID or filename. The database persists across fresh request isolates and deployments.

```js
env.db.exec("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
env.db.prepare("INSERT INTO posts(title) VALUES (?)").run(title);
const posts = env.db.prepare("SELECT id, title FROM posts ORDER BY id DESC LIMIT ?").all(20);
const post = env.db.prepare("SELECT id, title FROM posts WHERE id = ?").get(id);
const sameRows = env.db.query("SELECT id, title FROM posts LIMIT ?", [20]);
```

Parameters must be scalar strings, finite numbers, booleans, or null. Use parameters for values; never concatenate user input into SQL. One statement is allowed per call. v0 permits `SELECT`, `WITH`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, and `CREATE INDEX`. It rejects `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, extension loading, schema destruction, and other administrative operations. Results are capped at 200 rows and 256 KiB. Each room database is capped at 5 MiB.

## `env.fs`

`env.fs` is persistent room-scoped scratch storage, separate from immutable deployment assets and Git history.

```js
env.fs.writeText("cache/result.json", JSON.stringify(result));
const result = JSON.parse(env.fs.readText("cache/result.json"));
const files = env.fs.list(); // [{ path, bytes }]
env.fs.delete("cache/result.json");
```

Paths are always relative to an opaque room root. Traversal, absolute paths, symlinks, and ambient host paths are forbidden. Storage is capped at 5 MiB, 1,000 files, and 512 KiB per text file. Binary files and directory mutation are intentionally absent in v0.

## `env.assets`

`await env.assets.fetch(request)` reads a file from the same immutable deployment. `/` maps to `index.html`. Paths remain repository-relative and inherit the repository's traversal, symlink, file-size, and commit-selection protections.

Missing files, directories, invalid deployment paths, and protected paths such as `.git` return a plain `404 Not found` response; they do not throw into the worker or become platform 500s. The host records 4xx traffic in the live request log but only 5xx responses increment the health-row error counter.

## `env.log`

Use `env.log.info(event, fields)`, `.warn`, or `.error`. `env.log(event, fields)` is an alias for info. Events must be structured and must not include secrets or sensitive bodies. The host accepts at most 20 events and 4 KiB per event per request. Host request/error/latency/byte telemetry is always recorded independently and cannot be disabled by guest code.

The host retains the most recent 50 combined request and guest-log entries per room. Individual stored lines are capped at 500 characters. The room agent can inspect them through its read-only `tail_service_logs` tool, which returns at most 50 entries and 16 KiB total. Log content is treated as untrusted data and cannot grant authority or issue agent instructions.

## Realtime/WebSocket

Every HTML response receives a small host-owned client that connects to `/<room>/.well-known/realtime`, reconnects with bounded exponential backoff, exposes the browser WebSocket as `window.roomSocket`, and emits `roomopen`, `roommessage`, and `roomclose` window events.

```js
window.addEventListener("roommessage", event => {
  console.log(event.detail);
});
window.roomSocket.send(JSON.stringify({ kind: "cursor", x: 10, y: 20 }));
```

HTTP handlers can publish to every connected browser in their room:

```js
env.realtime.publish("messages.changed", { id: 42 });
```

The browser receives `{ "type": "messages.changed", "data": { "id": 42 } }`. Client-originated messages are delivered as `{ "type": "client", "data": ... }`. Sockets are host-owned and never expose network handles to QuickJS. v0 permits 100 sockets per room, 16 KiB per message, and 20 client messages per second per socket. The bus is ephemeral; durable state belongs in `env.db`. Authentication and worker-validated inbound event handlers are not implemented yet, so do not use client events as authorization.

## Runtime limits

- Fresh QuickJS Wasm runtime and realm per request
- 16 MiB QuickJS memory limit
- 512 KiB guest stack
- 150 ms guest execution deadline
- 64 KiB request body
- 512 KiB response body
- 5 MiB room database
- 200 database rows and 256 KiB per result
- 100 scalar SQL parameters per operation
- 20 structured guest logs per request
- 100 live sockets per room, 16 KiB per event, 20 inbound events/second/socket
- 128 aggregate live browser/SSH connections per room
- 32 concurrent HTTP executions per room
- 64 MiB response egress per rolling hour per room

This Bun worker is the executable prototype of the API boundary. Production will run the same contract in QuickJS hosted by embedded Wasmtime and add outer worker-process isolation, Wasmtime store limits, and epoch interruption.

## Planned `env.fetch`

Outbound internet access is intentionally disabled in the passwordless prototype. Its contract will be `await env.fetch(url, init)` with HTTPS-only public destinations, manual bounded redirects, DNS/IP checks on every hop, forbidden loopback/private/link-local/metadata ranges, bounded request and response bytes, timeouts, concurrency limits, and no caller-controlled proxy or raw socket. Usage will be charged to the authenticated principal and room from trusted invocation context; guest-provided identity fields will never select a budget. Responses will be buffered and bounded rather than streamed into unmetered guest memory.
