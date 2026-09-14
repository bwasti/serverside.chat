# serverside.chat

The executable room-service contract is documented in [`docs/service-api.md`](docs/service-api.md). The constrained SSH editing environment and virtual SFTP filesystem are documented in [`docs/capability-shell.md`](docs/capability-shell.md). The implemented account and room policy model is in [`docs/accounts.md`](docs/accounts.md); its security boundary is described in [`docs/security-model.md`](docs/security-model.md), including the concrete abuse limits in [`docs/rate-limits.md`](docs/rate-limits.md).

The versioned systemd deployment layout and release procedure are documented in [`docs/deployment.md`](docs/deployment.md).

An early SSH/TUI prototype for chat rooms backed by tiny Wasm services and a room-scoped clanker.

This prototype has one shared TUI over SSH and HTTPS, persistent multi-client rooms, canonical server accounts with OAuth/cookie/SSH credentials, invitations, a QuickJS-Wasm service runtime, room-scoped SQLite and scratch storage, Git-backed deployments and previews, host-owned telemetry/realtime sockets, and an optional Fireworks room clanker.

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

The browser version is served at `/`. Both browser and SSH sessions open in the public `lobby`: a deliberately sparse landing chat with a terse, documentation-only lobby clanker. The lobby has no hard-coded guide panel; room admins can pin a guide message above the transcript instead. Press Tab to expand the room list, use Up/Down to choose, and press Enter to open a room. Authenticated users can hold Shift with Up/Down to persist a personal room order; another account keeps its own ordering. Shift-Enter opens keyboard-only room policy settings when the selected account has room-admin authority. From an empty composer, Up selects the newest message and continues backward; Enter starts a reply, P lets a room or site admin pin or unpin it, and Delete asks an admin to confirm moderation. Pins are durable, host-owned room state, limited to five per room, and may also be changed by the clanker when an authorized requester explicitly asks. The chat composer uses a `›` prompt and shows `type / to see commands` while empty. Typing `/` opens a prefix-filtered command palette immediately above it; Up/Down cycles through matches, and Enter runs a complete command or expands one that needs arguments. The bottom `@handle` row opens account settings: anonymous users can sign in, while authenticated users can inspect account limits and linked credentials, update their display name, or attach another OAuth identity. Accounts with available quota see `+ new room` above the room list; selecting it opens a keyboard-only setup form for the name, visibility, contribution policy, and clanker mode. Its explicit defaults are public, member contributions, and a passive clanker. The browser uses the self-hosted open-source xterm.js renderer over a host-owned WebSocket and feeds the same `TuiSession` as SSH; it does not start or expose a system shell. Browser sessions leave terminal mouse capture disabled so normal drag selection and copy work, while JavaScript forwards wheel gestures to chat history. Its supplemental Tab/arrow strip is enabled only on detected mobile devices. The browser terminal, account overlay, SSH TUI, capability shell, and editor use the same Zenburn color family. Anonymous sessions may write only in the lobby through the bounded moderation gate described below; other contributions require sign-in. The cyan **sign in** text remains a real link. Google and GitHub OAuth create or resolve the canonical account and issue a Secure, HttpOnly session cookie. Until provider credentials are configured, a conspicuously labeled development flow creates a temporary account for testing.

SSH can also deep-link into a room or redeem an invitation before opening the TUI:

```sh
ssh -t -p 2222 serverside.chat room mine
ssh -t -p 2222 serverside.chat invite '<one-use-token>'
```

Authenticated contributors can instead enter the room's constrained editing environment. This is a capability shell, not a system shell: it has familiar room-relative commands such as `pwd`, `cd`, `ls`, `tree`, `cat`, `head`, `tail`, `touch`, and `cp`, plus predefined commit, preview, rebase, and owner-only publish operations, but cannot run programs. `edit <path>` opens a Wasm-backed syntax-colored editor; `/edit <path>` opens the same editor inside either browser or SSH chat. `Ctrl-S` saves and `Ctrl-P` creates a commit and immutable preview. The same endpoint serves a virtual SFTP filesystem for normal local editors:

```sh
ssh -t -p 2222 serverside.chat shell mine
sftp -P 2222 serverside.chat
sshfs -p 2222 serverside.chat:/hello-world ./hello-world
```

