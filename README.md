# serverside.chat

The executable room-service contract is documented in [`docs/service-api.md`](docs/service-api.md). The constrained SSH editing environment and virtual SFTP filesystem are documented in [`docs/capability-shell.md`](docs/capability-shell.md). The implemented account and room policy model is in [`docs/accounts.md`](docs/accounts.md); its security boundary is described in [`docs/security-model.md`](docs/security-model.md).

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

The browser version is served at `/`. Both browser and SSH sessions open in the public `lobby`: a deliberately sparse landing chat with navigation hints and a terse, documentation-only guide agent. Press Tab to expand the room list, use Up/Down to choose, and press Enter to open a room. Accounts with available quota see `+ new room` above the room list; selecting it opens a keyboard-only setup form for the name, visibility, contribution policy, and agent mode. Its explicit defaults are public, member contributions, and a passive agent. The browser uses the self-hosted open-source xterm.js renderer over a host-owned WebSocket and feeds the same `TuiSession` as SSH; it does not start or expose a system shell. Anonymous sessions may write only in the lobby through the bounded moderation gate described below; other contributions require sign-in. The blue **sign in** text remains a real link. Google and GitHub OAuth create or resolve the canonical account and issue a Secure, HttpOnly session cookie. Until provider credentials are configured, a conspicuously labeled development flow creates a temporary account for testing.

SSH can also deep-link into a room or redeem an invitation before opening the TUI:

```sh
ssh -t -p 2222 serverside.chat room mine
ssh -t -p 2222 serverside.chat invite '<one-use-token>'
```

Authenticated contributors can instead enter the room's constrained editing environment. This is a capability shell, not a system shell: it has familiar room-relative commands such as `pwd`, `cd`, `ls`, `tree`, `cat`, `head`, `tail`, `touch`, and `cp`, plus predefined commit, preview, rebase, and owner-only publish operations, but cannot run programs. `edit <path>` opens a Wasm-backed syntax-colored editor; `/edit <path>` opens the same editor inside either browser or SSH chat. `Ctrl-S` saves and `Ctrl-P` creates a commit and immutable preview. The same endpoint serves a virtual SFTP filesystem for normal local editors:

```sh
ssh -t -p 2222 serverside.chat shell mine
sftp -P 2222 serverside.chat
sshfs -p 2222 serverside.chat:/mine ./mine
```

The virtual root lists only visible rooms, applies room contribution policy to writes, and never exposes host paths or `.git`. See [`docs/capability-shell.md`](docs/capability-shell.md) for commands, quotas, and the current shared-worktree limitation.

An existing bootstrap account can attach its first canonical OAuth identity with:

```sh
ssh -p 2222 serverside.chat account
```

Open the returned ten-minute HTTPS link and choose Google or GitHub. This migration command does not open a shell.

The remote command parser accepts only the bounded `account`, `room <name>`, `shell <name>`, and `invite <token>` forms. `shell` selects our constrained interpreter; none of these forms can execute an operating-system command. For an existing account, the invite form grants membership and opens the room. For a new SSH key, it displays a short-lived HTTPS sign-in link; OAuth creates the canonical account, the browser attaches the verified key and consumes the invite, and the live terminal upgrades without reconnecting. Quote the token and remember that the local shell may retain the command in its history; successful tokens are single-use.

Known public keys resolve to durable accounts. On first run, public keys in `~/.ssh/*.pub` are enrolled to the local room owner as a prototype migration path. An unknown but valid key enters public rooms as an anonymous principal and receives an HTTPS account/link URL; its requested SSH username has no authority. It can browse public rooms and use the moderated lobby, but cannot contribute elsewhere.

Commands inside the room:

- `/account` shows the canonical handle, site role, plan, and owned-room usage
- `/room create <name>` creates and enters an owned room
- `/room rename <name>` renames the current room (owner or site admin)
- `/room delete <current-name>` recoverably deletes the current room (owner or site admin; the exact name is required)
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

