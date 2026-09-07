# wasm-chat

The executable room-service contract is documented in [`docs/service-api.md`](docs/service-api.md). Identity, roles, and capability accounting are specified in [`docs/security-model.md`](docs/security-model.md).

An early SSH/TUI prototype for chat rooms backed by tiny Wasm services and a room-scoped AI agent.

This slice implements the frontend seam: seeded in-memory rooms, a passwordless development SSH server, multi-client chat, a visible stub agent, and a host-side HTTP scaffold serving a default page for every room. The QuickJS/Wasmtime runtime, SQLite storage, version control, persistence, invitations, and real model adapter are the next layer—not silently simulated here.

## Run it

Requirements: Bun and `ssh-keygen`.

```sh
bun install
bun run start
```

In another terminal:

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost -p 2222
```

The SSH username becomes your chat name. To pick one explicitly:

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null alice@localhost -p 2222
```

Commands inside the room:

- `/agent status` asks the room agent for its current status
- `/help` shows the agent hint
- `/quit` disconnects
- `Ctrl-C` or `Ctrl-D` disconnects

Configuration is via `HOST` (default `127.0.0.1`), `PORT` (default `2222`), `DATA_DIR` (default `.data`), and `WEB_BASE_URL` (default `http://localhost:3000`). The server creates an Ed25519 host key on first launch. Room page URLs are OSC 8 links; supported terminals let you open them with the usual modifier-click gesture.

The SSH server binds to `HOST` (default `0.0.0.0`) so it is reachable on the local network; set `HOST=127.0.0.1` to restrict it to this machine. The HTTP scaffold binds to `WEB_HOST` (default `HOST`) and `WEB_PORT` (default `3000`). Advertised room links use `WEB_BASE_URL`, defaulting to `http://Brams-MacBook-Air.local:3000`. On terminals at least 100 columns wide, the right HUD displays host-owned request counts, errors, latency, response bytes, recent access logs, uptime, connected users, and agent activity. Room code cannot disable this telemetry. Development authentication is passwordless, so do not expose these ports beyond a trusted network.

## Room agent

Set `FIREWORKS_API_KEY` to enable the real room agent. It uses `accounts/fireworks/models/glm-5p3-flash` by default; override that with `FIREWORKS_MODEL`. Agent requests are serialized per room and include the latest 30 non-system transcript messages.

Each room has an isolated Git repository under `.data/rooms/<room>/repo`. The agent can operate across the complete working tree through bounded file and predefined Git tools, but receives no shell access and cannot inspect `.git` internals. Working-tree files are capped at 512 KiB each and 5 MiB total.

The canonical service is selected by `/<room>` and everything after that prefix belongs to its generic request handler. Human-facing deployment shorthand is `room`/`room#stable` for canonical, `room#head` for repository HEAD, and `room#commit` for a preview. Hyperlinks encode the selector using the host-reserved `__ref` query because fragments never reach HTTP servers. The repository's movable `stable` Git tag mirrors the activated commit. Promoting a preview requires an explicit human request in chat.

Every canonical promotion is also recorded as a host-generated `trunk` system message in room chat with its commit and canonical URL.

Canonical history is strictly linear: promotion must be a fast-forward from `stable`, and the candidate range cannot contain merge commits. Feature branches must rebase onto `stable`; the agent has no merge operation.

Every valid abbreviated or full commit hash in the room repository is lazily servable with `?__ref=<commit>`; it does not need a registered preview. Registered previews add a durable description and a row in the top deployment bar. The agent can archive a feature preview to remove that row without deleting its commit or direct URL. On rebase conflicts, the agent can inspect and edit conflicted files, continue until resolved, and then posts the resulting preview to chat for human feedback.

The agent passively observes authenticated room chat and may respond, act, or remain silent. Its reviewable prompts live in [`prompts/room-agent/`](prompts/room-agent/). Routine thinking and tool activity appear in the right-side HUD instead of generating chat messages.

## Security boundary (prototype)

Authentication currently accepts every SSH connection. Keep the default loopback bind. Before exposing it, add invite/public-key authentication, connection and message rate limits, durable room membership, agent authorization rules, and resource accounting. User service code is not executed in this prototype.