The virtual root lists only visible rooms, applies room contribution policy to writes, and never exposes host paths or `.git`. In a normal room, `/mount` opens a private instruction screen for built-in SFTP, SSHFS, and Finder's built-in WebDAV mount; `/mount revoke` disables that room's Finder credential. See [`docs/capability-shell.md`](docs/capability-shell.md) for commands, quotas, and the current shared-worktree limitation.

An existing bootstrap account can attach its first canonical OAuth identity with:

```sh
ssh -p 2222 serverside.chat account
```

Open the returned ten-minute HTTPS link and choose Google or GitHub. This migration command does not open a shell.

The remote command parser accepts only the bounded `account`, `room <name>`, `shell <name>`, and `invite <token>` forms. `shell` selects our constrained interpreter; none of these forms can execute an operating-system command. For an existing account, the invite form grants membership and opens the room. For a new SSH key, it displays a short-lived HTTPS sign-in link; OAuth creates the canonical account, the browser attaches the verified key and consumes the invite, and the live terminal upgrades without reconnecting. Quote the token and remember that the local shell may retain the command in its history; successful tokens are single-use.

Known public keys resolve to durable accounts. On first run, public keys in `~/.ssh/*.pub` are enrolled to the local room owner as a prototype migration path. An unknown but valid key enters public rooms as an anonymous principal and receives an HTTPS account/link URL; its requested SSH username has no authority. It can browse public rooms and use the moderated lobby, but cannot contribute elsewhere.

Commands inside the room:

- `/account` shows the canonical handle, site role, plan, and owned-room usage
- `/mount` shows SFTP, SSHFS, and Finder WebDAV setup; `/mount revoke` disables the Finder credential
- `/room create <name>` creates and enters an owned room
- `/room rename <name>` renames the current room (owner or site admin)
- `/room delete <current-name>` archives the current room after its full exact name is supplied (owner or site admin)
- `/room archives` lists restorable archives; `/room restore <name>` restores the latest archive with that name
- `/clanker <request>` explicitly invokes the clanker when room policy permits it
- `/invite` creates a one-use 24-hour contributor link (admin only); `/invite admin` and `/invite viewer` override its role
- `/redeem <invite>` grants an invitation to the signed-in canonical account
- `/permissions` shows the current room policy
- `/permissions visibility public|private`
- `/permissions contributions members|admins|disabled`
- `/permissions clanker passive|explicit|disabled`
- `/quit` disconnects
- `Ctrl-C` or `Ctrl-D` disconnects

Configuration is via `HOST` (default `0.0.0.0`), `PORT` (default `2222`), `DATA_DIR` (default `.data`), `WEB_BASE_URL` (the trusted chat/control origin), optional `ROOM_SITE_DOMAIN` (the DNS suffix for isolated room sites), optional colon-delimited `SSH_BOOTSTRAP_KEYS`, and optional `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Set `DEVELOPMENT_AUTH=false` after real providers are configured. Production callbacks are `https://serverside.chat/_auth/google/callback` and `https://serverside.chat/_auth/github/callback`. The server creates an Ed25519 host key on first launch. Room and sign-in URLs are OSC 8 links; supported terminals let you open them with the usual modifier-click gesture.

The SSH server binds to `HOST` so it is reachable on the local network; set `HOST=127.0.0.1` to restrict it to this machine. The HTTP service binds to `WEB_HOST` (default `HOST`) and `WEB_PORT` (default `3000`). The droplet deployment binds that application HTTP port to loopback and publishes it through Caddy with automatic HTTPS and WebSocket proxying. Normal rooms keep only a centered URL header and concise health row at the top. Clanker activity appears in the persistent strip above the composer. On wide terminals, the right HUD displays the version graph, dense resource meters, and a live service-log tail. Room code cannot disable this telemetry. Adaptive per-address or per-account limits cover HTTP, WebSockets, TUI input and submissions, SSH setup, capability-shell commands, SFTP operations, and clanker requests; see [`docs/rate-limits.md`](docs/rate-limits.md). Account recovery and broader user-facing credential management are not complete.

The HUD's `FILES` meter includes both the current repository working tree—including `worker.js` and deployed assets—and the separate runtime scratch filesystem. Each pool is independently capped at 5 MiB, so the combined meter has a 10 MiB ceiling.

Every authenticated account gets contributor access to the host-managed lobby and can explicitly create rooms from `+ new room`; signing in never creates one automatically. The lobby is quota-free and cannot be renamed, deleted, or reconfigured by users. Free accounts may own five normal rooms. The schema reserves a `pro` plan with a larger room allowance for later product work, but no billing or upgrade path is enabled. The configured bootstrap owner is the initial site admin and may manage up to 100 rooms; all room creation is bounded.