The SSH server binds to `HOST` so it is reachable on the local network; set `HOST=127.0.0.1` to restrict it to this machine. The HTTP service binds to `WEB_HOST` (default `HOST`) and `WEB_PORT` (default `3000`). The droplet deployment binds that application HTTP port to loopback and publishes it through Caddy with automatic HTTPS and WebSocket proxying. On wide terminals, the right HUD displays the version graph and a live service-log tail; host-owned health, usage, limits, and agent activity remain in the persistent top status area. Room code cannot disable this telemetry. Per-account rate limits, recovery, and user-facing credential management are not complete.

Every authenticated account gets an owned starter room and contributor access to the host-managed lobby. The lobby is quota-free and cannot be renamed, deleted, or reconfigured by users. Free accounts may own five normal rooms. The schema reserves a `pro` plan with a larger room allowance for later product work, but no billing or upgrade path is enabled. The configured bootstrap owner is the initial site admin and may manage up to 100 rooms; all room creation is bounded.

Seeded policies are intentionally varied: `mine` is public with member contributions and a passive agent; `general` is public with member contributions and explicit `/agent` invocation; `build-log` is private, admin-write, and has no agent.

## Room agent

Set `FIREWORKS_API_KEY` to enable the real room agent. It uses `accounts/fireworks/models/glm-5p3-flash` by default; override that with `FIREWORKS_MODEL`. Agent requests are serialized per room and include the latest 30 non-system transcript messages.

Each room has an isolated Git repository under `.data/rooms/<room>/repo`. The agent can operate across the complete working tree through bounded file and predefined Git tools, but receives no shell access and cannot inspect `.git` internals. Working-tree files are capped at 512 KiB each and 5 MiB total.

The canonical service is selected by `/<room>` and everything after that prefix belongs to its generic request handler. Human-facing deployment shorthand is `room`/`room#stable` for canonical, `room#head` for repository HEAD, and `room#commit` for a preview. Hyperlinks encode the selector using the host-reserved `__ref` query because fragments never reach HTTP servers. The repository's movable `stable` Git tag mirrors the activated commit. Promoting a preview requires an explicit human request in chat.

Every canonical promotion is also recorded as a host-generated `trunk` system message in room chat with its commit and canonical URL.

Canonical history is strictly linear: promotion must be a fast-forward from `stable`, and the candidate range cannot contain merge commits. Feature branches must rebase onto `stable`; the agent has no merge operation.

Every valid abbreviated or full commit hash in the room repository is lazily servable with `?__ref=<commit>`; it does not need a registered preview. Registered previews add a durable description and a row in the top deployment bar. The agent can archive a feature preview to remove that row without deleting its commit or direct URL. On rebase conflicts, the agent can inspect and edit conflicted files, continue until resolved, and then posts the resulting preview to chat for human feedback.

Depending on room policy, the agent passively observes authenticated contributor chat, responds only to `/agent`, or is disabled. Anonymous text never enters a normal-room transcript or builder-agent context. The sole exception is the system lobby: anonymous messages are capped at 600 bytes, limited to 3 per identity per minute and 12 per hour plus global ceilings, and must receive an `ALLOW` decision from a separate AI moderation call before persistence or guide visibility. Moderation errors fail closed. Normal-room prompts live in [`prompts/room-agent/`](prompts/room-agent/). The separate [`prompts/lobby-agent/`](prompts/lobby-agent/) guide has no code or deployment tools and only answers questions about using the product; its admission filter lives in [`prompts/lobby-moderator/`](prompts/lobby-moderator/). Routine thinking and tool activity appear in the status UI instead of generating chat messages.

## Security boundary (prototype)

The internal user ID is the authority-bearing account. Google/GitHub subjects, browser session cookies, and SSH public keys are credentials that resolve to it; handles are display labels only. SSH accepts only a valid public-key signature, and a new key must be linked from a signed-in browser before it gains account authority. Visibility, contribution, agent access, administration, and canonical promotion are checked host-side.
