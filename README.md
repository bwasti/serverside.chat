# serverside.chat

The executable room-service contract is documented in [`docs/service-api.md`](docs/service-api.md). The implemented account and room policy model is in [`docs/accounts.md`](docs/accounts.md); its security boundary is described in [`docs/security-model.md`](docs/security-model.md).

The versioned systemd deployment layout and release procedure are documented in [`docs/deployment.md`](docs/deployment.md).

An early SSH/TUI prototype for chat rooms backed by tiny Wasm services and a room-scoped AI agent.

This prototype has one shared TUI over SSH and HTTPS, persistent multi-client rooms, canonical server accounts with OAuth/cookie/SSH credentials, invitations, a QuickJS-Wasm service runtime, room-scoped SQLite and scratch storage, Git-backed deployments and previews, host-owned telemetry/realtime sockets, and an optional Fireworks room agent.

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

The browser version is served at `/`. It uses the self-hosted open-source xterm.js renderer over a host-owned WebSocket and feeds the same `TuiSession` as SSH; it does not start or expose a system shell. Anonymous sessions are read-only. The blue **sign in** text in the composer is a real link. Google and GitHub OAuth create or resolve the canonical account and issue a Secure, HttpOnly session cookie. Until provider credentials are configured, a conspicuously labeled development flow creates a temporary account for testing.

SSH can also deep-link into a room or redeem an invitation before opening the TUI:

```sh
ssh -t -p 2222 serverside.chat room mine
ssh -t -p 2222 serverside.chat invite '<one-use-token>'
```

The remote command parser accepts only these two bounded forms; it cannot execute shell commands. For an existing account, the invite form grants membership and opens the room. For a new SSH key, it displays a short-lived HTTPS sign-in link; OAuth creates the canonical account, the browser attaches the verified key and consumes the invite, and the live terminal upgrades without reconnecting. Quote the token and remember that the local shell may retain the command in its history; successful tokens are single-use.

Known public keys resolve to durable accounts. On first run, public keys in `~/.ssh/*.pub` are enrolled to the local room owner as a prototype migration path. An unknown but valid key enters public rooms as an anonymous browse-only principal and receives an HTTPS account/link URL; its requested SSH username has no authority.

Commands inside the room:

- `/agent <request>` explicitly invokes the agent when room policy permits it
- `/invite admin|contributor|viewer` creates a one-use 24-hour invite (admin only)
- `/redeem <invite>` grants an invitation to the signed-in canonical account
- `/permissions` shows the current room policy
- `/permissions visibility public|private`
- `/permissions contributions members|admins|disabled`
- `/permissions agent passive|explicit|disabled`
- `/quit` disconnects
- `Ctrl-C` or `Ctrl-D` disconnects

Configuration is via `HOST` (default `0.0.0.0`), `PORT` (default `2222`), `DATA_DIR` (default `.data`), `WEB_BASE_URL` (default `http://Brams-MacBook-Air.local:3000`), optional colon-delimited `SSH_BOOTSTRAP_KEYS`, and optional `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Set `DEVELOPMENT_AUTH=false` after real providers are configured. Production callbacks are `https://serverside.chat/_auth/google/callback` and `https://serverside.chat/_auth/github/callback`. The server creates an Ed25519 host key on first launch. Room and sign-in URLs are OSC 8 links; supported terminals let you open them with the usual modifier-click gesture.

The SSH server binds to `HOST` so it is reachable on the local network; set `HOST=127.0.0.1` to restrict it to this machine. The HTTP service binds to `WEB_HOST` (default `HOST`) and `WEB_PORT` (default `3000`). The droplet deployment binds that application HTTP port to loopback and publishes it through Caddy with automatic HTTPS and WebSocket proxying. On wide terminals, the right HUD displays the version graph; host-owned health, usage, limits, and agent activity remain in the persistent top status area. Room code cannot disable this telemetry. Per-account rate limits, recovery, and user-facing credential management are not complete.

Seeded policies are intentionally varied: `mine` is public with member contributions and a passive agent; `general` is public with member contributions and explicit `/agent` invocation; `build-log` is private, admin-write, and has no agent.

## Room agent

Set `FIREWORKS_API_KEY` to enable the real room agent. It uses `accounts/fireworks/models/glm-5p3-flash` by default; override that with `FIREWORKS_MODEL`. Agent requests are serialized per room and include the latest 30 non-system transcript messages.

Each room has an isolated Git repository under `.data/rooms/<room>/repo`. The agent can operate across the complete working tree through bounded file and predefined Git tools, but receives no shell access and cannot inspect `.git` internals. Working-tree files are capped at 512 KiB each and 5 MiB total.

The canonical service is selected by `/<room>` and everything after that prefix belongs to its generic request handler. Human-facing deployment shorthand is `room`/`room#stable` for canonical, `room#head` for repository HEAD, and `room#commit` for a preview. Hyperlinks encode the selector using the host-reserved `__ref` query because fragments never reach HTTP servers. The repository's movable `stable` Git tag mirrors the activated commit. Promoting a preview requires an explicit human request in chat.

Every canonical promotion is also recorded as a host-generated `trunk` system message in room chat with its commit and canonical URL.

Canonical history is strictly linear: promotion must be a fast-forward from `stable`, and the candidate range cannot contain merge commits. Feature branches must rebase onto `stable`; the agent has no merge operation.

Every valid abbreviated or full commit hash in the room repository is lazily servable with `?__ref=<commit>`; it does not need a registered preview. Registered previews add a durable description and a row in the top deployment bar. The agent can archive a feature preview to remove that row without deleting its commit or direct URL. On rebase conflicts, the agent can inspect and edit conflicted files, continue until resolved, and then posts the resulting preview to chat for human feedback.

Depending on room policy, the agent passively observes authenticated contributor chat, responds only to `/agent`, or is disabled. Anonymous text never enters the transcript or agent context. Its reviewable prompts live in [`prompts/room-agent/`](prompts/room-agent/). Routine thinking and tool activity appear in the status UI instead of generating chat messages.

## Security boundary (prototype)

The internal user ID is the authority-bearing account. Google/GitHub subjects, browser session cookies, and SSH public keys are credentials that resolve to it; handles are display labels only. SSH accepts only a valid public-key signature, and a new key must be linked from a signed-in browser before it gains account authority. Visibility, contribution, agent access, administration, and canonical promotion are checked host-side.