Fresh installations seed one public development room, `hello-world`, with member contributions and a passive clanker. The host-managed `lobby` remains separate.

## Clanker

Set `FIREWORKS_API_KEY` to enable the real room clanker. It uses `accounts/fireworks/models/deepseek-v4p1-flash` by default; override that with `FIREWORKS_MODEL`. Lightweight clanker classification, currently anonymous lobby moderation, defaults to `accounts/fireworks/models/glm-5p3-flash` with schema-constrained verdicts and can be overridden independently with `FIREWORKS_CLASSIFIER_MODEL`. Clanker requests are serialized per room and include the latest 30 non-system transcript messages.

Each clanker run has a 15-minute total budget, individual provider waits are capped at five minutes, and a run may use up to 64 model turns. Fast transient network, rate-limit, and server failures retry within those bounds. The final two minutes are reserved by aborting an overlong earlier completion if necessary, then explicitly directing the model to recover partial writes, finish, commit, and create a preview. At four remaining turns it receives the same finalization instruction. Current provider activity appears concisely in the persistent chat status strip; terminal failures distinguish `provider timed out` from `15m run limit reached · work preserved` in the right-hand live log. A concrete implementation request cannot resolve as silence before a commit or one explicit blocker; the host forces one continuation and then surfaces an error if the model still stops without either.

Each room has an isolated Git repository under `.data/rooms/<room>/repo`. The clanker can operate across the complete working tree through bounded file and predefined Git tools, but receives no shell access and cannot inspect `.git` internals. Localized edits use unique exact-match `patch_file` operations; `git_restore_file` can safely recover one tracked path from the branch `HEAD` after a mistaken uncommitted edit. Full-file writes remain available for intentional replacements. Working-tree files are capped at 512 KiB each and 5 MiB total.

The canonical service is selected by the isolated origin `https://<room>.serverside.chat`; everything in its path belongs to its generic request handler. The corresponding development chat is `https://serverside.chat/room/<room>`. Human-facing deployment shorthand is `room`/`room#stable` for canonical, `room#head` for repository HEAD, and `room#commit` for a preview. Hyperlinks encode the selector using the host-reserved `__ref` query because fragments never reach HTTP servers. The repository's movable `stable` Git tag mirrors the activated commit. Promoting a preview requires an explicit human request in chat.

The host-side disposition of the initial adversarial room review is recorded in [`docs/pentest-review.md`](docs/pentest-review.md), separating platform findings from application-author hazards and intentional preview behavior.

Every canonical promotion is also recorded as a host-generated `trunk` system message in room chat with its commit and canonical URL.

Canonical history is strictly linear: promotion must be a fast-forward from `stable`, and the candidate range cannot contain merge commits. Feature branches must rebase onto `stable`; the clanker has no merge operation.

Every valid abbreviated or full commit hash in the room repository is lazily servable with `?__ref=<commit>`; it does not need a registered preview. Registered previews add a durable description and a row in the top deployment bar. The clanker can archive a feature preview to remove that row without deleting its commit or direct URL. On rebase conflicts, the clanker can inspect and edit conflicted files, continue until resolved, and then posts the resulting preview to chat for human feedback.

Depending on room policy, the clanker passively observes authenticated contributor chat, responds only to `/clanker`, or is disabled. Anonymous text never enters a normal-room transcript or clanker context. The sole exception is the system lobby: anonymous messages are capped at 600 bytes, limited to 3 per identity per minute and 12 per hour plus global ceilings, and must receive a schema-constrained `ALLOW` verdict from a separate clanker moderation call before persistence or guide visibility. Moderation errors fail closed and enter the host log. Normal-room prompts live in [`prompts/clanker/`](prompts/clanker/). The separate [`prompts/lobby-clanker/`](prompts/lobby-clanker/) guide has no code or deployment tools and only answers questions about using the product; its admission filter lives in [`prompts/lobby-moderator/`](prompts/lobby-moderator/). Routine thinking and tool activity appear in the status UI instead of generating chat messages.

## Security boundary (prototype)

The internal user ID is the authority-bearing account. Google/GitHub subjects, browser session cookies, and SSH public keys are credentials that resolve to it; handles are display labels only. SSH accepts only a valid public-key signature, and a new key must be linked from a signed-in browser before it gains account authority. Visibility, contribution, clanker access, administration, and canonical promotion are checked host-side.
